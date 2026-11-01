import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import SevenZip from "node-7z";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./getVortexPath", () => ({ default: () => "/migration-fixture" }));

import { withArchiveMutation } from "../extensions/download_management/util/archiveOwnership";
import { onStartInstallDownload } from "../extensions/mod_management/eventHandlers";
import type InstallManager from "../extensions/mod_management/InstallManager";
import { IPCDownloadAdapter } from "../IPCDownloadAdapter";
import { appReducer } from "../reducers/app";
import { downloadsReducer } from "../reducers/downloads";
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
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.api = previousApi;
  resetHarnessRegistries();
  await rm(directory, { recursive: true, force: true });
});

function setup() {
  const h = makeApiHarness({}, [
    { path: ["app"], reducer: appReducer },
    { path: ["persistent", "downloads"], reducer: downloadsReducer },
  ]);
  h.setState((state) => {
    state.settings.downloads.path = path.join(directory, "downloads");
    state.settings.automation = {
      ...state.settings.automation,
      enable: false,
      deploy: false,
      install: false,
    };
    state.app.appVersion = "2.1.0-beta.4";
    state.app.migrations = [];
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
      size: bytes.length,
      received: bytes.length,
      verified: bytes.length,
      urls: ["https://fixture.invalid/selected.zip"],
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

async function missing(kind: "matching" | "different" | "unknown" | "absent" | "dangling") {
  const h = setup();
  const source = archivePath(h, domain);
  const bytes = await zip(source, "selected-domain-archive");
  const destination = archivePath(h, internal);
  await mkdir(path.dirname(destination), { recursive: true });
  let other: Buffer | undefined;
  if (kind === "matching") await writeFile(destination, bytes);
  if (kind === "different" || kind === "unknown") other = await zip(destination, "unrelated");
  if (kind === "dangling") await symlink("absent.zip", destination);
  await rm(source);
  addDownload(h, "selected", bytes);
  if (kind === "unknown")
    h.setState((state) => {
      state.persistent.downloads.files.selected.fileMD5 = undefined;
    });
  expect((await retain(migrate(h.api.store, "2.1.0-beta.4"))).error).toBeUndefined();
  await drain();
  return { h, bytes, destination, other };
}

describe("missing migration archives", () => {
  it("installs an already moved archive only with its recorded identity", async () => {
    const { h, bytes, destination } = await missing("matching");
    await install(h, "selected", bytes);
    await settled(4);
    expect(h.getState().persistent.downloads.files.selected.state).toBe("finished");
    expect(await readFile(destination)).toEqual(bytes);
    expect(h.getState().app.migrations).toContain("moveDomainFolders_2_1");
  });

  it.each(["different", "unknown", "absent", "dangling"] as const)(
    "refuses unproved %s bytes without claiming an occupied archive",
    async (kind) => {
      const { h, bytes, destination, other } = await missing(kind);
      const row = h.getState().persistent.downloads.files.selected;
      expect(row).toMatchObject({ state: "paused", received: 0, game: [internal, domain] });
      expect(row.size).toBe(bytes.length);
      const selected = archivePath(h, internal, row.localPath);
      await expect(lstat(selected)).rejects.toMatchObject({ code: "ENOENT" });
      const callback = vi.fn();
      const install = vi.fn();
      expect(
        (
          await retain(
            onStartInstallDownload(h.api, { install } as never, "selected", {}, callback),
          )
        ).error,
      ).toBeUndefined();
      await settled(kind === "different" || kind === "unknown" ? 4 : 3);
      expect(install).not.toHaveBeenCalled();
      expect(callback).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: expect.stringContaining("not finished") }),
        undefined,
      );
      if (other !== undefined) await expect(readFile(destination)).resolves.toEqual(other);
      if (kind === "dangling") expect((await lstat(destination)).isSymbolicLink()).toBe(true);
      expect(h.getState().app.migrations).toContain("moveDomainFolders_2_1");
    },
  );

  it.each(["different", "unknown"] as const)(
    "preserves %s destination through public removal and retry",
    async (kind) => {
      for (const action of ["remove", "retry"] as const) {
        const { h, bytes, destination, other } = await missing(kind);
        const row = h.getState().persistent.downloads.files.selected;
        const target = archivePath(h, internal, row.localPath);
        const starts: string[] = [];
        vi.useFakeTimers({ toFake: ["setTimeout"] });
        window.api = {
          ...window.api,
          downloader: {
            ...window.api.downloader,
            onResolve: vi.fn(),
            start: vi.fn(async (dest: string) => {
              starts.push(dest);
              await writeFile(dest, bytes, { flag: "wx" });
              return { downloadId: "selected" };
            }),
            cancel: vi.fn(async () => {}),
          },
        };
        const adapter = new IPCDownloadAdapter(h.api);
        expect(adapter).toBeDefined();
        const callback = vi.fn();
        if (action === "retry") {
          const resumed = new Promise<void>((resolve) => {
            h.api.events.emit("resume-download", "selected", (error, id) => {
              callback(error, id);
              resolve();
            });
          });
          await retain(resumed);
          await withArchiveMutation(h.api, async () => {});
          await drain();
          expect(callback).toHaveBeenCalledExactlyOnceWith(null, "selected");
          expect(starts).toEqual([target]);
          expect(await readFile(target)).toEqual(bytes);
        }
        const removed = vi.fn();
        const removal = new Promise<void>((resolve) => {
          h.api.events.emit("remove-download", "selected", (error) => {
            removed(error);
            resolve();
          });
        });
        await retain(removal);
        await withArchiveMutation(h.api, async () => {});
        await drain();
        expect(removed).toHaveBeenCalledExactlyOnceWith(null);
        expect(h.getState().persistent.downloads.files.selected).toBeUndefined();
        const retainedBytes = await readFile(destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        expect.soft(retainedBytes).toEqual(other);
        await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
        expect(window.api.downloader.start).toHaveBeenCalledTimes(action === "retry" ? 1 : 0);
        expect(window.api.downloader.cancel).toHaveBeenCalledTimes(action === "retry" ? 1 : 0);
        await settled(action === "retry" ? 9 : 4);
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("checks each missing shared row against its own recorded identity", async () => {
    const h = setup();
    const bytes = await zip(archivePath(h, internal), "selected-domain-archive");
    addDownload(h, "matching", bytes);
    addDownload(h, "unproved", Buffer.from("other archive"));
    expect((await retain(migrate(h.api.store, "2.1.0-beta.4"))).error).toBeUndefined();
    await settled(2);
    await install(h, "matching", bytes);
    await settled(4);
    expect(h.getState().persistent.downloads.files.unproved).toMatchObject({
      state: "paused",
      received: 0,
    });
    expect(h.getState().persistent.downloads.files.unproved.localPath).not.toBe("mod.zip");
    expect(await readFile(archivePath(h, internal))).toEqual(bytes);
  });

  it("propagates a native identity-read denial without marking migration complete", async () => {
    const h = setup();
    const destination = archivePath(h, internal);
    const bytes = await zip(destination, "selected-domain-archive");
    addDownload(h, "selected", bytes);
    permissions.set(destination, 0o600);
    await chmod(destination, 0);
    vi.mocked(window.api.dialog.showMessageBox).mockResolvedValue({
      response: 1,
      checkboxChecked: false,
    });
    const result = await retain(migrate(h.api.store, "2.1.0-beta.4"));
    await settled(2);
    expect(result.error).toMatchObject({ code: "EACCES" });
    expect(h.getState().app.migrations).not.toContain("moveDomainFolders_2_1");
    expect(h.getState().persistent.downloads.files.selected.localPath).toBe("mod.zip");
    await chmod(destination, 0o600);
    expect(await readFile(destination)).toEqual(bytes);
  });
});
