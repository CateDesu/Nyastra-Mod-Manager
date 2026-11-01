import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import SevenZip from "node-7z";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./getVortexPath", () => ({ default: () => "/migration-fixture" }));

import { onStartInstallDownload } from "../extensions/mod_management/eventHandlers";
import type InstallManager from "../extensions/mod_management/InstallManager";
import { appReducer } from "../reducers/app";
import { makeApiHarness, makeDownload, resetHarnessRegistries } from "../test-utils/builders";
import migrate from "./migrate";

const domain = "skyrimspecialedition";
const internal = "skyrimse";
let directory: string;
let operations: Promise<unknown>[];
let continuations: number[];
let permissions: Map<string, number>;
let previousApi: typeof window.api;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "migration-archive-"));
  operations = [];
  continuations = [];
  permissions = new Map();
  previousApi = window.api;
  window.api = { ...previousApi, dialog: { ...previousApi.dialog, showMessageBox: vi.fn() } };
});

function retain<T>(original: PromiseLike<T>) {
  const slot = continuations.length;
  continuations.push(0);
  const operation = Promise.resolve(original);
  operations.push(operation);
  const outcome = operation.then(
    (value) => {
      continuations[slot]++;
      return { value, error: undefined };
    },
    (error: unknown) => {
      continuations[slot]++;
      return { value: undefined, error };
    },
  );
  operations.push(outcome);
  return outcome;
}

async function drain() {
  let count = -1;
  while (count !== operations.length) {
    count = operations.length;
    await Promise.allSettled(operations);
  }
}

async function settled(count: number) {
  await drain();
  expect(continuations).toEqual(Array.from({ length: count }, () => 1));
}

afterEach(async () => {
  await drain();
  for (const [filename, mode] of permissions) {
    await chmod(filename, mode).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  vi.restoreAllMocks();
  window.api = previousApi;
  resetHarnessRegistries();
  await rm(directory, { recursive: true, force: true });
});

function setup() {
  const h = makeApiHarness({}, [{ path: ["app"], reducer: appReducer }]);
  h.setState((state) => {
    state.settings.downloads.path = path.join(directory, "downloads");
    state.settings.automation = {
      ...state.settings.automation,
      enable: false,
      deploy: false,
      install: false,
    };
    state.app.appVersion = "2.0.0";
    state.app.migrations = ["healStoragePathNames_2_4"];
    state.session.gameMode.known = [
      {
        id: internal,
        name: "Fixture",
        details: { nexusPageId: domain },
        requiredFiles: [],
        executable: "fixture",
      },
    ];
    state.settings.profiles.activeProfileId = "fixture";
    state.persistent.profiles.fixture = {
      id: "fixture",
      name: "Fixture",
      gameId: internal,
      modState: {},
      lastActivated: 0,
    };
  });
  return h;
}

function archivePath(h: ReturnType<typeof setup>, game: string, name = "mod.zip") {
  return path.join(h.getState().settings.downloads.path, game, name);
}

async function zip(filename: string, payload: string) {
  const source = await mkdtemp(path.join(directory, "zip-source-"));
  await writeFile(path.join(source, "selection.txt"), payload);
  await mkdir(path.dirname(filename), { recursive: true });
  expect(
    (await retain(new SevenZip().add(filename, [path.join(source, "selection.txt")], {}))).error,
  ).toBeUndefined();
  return readFile(filename);
}

function addDownload(
  h: ReturnType<typeof setup>,
  id: string,
  bytes: Buffer,
  localPath = "mod.zip",
) {
  h.setState((state) => {
    state.persistent.downloads.files[id] = makeDownload({
      id,
      state: "finished",
      localPath,
      game: [domain],
      fileMD5: createHash("md5").update(bytes).digest("hex"),
    });
  });
}

async function install(h: ReturnType<typeof setup>, id: string, bytes: Buffer) {
  const calls: Parameters<InstallManager["install"]>[] = [];
  const callback = vi.fn();
  const extracted = path.join(directory, "installed-" + id);
  let extraction: Promise<unknown> | undefined;
  const manager = {
    install: (...args: Parameters<InstallManager["install"]>) => {
      calls.push(args);
      extraction = retain(new SevenZip().extractFull(args[1], extracted, {})).then((result) => {
        if (result.error) throw result.error;
        args[7](null, "installed-" + id);
      });
      operations.push(extraction);
    },
  };
  const result = await retain(onStartInstallDownload(h.api, manager as never, id, {}, callback));
  if (extraction !== undefined) await extraction;
  await drain();
  expect(result.error).toBeUndefined();
  expect(callback).toHaveBeenCalledExactlyOnceWith(null, "installed-" + id);
  expect(calls).toHaveLength(1);
  expect(await readFile(calls[0][1])).toEqual(bytes);
  expect(await readFile(path.join(extracted, "selection.txt"), "utf8")).toBe(
    "selected-domain-archive",
  );
  const current = h.getState().persistent.downloads.files[id];
  expect(current.game).toEqual([internal, domain]);
  expect(current.fileMD5).toBe(createHash("md5").update(bytes).digest("hex"));
  expect(h.errorNotifications).toEqual([]);
}

describe("domain migration archive identity", () => {
  it.each([0, 1, 3])(
    "installs the selected bytes with %s occupied destination names",
    async (occupied) => {
      const h = setup();
      const from = archivePath(h, domain);
      const bytes = await zip(from, "selected-domain-archive");
      const unrelated = new Map<string, Buffer>();
      for (let index = 0; index < occupied; index++) {
        const filename = archivePath(h, internal, index === 0 ? "mod.zip" : `mod.${index}.zip`);
        unrelated.set(filename, await zip(filename, "unrelated-" + index));
      }
      addDownload(h, "selected", bytes);
      expect((await retain(migrate(h.api.store, "2.0.0"))).error).toBeUndefined();
      await settled(occupied + 2);
      await install(h, "selected", bytes);
      await settled(occupied + 4);
      for (const [filename, contents] of unrelated)
        expect(await readFile(filename)).toEqual(contents);
      const current = h.getState().persistent.downloads.files.selected;
      expect(current.localPath).toBe(occupied === 0 ? "mod.zip" : `mod.${occupied}.zip`);
      if (occupied > 0) expect(await readFile(from)).toEqual(bytes);
      else await expect(stat(from)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("does not overwrite a dangling alternate symlink", async () => {
    const h = setup();
    const from = archivePath(h, domain);
    const bytes = await zip(from, "selected-domain-archive");
    const destination = archivePath(h, internal);
    const other = await zip(destination, "unrelated");
    const link = archivePath(h, internal, "mod.1.zip");
    await symlink("absent.zip", link);
    addDownload(h, "selected", bytes);
    expect((await retain(migrate(h.api.store, "2.0.0"))).error).toBeUndefined();
    await install(h, "selected", bytes);
    await settled(5);
    expect(h.getState().persistent.downloads.files.selected.localPath).toBe("mod.2.zip");
    expect(await readFile(destination)).toEqual(other);
    expect(await import("node:fs/promises").then((fs) => fs.readlink(link))).toBe("absent.zip");
  });

  it("preserves a dangling destination symlink during the orphan sweep", async () => {
    const h = setup();
    const source = archivePath(h, domain);
    const bytes = await zip(source, "selected-domain-archive");
    const destination = archivePath(h, internal);
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink("absent.zip", destination);
    addDownload(h, "selected", bytes);
    expect((await retain(migrate(h.api.store, "2.0.0"))).error).toBeUndefined();
    await install(h, "selected", bytes);
    await settled(4);
    expect((await lstat(destination)).isSymbolicLink()).toBe(true);
    expect(await readFile(source)).toEqual(bytes);
  });

  it.each([false, true])(
    "retains both shared records through a collision, relative alias=%s",
    async (alias) => {
      const h = setup();
      const source = archivePath(h, domain);
      const bytes = await zip(source, "selected-domain-archive");
      const other = await zip(archivePath(h, internal), "unrelated");
      if (alias) await symlink("mod.zip", archivePath(h, domain, "alias.zip"));
      addDownload(h, "first", bytes);
      addDownload(h, "second", bytes, alias ? "alias.zip" : "mod.zip");
      expect((await retain(migrate(h.api.store, "2.0.0"))).error).toBeUndefined();
      await install(h, "first", bytes);
      await install(h, "second", bytes);
      await settled(7);
      if (!alias)
        expect(h.getState().persistent.downloads.files.first.localPath).toBe(
          h.getState().persistent.downloads.files.second.localPath,
        );
      expect(await readFile(archivePath(h, internal))).toEqual(other);
      expect(await readFile(source)).toEqual(bytes);
    },
  );

  it("copies relative aliases before removing their noncolliding target", async () => {
    const h = setup();
    const source = archivePath(h, domain);
    const bytes = await zip(source, "selected-domain-archive");
    await symlink("mod.zip", archivePath(h, domain, "alias.zip"));
    addDownload(h, "first", bytes);
    addDownload(h, "second", bytes, "alias.zip");
    expect((await retain(migrate(h.api.store, "2.0.0"))).error).toBeUndefined();
    await install(h, "first", bytes);
    await install(h, "second", bytes);
    await settled(6);
    await expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([true, false])(
    "keeps optional missing-source normalization with destination=%s",
    async (exists) => {
      const h = setup();
      const bytes = exists
        ? await zip(archivePath(h, internal), "selected-domain-archive")
        : Buffer.from("not-downloaded");
      addDownload(h, "selected", bytes);
      expect((await retain(migrate(h.api.store, "2.0.0"))).error).toBeUndefined();
      if (exists) await install(h, "selected", bytes);
      await settled(exists ? 4 : 1);
      expect(h.getState().persistent.downloads.files.selected).toMatchObject({
        game: [internal, domain],
        localPath: "mod.zip",
      });
      expect(h.getState().app.migrations).toContain("moveDomainFolders_2_1");
    },
  );

  it.each([false, true])(
    "preserves completed row progress and a later source error, denied=%s",
    async (denied) => {
      const h = setup();
      const first = await zip(archivePath(h, domain), "selected-domain-archive");
      const other = await zip(archivePath(h, internal), "unrelated");
      const failingSource = archivePath(h, domain, "later.zip");
      const later = await zip(failingSource, "selected-domain-archive");
      addDownload(h, "first", first);
      addDownload(h, "later", later, "later.zip");
      if (denied) {
        permissions.set(failingSource, 0o600);
        await chmod(failingSource, 0);
      }
      vi.mocked(window.api.dialog.showMessageBox).mockResolvedValue({
        response: 1,
        checkboxChecked: false,
      });
      const result = await retain(migrate(h.api.store, "2.0.0"));
      await settled(4);
      if (denied) {
        expect(result.error).toMatchObject({ code: "EACCES", syscall: "copyfile" });
        expect(h.getState().app.migrations).not.toContain("moveDomainFolders_2_1");
        expect(h.getState().persistent.downloads.files.later).toMatchObject({
          game: [domain],
          localPath: "later.zip",
        });
        expect(window.api.dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ title: "Migration failed" }),
        );
        await chmod(failingSource, 0o600);
        expect(await readFile(failingSource)).toEqual(later);
      } else {
        expect(result.error).toBeUndefined();
        expect(h.getState().app.migrations).toContain("moveDomainFolders_2_1");
        await install(h, "later", later);
      }
      await install(h, "first", first);
      await settled(denied ? 6 : 8);
      expect(await readFile(archivePath(h, internal))).toEqual(other);
    },
  );

  it("preserves both inputs on native destination denial", async () => {
    const h = setup();
    const from = archivePath(h, domain);
    const bytes = await zip(from, "selected-domain-archive");
    const to = path.dirname(archivePath(h, internal));
    await mkdir(to, { recursive: true });
    permissions.set(to, 0o700);
    await chmod(to, 0o555);
    addDownload(h, "selected", bytes);
    vi.mocked(window.api.dialog.showMessageBox).mockResolvedValue({
      response: 1,
      checkboxChecked: false,
    });
    const result = await retain(migrate(h.api.store, "2.0.0"));
    await settled(2);
    expect(result.error).toMatchObject({ code: "EACCES", syscall: "copyfile" });
    expect(await readFile(from)).toEqual(bytes);
    expect(await readdir(to)).toEqual([]);
    expect(h.getState().persistent.downloads.files.selected.game).toEqual([domain]);
    expect(h.getState().app.migrations).not.toContain("moveDomainFolders_2_1");
  });
});
