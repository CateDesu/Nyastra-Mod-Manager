import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import PromiseBB from "bluebird";
import Zip from "node-7z";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeApiHarness, makeDownload, makeMod, makeProfile } from "../../test-utils/builders";
import type { IExtensionContext } from "../../types/IExtensionContext";
import * as fs from "../../util/fs";
import { setDownloadHashByFile } from "./actions/state";
import init from "./index";
import type { IDownload } from "./types/IDownload";
import { finalizeDownload } from "./util/postprocessDownload";

vi.mock("./views/DownloadView", () => ({ default: () => null }));
vi.mock("./views/Settings", () => ({ default: () => null }));
vi.mock("./views/ShutdownButton", () => ({ default: () => null }));
vi.mock("./views/SpeedOMeter", () => ({ default: () => null }));
vi.mock("./downloadAttributes", () => ({ default: () => [] }));
vi.mock("./util/downloadDirectory", () => ({
  ensureDownloadsDirectory: () => PromiseBB.resolve(),
}));
vi.mock("./util/queryDLInfo", () => ({ default: () => PromiseBB.resolve() }));

const GAME = "game-a";
const OTHER_GAME = "game-b";
let root: string;
let onChange: (event: string, fileName: string) => void;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "vortex-download-ownership-"));
  await Promise.all([GAME, OTHER_GAME].map((game) => mkdir(path.join(root, game))));
  vi.spyOn(fs, "watch").mockImplementation(((...args: unknown[]) => {
    onChange = args.at(-1) as typeof onChange;
    return { close: vi.fn(), on: vi.fn() } as unknown as fs.FSWatcher;
  }) as typeof fs.watch);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function download(id: string, game: string, fileName: string, received = 8): IDownload {
  return makeDownload({
    id,
    game: [game],
    state: "finished",
    localPath: fileName,
    received,
    size: 8,
    fileMD5: "test-md5",
    modInfo: { source: "test" },
  });
}

function setup(downloads: Record<string, IDownload>, downloadRoot = root) {
  const profile = makeProfile({ id: "profile-a", gameId: GAME });
  const otherProfile = makeProfile({ id: "profile-b", gameId: OTHER_GAME });
  const harness = makeApiHarness({
    downloads,
    profiles: { [profile.id]: profile, [otherProfile.id]: otherProfile },
    activeProfileId: profile.id,
  });
  harness.setState((state) => {
    state.settings.downloads.path = downloadRoot;
    state.session.base = { commandLine: {} } as typeof state.session.base;
  });
  harness.api.registerProtocol = vi.fn();
  harness.api.deregisterProtocol = vi.fn();
  harness.api.lookupModMeta = vi.fn().mockResolvedValue([]);
  const once: Array<() => void> = [];
  const context = {
    api: harness.api,
    once: (callback: () => void) => once.push(callback),
    registerReducer: vi.fn(),
    registerMainPage: vi.fn(),
    registerSettings: vi.fn(),
    registerFooter: vi.fn(),
    registerAction: vi.fn(),
    registerAttributeExtractor: vi.fn(),
    registerActionCheck: vi.fn(),
    registerTest: vi.fn(),
  } as unknown as IExtensionContext;
  expect(init(context)).toBe(true);
  once.forEach((callback) => callback());
  const refresh = () =>
    new Promise<void>((resolve, reject) => {
      harness.api.events.emit("refresh-downloads", GAME, (error: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  return { ...harness, refresh };
}

describe("download filesystem ownership", () => {
  for (const sourceKind of ["regular", "absolute-link", "relative-link"] as const) {
    it(`imports the bytes of a valid ${sourceKind} archive through staging`, async () => {
      const shared = path.join(root, "shared");
      const incoming = path.join(root, "incoming");
      await Promise.all([mkdir(shared), mkdir(incoming)]);
      const payload = path.join(shared, "payload.txt");
      await writeFile(payload, "symlink archive payload");
      const archive = path.join(shared, "payload.zip");
      await new Zip().add(archive, [payload]);
      const bytes = await readFile(archive);
      const source = path.join(incoming, "mod.zip");
      if (sourceKind === "regular") await fs.copyAsync(archive, source);
      else
        await symlink(sourceKind === "absolute-link" ? archive : "../shared/payload.zip", source);
      expect(await readFile(source)).toEqual(bytes);
      if (sourceKind === "relative-link") {
        const control = path.join(root, GAME, "control.zip");
        await fs.copyAsync(source, control);
        expect(await readFile(control)).toEqual(bytes);
        await rm(control);
      }
      const harness = setup({});
      const callback = vi.fn();
      const ids = await new Promise<string[]>((resolve) => {
        harness.api.events.emit(
          "import-downloads",
          [source],
          (result: string[]) => {
            callback(result);
            resolve(result);
          },
          true,
        );
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(ids).toHaveLength(1);
      const files = harness.getState().persistent.downloads.files;
      expect(Object.keys(files)).toEqual(ids);
      expect(files[ids[0]]).toMatchObject({
        game: [GAME],
        localPath: "mod.zip",
        state: "finished",
        size: bytes.length,
      });
      const destination = path.join(root, GAME, files[ids[0]].localPath);
      expect(await readFile(destination)).toEqual(bytes);
      expect(await readFile(source)).toEqual(bytes);
      const extracted = path.join(root, "extracted");
      await new Zip().extractFull(destination, extracted);
      expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe(
        "symlink archive payload",
      );
      expect(await readdir(path.dirname(destination))).toEqual(["mod.zip"]);
      expect(harness.errorNotifications).toEqual([]);
    });
  }

  for (const casing of ["exact", "Wine", "native"]) {
    it(`preserves source path casing behavior for ${casing} imports`, async () => {
      const directory =
        casing === "native"
          ? path.join(root, "Incoming")
          : path.join(root, "compatdata/42/pfx/drive_c/Incoming");
      await mkdir(directory, { recursive: true });
      const source = path.join(directory, "existing.zip");
      const payload = path.join(root, "payload.txt");
      await writeFile(payload, "Wine archive payload");
      await new Zip().add(source, [payload]);
      const bytes = await readFile(source);
      const requested = casing === "exact" ? source : source.replace("/Incoming/", "/incoming/");
      if (casing !== "exact")
        await expect(stat(requested)).rejects.toMatchObject({ code: "ENOENT" });
      if (casing !== "native") expect((await fs.statAsync(requested)).size).toBe(bytes.length);
      const harness = setup({});

      const ids = await new Promise<string[]>((resolve) => {
        harness.api.events.emit("import-downloads", [requested], resolve, true);
      });

      expect(await readFile(source)).toEqual(bytes);
      if (casing === "native") {
        expect(ids).toEqual([]);
        expect(harness.getState().persistent.downloads.files).toEqual({});
      } else {
        expect(ids).toHaveLength(1);
        expect(await readFile(path.join(root, GAME, "existing.zip"))).toEqual(bytes);
        expect(harness.getState().persistent.downloads.files[ids[0]]).toMatchObject({
          game: [GAME],
          localPath: "existing.zip",
          state: "finished",
          size: bytes.length,
        });
        expect(harness.errorNotifications).toEqual([]);
      }
    });
  }

  it("keeps archive associations when the download path uses different Wine casing", async () => {
    const actualRoot = path.join(root, "compatdata/42/pfx/drive_c/Archives");
    const configuredRoot = actualRoot.replace("/Archives", "/archives");
    await mkdir(path.join(actualRoot, GAME), { recursive: true });
    const source = path.join(actualRoot, GAME, "existing.zip");
    const payload = path.join(root, "payload.txt");
    await writeFile(payload, "preserved archive bytes");
    await new Zip().add(source, [payload]);
    const bytes = await readFile(source);
    const requested = path.join(configuredRoot, GAME, "existing.zip");
    await expect(stat(requested)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.statAsync(requested)).size).toBe(bytes.length);
    const existing = download("existing", GAME, "existing.zip", bytes.length);
    const harness = setup({ existing }, configuredRoot);
    harness.setState((state) => {
      state.persistent.mods[GAME] = {
        installed: makeMod({ id: "installed", archiveId: "existing" }),
      };
    });
    harness.setNextDialog({ action: "Replace", input: {} });
    const dialog = vi.spyOn(harness.api, "showDialog");

    const ids = await new Promise<string[]>((resolve) => {
      harness.api.events.emit("import-downloads", [source], resolve, true);
    });

    expect(ids).toEqual(["existing"]);
    expect(dialog).not.toHaveBeenCalled();
    const files = harness.getState().persistent.downloads.files;
    expect(files).toEqual({ existing });
    expect(files[harness.getState().persistent.mods[GAME].installed.archiveId]).toEqual(existing);
    expect(await readFile(source)).toEqual(bytes);
  });

  for (const registered of [false, true]) {
    it(`uses the physical Wine archive basename with registered=${registered}`, async () => {
      const downloadRoot = path.join(root, "pfx/drive_c/Archives");
      await mkdir(path.join(downloadRoot, GAME), { recursive: true });
      const archive = path.join(downloadRoot, GAME, "existing.zip");
      const requested = path.join(downloadRoot, GAME, "EXISTING.ZIP");
      const payload = path.join(root, "payload.txt");
      await writeFile(payload, "canonical archive payload");
      await new Zip().add(archive, [payload]);
      const bytes = await readFile(archive);
      await expect(stat(requested)).rejects.toMatchObject({ code: "ENOENT" });
      const existing = {
        ...download("existing", GAME, "existing.zip", bytes.length),
        size: bytes.length,
      };
      const harness = setup(registered ? { existing } : {}, downloadRoot);
      if (registered) {
        harness.setState((state) => {
          state.persistent.mods[GAME] = {
            installed: makeMod({ id: "installed", archiveId: "existing" }),
          };
        });
      }
      const dialog = vi.spyOn(harness.api, "showDialog");

      const ids = await new Promise<string[]>((resolve) => {
        harness.api.events.emit("import-downloads", [requested], resolve, true);
      });

      expect(ids).toHaveLength(1);
      expect(dialog).not.toHaveBeenCalled();
      const files = harness.getState().persistent.downloads.files;
      expect(Object.keys(files)).toEqual(ids);
      expect(files[ids[0]]).toMatchObject({
        game: [GAME],
        localPath: "existing.zip",
        state: "finished",
        size: bytes.length,
      });
      if (registered) {
        expect(ids).toEqual(["existing"]);
        expect(files).toEqual({ existing });
        expect(harness.getState().persistent.mods[GAME].installed.archiveId).toBe("existing");
      }
      expect(await readFile(archive)).toEqual(bytes);
      const extracted = path.join(root, "extracted");
      await new Zip().extractFull(
        path.join(downloadRoot, GAME, files[ids[0]].localPath),
        extracted,
      );
      expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe(
        "canonical archive payload",
      );
      expect(harness.errorNotifications).toEqual([]);
    });
  }

  for (const alias of ["direct", "symlink", "hardlink"]) {
    for (const registered of [false, true]) {
      it(`reuses an archive imported from itself with ${alias} and registered=${registered}`, async () => {
        const payload = path.join(root, "payload.txt");
        await writeFile(payload, "the only archive payload");
        const destination = path.join(root, GAME, "existing.zip");
        await new Zip().add(destination, [payload]);
        const originalBytes = await readFile(destination);
        let source = destination;
        if (alias === "symlink") {
          await symlink(path.join(root, GAME), path.join(root, "alias"), "dir");
          source = path.join(root, "alias", "existing.zip");
        } else if (alias === "hardlink") {
          await mkdir(path.join(root, "alias"));
          source = path.join(root, "alias", "existing.zip");
          await link(destination, source);
        }
        const original = download("existing", GAME, "existing.zip", originalBytes.length);
        const harness = setup(registered ? { existing: original } : {});
        harness.setNextDialog({ action: "Replace", input: {} });
        const dialog = vi.spyOn(harness.api, "showDialog");

        const ids = await new Promise<string[]>((resolve) => {
          harness.api.events.emit("import-downloads", [source], resolve, true);
        });

        expect(await readFile(destination)).toEqual(originalBytes);
        expect(await readFile(source)).toEqual(originalBytes);
        expect(dialog).not.toHaveBeenCalled();
        expect(ids).toHaveLength(1);
        if (registered) {
          expect(ids).toEqual(["existing"]);
          expect(harness.getState().persistent.downloads.files.existing).toEqual(original);
        } else {
          expect(harness.getState().persistent.downloads.files[ids[0]]).toMatchObject({
            game: [GAME],
            localPath: "existing.zip",
            state: "finished",
            size: originalBytes.length,
          });
        }
        const extracted = path.join(root, "extracted");
        await new Zip().extractFull(destination, extracted);
        expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe(
          "the only archive payload",
        );
      });
    }
  }

  it("settles an import with no active game without copying files", async () => {
    const source = path.join(root, "incoming.zip");
    await writeFile(source, "unassigned archive");
    const harness = setup({});
    harness.setState((state) => {
      state.settings.profiles.activeProfileId = undefined;
    });
    const completed = vi.fn();

    harness.api.events.emit("import-downloads", [source], completed, true);

    await vi.waitFor(() => expect(completed).toHaveBeenCalledExactlyOnceWith([]));
    expect(harness.getState().persistent.downloads.files).toEqual({});
    expect(await readFile(source, "utf8")).toBe("unassigned archive");
    expect(await readdir(path.join(root, GAME))).toEqual([]);
  });

  it("imports a fresh directory using the native archive writer", async () => {
    const source = path.join(root, "fresh-directory");
    await mkdir(source);
    await writeFile(path.join(source, "new.txt"), "current directory payload");
    const harness = setup({});

    const ids = await new Promise<string[]>((resolve) => {
      harness.api.events.emit("import-downloads", [source], resolve, true);
    });

    const extracted = path.join(root, "extracted");
    await new Zip().extractFull(path.join(root, GAME, "fresh-directory.7z"), extracted);
    expect(await readdir(extracted)).toEqual(["new.txt"]);
    expect(await readFile(path.join(extracted, "new.txt"), "utf8")).toBe(
      "current directory payload",
    );
    expect(ids).toHaveLength(1);
    expect(harness.getState().persistent.downloads.files[ids[0]]).toMatchObject({
      game: [GAME],
      localPath: "fresh-directory.7z",
    });
  });

  for (const action of ["Cancel", "Replace"]) {
    it(`honors ${action} for a directory archive collision`, async () => {
      const source = path.join(root, "incoming-directory");
      const oldSource = path.join(root, "old-source");
      await Promise.all([mkdir(source), mkdir(oldSource)]);
      await writeFile(path.join(source, "new.txt"), "current directory payload");
      await writeFile(path.join(oldSource, "stale.txt"), "previous directory payload");
      const destination = path.join(root, GAME, "incoming-directory.7z");
      await new Zip().add(destination, [path.join(oldSource, "stale.txt")]);
      const originalBytes = await readFile(destination);
      await writeFile(path.join(root, OTHER_GAME, "incoming-directory.7z"), "other archive");
      const original = download("original", GAME, "incoming-directory.7z");
      const other = download("other", OTHER_GAME, "incoming-directory.7z");
      const harness = setup({ original, other });
      harness.setNextDialog({ action, input: {} });

      const ids = await new Promise<string[]>((resolve) => {
        harness.api.events.emit("import-downloads", [source], resolve, true);
      });

      if (action === "Cancel") {
        expect(await readFile(destination)).toEqual(originalBytes);
        expect(ids).toEqual([]);
        expect(harness.getState().persistent.downloads.files.original).toEqual(original);
      } else {
        const extracted = path.join(root, "extracted");
        await new Zip().extractFull(destination, extracted);
        expect(await readdir(extracted)).toEqual(["new.txt"]);
        expect(await readFile(path.join(extracted, "new.txt"), "utf8")).toBe(
          "current directory payload",
        );
        expect(ids).toHaveLength(1);
        expect(harness.getState().persistent.downloads.files.original).toBeUndefined();
        expect(harness.getState().persistent.downloads.files[ids[0]]).toMatchObject({
          game: [GAME],
          localPath: "incoming-directory.7z",
        });
      }
      expect(harness.getState().persistent.downloads.files.other).toEqual(other);
      expect(await readFile(path.join(root, OTHER_GAME, "incoming-directory.7z"), "utf8")).toBe(
        "other archive",
      );
    });
  }

  it("keeps inactive-game archives with zero received bytes during active-game cleanup", async () => {
    await writeFile(path.join(root, GAME, "active.zip"), "active!!");
    await writeFile(path.join(root, OTHER_GAME, "other.zip"), "other!!!");
    const other = download("other", OTHER_GAME, "other.zip", 0);
    const harness = setup({ active: download("active", GAME, "active.zip"), other });

    await harness.refresh();

    expect(harness.getState().persistent.downloads.files.other).toEqual(other);
    expect(await readFile(path.join(root, OTHER_GAME, "other.zip"), "utf8")).toBe("other!!!");
  });

  it("uses the primary game rather than secondary compatibility during cleanup", async () => {
    await writeFile(path.join(root, GAME, "active.zip"), "active!!");
    await writeFile(path.join(root, OTHER_GAME, "compatible.zip"), "other!!!");
    const other = {
      ...download("other", OTHER_GAME, "compatible.zip", 0),
      game: [OTHER_GAME, GAME],
    };
    const harness = setup({ active: download("active", GAME, "active.zip"), other });

    await harness.refresh();

    expect(harness.getState().persistent.downloads.files.other).toEqual(other);
  });

  it("repairs an active-game record from its own archive", async () => {
    await writeFile(path.join(root, GAME, "active.zip"), "complete archive");
    const harness = setup({ active: download("active", GAME, "active.zip", 0) });

    await harness.refresh();

    expect(harness.getState().persistent.downloads.files.active).toMatchObject({
      received: 16,
      size: 16,
      state: "finished",
    });
  });

  it("keeps incomplete records when the entire download folder is unavailable", async () => {
    const original = download("active", GAME, "active.zip", 0);
    const harness = setup({ active: original });
    await rm(path.join(root, GAME), { recursive: true });

    await harness.refresh();

    expect(harness.getState().persistent.downloads.files.active).toEqual(original);
    expect(harness.errorNotifications).toHaveLength(1);
  });

  it("removes an incomplete record whose file is absent in an available folder", async () => {
    await writeFile(path.join(root, GAME, "present.zip"), "present!");
    const harness = setup({
      missing: download("missing", GAME, "missing.zip", 0),
      present: download("present", GAME, "present.zip"),
    });

    await harness.refresh();

    expect(harness.getState().persistent.downloads.files.missing).toBeUndefined();
    expect(harness.getState().persistent.downloads.files.present).toBeDefined();
  });

  it("refresh removes only the active game's missing archive when basenames match", async () => {
    await writeFile(path.join(root, GAME, "present.zip"), "present!");
    await writeFile(path.join(root, OTHER_GAME, "shared.zip"), "other!!!");
    const other = download("other", OTHER_GAME, "shared.zip");
    const harness = setup({
      active: download("active", GAME, "shared.zip"),
      present: download("present", GAME, "present.zip"),
      other,
    });

    await harness.refresh();

    expect(harness.getState().persistent.downloads.files.active).toBeUndefined();
    expect(harness.getState().persistent.downloads.files.other).toEqual(other);
    expect(await readFile(path.join(root, OTHER_GAME, "shared.zip"), "utf8")).toBe("other!!!");
  });

  it("watcher deletion removes only the watched game's matching basename", async () => {
    await writeFile(path.join(root, GAME, "shared.zip"), "active!!");
    await writeFile(path.join(root, OTHER_GAME, "shared.zip"), "other!!!");
    const other = download("other", OTHER_GAME, "shared.zip");
    const harness = setup({ other, active: download("active", GAME, "shared.zip") });
    await harness.refresh();
    await rm(path.join(root, GAME, "shared.zip"));

    onChange("rename", "shared.zip");

    await vi.waitFor(
      () => {
        expect(harness.getState().persistent.downloads.files.active).toBeUndefined();
      },
      { timeout: 2000 },
    );
    expect(harness.getState().persistent.downloads.files.other).toEqual(other);
    expect(await readFile(path.join(root, OTHER_GAME, "shared.zip"), "utf8")).toBe("other!!!");
  });

  it("watcher addition registers its own game even when another game has the basename", async () => {
    await writeFile(path.join(root, GAME, "present.zip"), "present!");
    await writeFile(path.join(root, OTHER_GAME, "shared.zip"), "other!!!");
    const other = download("other", OTHER_GAME, "shared.zip");
    const harness = setup({ present: download("present", GAME, "present.zip"), other });
    await harness.refresh();
    await writeFile(path.join(root, GAME, "shared.zip"), "new active archive");

    onChange("rename", "shared.zip");

    await vi.waitFor(
      () => {
        expect(Object.values(harness.getState().persistent.downloads.files)).toContainEqual(
          expect.objectContaining({ game: [GAME], localPath: "shared.zip", size: 18 }),
        );
      },
      { timeout: 2000 },
    );
    expect(harness.getState().persistent.downloads.files.other).toEqual(other);
  });

  it("replacement import removes only metadata for the destination game", async () => {
    await mkdir(path.join(root, "incoming"));
    const source = path.join(root, "incoming", "shared.zip");
    await writeFile(source, "replacement payload");
    await writeFile(path.join(root, GAME, "shared.zip"), "active!!");
    await writeFile(path.join(root, OTHER_GAME, "shared.zip"), "other!!!");
    const other = download("other", OTHER_GAME, "shared.zip");
    const harness = setup({ active: download("active", GAME, "shared.zip"), other });
    harness.setNextDialog({ action: "Replace", input: {} });

    const ids = await new Promise<string[]>((resolve) => {
      harness.api.events.emit("import-downloads", [source], resolve, true);
    });

    expect(ids).toHaveLength(1);
    expect(harness.getState().persistent.downloads.files.active).toBeUndefined();
    expect(harness.getState().persistent.downloads.files.other).toEqual(other);
    expect(harness.getState().persistent.downloads.files[ids[0]]).toMatchObject({ game: [GAME] });
    expect(await readFile(path.join(root, GAME, "shared.zip"), "utf8")).toBe("replacement payload");
    expect(await readFile(path.join(root, OTHER_GAME, "shared.zip"), "utf8")).toBe("other!!!");
  });

  it("keeps the import's destination game when the active profile changes during copy", async () => {
    const source = path.join(root, "incoming.zip");
    await writeFile(source, "new archive");
    const harness = setup({});
    const copy = fs.copyAsync;
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const copying = vi
      .spyOn(fs, "copyAsync")
      .mockImplementation((from, to) => PromiseBB.resolve(gate).then(() => copy(from, to)));

    const imported = new Promise<string[]>((resolve) => {
      harness.api.events.emit("import-downloads", [source], resolve, true);
    });
    await vi.waitFor(() => expect(copying).toHaveBeenCalled());
    harness.setState((state) => {
      state.settings.profiles.activeProfileId = "profile-b";
    });
    release();
    const ids = await imported;

    expect(ids).toHaveLength(1);
    expect(harness.getState().persistent.downloads.files[ids[0]]).toMatchObject({
      game: [GAME],
      localPath: "incoming.zip",
      size: 11,
    });
    expect(await readFile(path.join(root, GAME, "incoming.zip"), "utf8")).toBe("new archive");
  });

  it("keeps a directory import's destination game across an active-profile change", async () => {
    const source = path.join(root, "incoming-directory");
    await mkdir(source);
    await writeFile(path.join(source, "payload.txt"), "directory payload");
    const harness = setup({});
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const archiving = vi.spyOn(Zip.prototype, "add").mockImplementation(
      (destination) =>
        PromiseBB.resolve(gate)
          .then(() => writeFile(destination, "archive fixture"))
          .then(() => ({ code: 0, errors: [] })) as ReturnType<Zip["add"]>,
    );
    const imported = new Promise<string[]>((resolve) => {
      harness.api.events.emit("import-downloads", [source], resolve, true);
    });
    await vi.waitFor(() => expect(archiving).toHaveBeenCalled());
    harness.setState((state) => {
      state.settings.profiles.activeProfileId = "profile-b";
    });
    release();
    const ids = await imported;

    expect(ids).toHaveLength(1);
    expect(harness.getState().persistent.downloads.files[ids[0]]).toMatchObject({
      game: [GAME],
      localPath: "incoming-directory.7z",
      size: 15,
    });
    expect(await readFile(path.join(root, GAME, "incoming-directory.7z"), "utf8")).toBe(
      "archive fixture",
    );
  });

  for (const gameHint of [undefined, OTHER_GAME]) {
    it(`hash events update the physical archive's owner with game hint ${gameHint}`, async () => {
      await writeFile(path.join(root, GAME, "shared.zip"), "active!!");
      const target = path.join(root, OTHER_GAME, "shared.zip");
      await writeFile(target, "other game's larger archive");
      const payload = await readFile(target);
      const md5 = createHash("md5").update(payload).digest("hex");
      const active = download("active", GAME, "shared.zip");
      const harness = setup({ active, other: download("other", OTHER_GAME, "shared.zip") });
      if (gameHint === undefined) {
        harness.setState((state) => {
          state.settings.profiles.activeProfileId = undefined;
        });
      }

      harness.api.events.emit("filehash-calculated", target, md5, payload.length, gameHint);

      expect(harness.getState().persistent.downloads.files.active).toEqual(active);
      expect(harness.getState().persistent.downloads.files.other).toMatchObject({
        fileMD5: md5,
        size: payload.length,
        received: 8,
      });
    });
  }

  it("finalization hashes the known download ID when another game has the same basename", async () => {
    await writeFile(path.join(root, GAME, "shared.zip"), "active!!");
    const target = path.join(root, OTHER_GAME, "shared.zip");
    await writeFile(target, "other game's larger archive");
    const payload = await readFile(target);
    const md5 = createHash("md5").update(payload).digest("hex");
    const active = download("active", GAME, "shared.zip");
    const harness = setup({ active, other: download("other", OTHER_GAME, "shared.zip") });
    harness.api.genMd5Hash = vi.fn((filename: string | Buffer) =>
      PromiseBB.resolve(typeof filename === "string" ? readFile(filename) : filename).then(
        (bytes) => ({
          md5sum: createHash("md5").update(bytes).digest("hex"),
          numBytes: bytes.length,
        }),
      ),
    );

    await finalizeDownload(harness.api, "other", target);

    expect(harness.getState().persistent.downloads.files.active).toEqual(active);
    expect(harness.getState().persistent.downloads.files.other).toMatchObject({
      fileMD5: md5,
      size: payload.length,
      received: 8,
      state: "finished",
    });
  });

  it("legacy filename-only hashes leave ambiguous game records unchanged", async () => {
    await writeFile(path.join(root, GAME, "shared.zip"), "active!!");
    await writeFile(path.join(root, OTHER_GAME, "shared.zip"), "other!!!");
    const active = download("active", GAME, "shared.zip");
    const other = download("other", OTHER_GAME, "shared.zip");
    const harness = setup({ active, other });

    harness.api.store.dispatch(setDownloadHashByFile("shared.zip", "unscoped-md5", 99));

    expect(harness.getState().persistent.downloads.files).toEqual({ active, other });
  });

  it("ignores a hash for an unrelated directory even when the basename and game hint match", async () => {
    await writeFile(path.join(root, GAME, "shared.zip"), "active!!");
    await writeFile(path.join(root, OTHER_GAME, "shared.zip"), "other!!!");
    const unrelated = path.join(root, "unrelated");
    await mkdir(unrelated);
    await writeFile(path.join(unrelated, "shared.zip"), "unrelated payload");
    const active = download("active", GAME, "shared.zip");
    const other = download("other", OTHER_GAME, "shared.zip");
    const harness = setup({ active, other });

    harness.api.events.emit(
      "filehash-calculated",
      path.join(unrelated, "shared.zip"),
      "unrelated-md5",
      99,
      OTHER_GAME,
    );

    expect(harness.getState().persistent.downloads.files).toEqual({ active, other });
  });

  for (const code of ["EACCES", "EIO"]) {
    it(`preserves incomplete metadata and the existing archive when stat fails with ${code}`, async () => {
      const target = path.join(root, GAME, "blocked.zip");
      await writeFile(target, "complete archive");
      const original = download("blocked", GAME, "blocked.zip", 0);
      const harness = setup({ blocked: original });
      const stat = fs.statAsync;
      vi.spyOn(fs, "statAsync").mockImplementation((targetPath) =>
        targetPath === target
          ? PromiseBB.reject(Object.assign(new Error(code), { code }))
          : stat(targetPath),
      );

      await harness.refresh();

      expect(harness.getState().persistent.downloads.files.blocked).toEqual(original);
      expect(await readFile(target, "utf8")).toBe("complete archive");
      expect(harness.errorNotifications).toHaveLength(1);
    });

    it(`preserves complete metadata when archive enumeration stat fails with ${code}`, async () => {
      const target = path.join(root, GAME, "blocked.zip");
      await writeFile(target, "complete archive");
      await writeFile(path.join(root, GAME, "present.zip"), "present!");
      const original = download("blocked", GAME, "blocked.zip");
      const harness = setup({
        blocked: original,
        present: download("present", GAME, "present.zip"),
      });
      const stat = fs.statAsync;
      vi.spyOn(fs, "statAsync").mockImplementation((targetPath) =>
        targetPath === target
          ? PromiseBB.reject(Object.assign(new Error(code), { code }))
          : stat(targetPath),
      );

      await harness.refresh();

      expect(harness.getState().persistent.downloads.files.blocked).toEqual(original);
      expect(await readFile(target, "utf8")).toBe("complete archive");
      expect(harness.errorNotifications).toHaveLength(1);
    });
  }
});

async function importFile(harness: ReturnType<typeof setup>, filename: string) {
  let callbacks = 0;
  const ids = await new Promise<string[]>((resolve) => {
    harness.api.events.emit(
      "import-downloads",
      [filename],
      (result: string[]) => {
        callbacks++;
        resolve(result);
      },
      true,
    );
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(callbacks).toBe(1);
  return ids;
}

for (const mode of ["readable-replace", "unreadable-replace", "unreadable-cancel"] as const) {
  it(`replacement preserves the previous archive on copy failure: ${mode}`, async () => {
    const incoming = path.join(root, "incoming");
    await mkdir(incoming);
    const source = path.join(incoming, "mod.zip");
    const destination = path.join(root, GAME, "mod.zip");
    const oldPayload = path.join(root, "old.txt");
    const newPayload = path.join(root, "new.txt");
    await writeFile(oldPayload, "previous unique archive payload");
    await writeFile(newPayload, "new archive payload");
    await new Zip().add(destination, [oldPayload]);
    await new Zip().add(source, [newPayload]);
    await rm(oldPayload);
    const before = await readFile(destination);
    const incomingBytes = await readFile(source);
    const existing = download("existing", GAME, "mod.zip");
    const h = setup({ existing });
    h.setState((state) => {
      state.persistent.mods[GAME] = {
        installed: makeMod({ id: "installed", archiveId: "existing" }),
      };
    });
    const unreadable = mode !== "readable-replace";
    const canceled = mode === "unreadable-cancel";
    h.setNextDialog({ action: canceled ? "Cancel" : "Replace", input: {} });
    if (unreadable) {
      await chmod(source, 0o000);
    }
    let ids: string[];
    try {
      if (unreadable) {
        await expect(readFile(source)).rejects.toMatchObject({ code: "EACCES" });
        expect((await stat(source)).isFile()).toBe(true);
      }
      ids = await importFile(h, source);
    } finally {
      await chmod(source, 0o600);
    }
    expect(await readFile(source)).toEqual(incomingBytes);
    expect(h.dialogCalls.filter((call) => call.title === "File exists")).toHaveLength(1);
    if (mode === "readable-replace") {
      expect(ids).toHaveLength(1);
      expect(await readFile(destination)).toEqual(incomingBytes);
      expect(h.getState().persistent.downloads.files[ids[0]]).toMatchObject({
        localPath: "mod.zip",
        state: "finished",
      });
      expect(h.errorNotifications).toEqual([]);
      return;
    }
    expect(ids).toEqual([]);
    if (!canceled) {
      expect(h.errorNotifications).toHaveLength(1);
      expect(h.errorNotifications[0].message).toMatchObject({ code: "EACCES" });
    }
    expect(await readFile(destination)).toEqual(before);
    expect(h.getState().persistent.downloads.files.existing).toEqual(existing);
  });
}

for (const mode of ["distinct-names", "same-name", "separate-events"] as const) {
  it(`imports a batch without duplicate archive owners: ${mode}`, async () => {
    const sources: string[] = [];
    const archiveBytes: Buffer[] = [];
    for (const label of ["one", "two"]) {
      const directory = path.join(root, label);
      await mkdir(directory);
      const payload = path.join(directory, "payload.txt");
      await writeFile(payload, label + " payload");
      const archive = path.join(directory, mode !== "distinct-names" ? "mod.zip" : label + ".zip");
      await new Zip().add(archive, [payload]);
      sources.push(archive);
      archiveBytes.push(await readFile(archive));
    }
    expect(archiveBytes[0]).not.toEqual(archiveBytes[1]);
    const h = setup({});
    h.setNextDialog({ action: "Cancel", input: {} });
    const ids =
      mode === "separate-events"
        ? (await Promise.all(sources.map((source) => importFile(h, source)))).flat()
        : await new Promise<string[]>((resolve) =>
            h.api.events.emit("import-downloads", sources, resolve, true),
          );
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (mode === "distinct-names") expect(ids).toHaveLength(2);
    else {
      expect(ids).toHaveLength(1);
      expect(h.dialogCalls).toHaveLength(1);
    }
    if (h.dialogCalls.length === 0) expect(h.errorNotifications).toEqual([]);
    const files = h.getState().persistent.downloads.files;
    const names = ids.map((id) => files[id].localPath);
    for (let i = 0; i < sources.length; i++)
      expect(await readFile(sources[i])).toEqual(archiveBytes[i]);
    const output = await Promise.all(
      ids.map((id) => readFile(path.join(root, GAME, files[id].localPath))),
    );
    expect(new Set(names).size).toBe(ids.length);
    if (mode === "distinct-names") expect(output).toEqual(archiveBytes);
    else
      for (const bytes of output)
        expect(archiveBytes.some((original) => original.equals(bytes))).toBe(true);
  });
}

for (const mode of ["readable-replace", "unreadable-replace", "unreadable-cancel"] as const) {
  it(`directory replacement preserves the previous archive on listing failure: ${mode}`, async () => {
    const incoming = path.join(root, "incoming");
    const source = path.join(incoming, "folder");
    await mkdir(source, { recursive: true });
    const destination = path.join(root, GAME, "folder.7z");
    const oldPayload = path.join(root, "old.txt");
    await writeFile(oldPayload, "only previous archive payload");
    await new Zip().add(destination, [oldPayload]);
    await rm(oldPayload);
    await writeFile(path.join(source, "new.txt"), "new folder contents");
    const before = await readFile(destination);
    const existing = download("existing", GAME, "folder.7z");
    const h = setup({ existing });
    const unreadable = mode !== "readable-replace";
    const canceled = mode === "unreadable-cancel";
    h.setNextDialog({ action: canceled ? "Cancel" : "Replace", input: {} });
    if (unreadable) {
      await chmod(source, 0o000);
    }
    let ids: string[];
    try {
      if (unreadable) {
        await expect(readdir(source)).rejects.toMatchObject({ code: "EACCES" });
        expect((await stat(source)).isDirectory()).toBe(true);
      }
      ids = await importFile(h, source);
    } finally {
      await chmod(source, 0o700);
    }
    expect(await readFile(path.join(source, "new.txt"), "utf8")).toBe("new folder contents");
    if (mode === "readable-replace") {
      expect(ids).toHaveLength(1);
      const extracted = path.join(root, "extracted");
      await new Zip().extractFull(destination, extracted);
      expect(await readFile(path.join(extracted, "new.txt"), "utf8")).toBe("new folder contents");
      expect(h.errorNotifications).toEqual([]);
      return;
    }
    expect(ids).toEqual([]);
    if (!canceled) {
      expect(h.errorNotifications).toHaveLength(1);
      expect(h.errorNotifications[0].message).toMatchObject({ code: "EACCES" });
    }
    expect(await readFile(destination)).toEqual(before);
    expect(h.getState().persistent.downloads.files.existing).toEqual(existing);
  });
}

for (const sourceType of ["file", "directory"]) {
  it(`restores the previous ${sourceType} import when registration fails`, async () => {
    const incoming = path.join(root, "incoming");
    await mkdir(incoming);
    const source = path.join(incoming, sourceType === "file" ? "mod.zip" : "folder");
    const destination = path.join(root, GAME, sourceType === "file" ? "mod.zip" : "folder.7z");
    const previousPayload = path.join(root, "previous.txt");
    await writeFile(previousPayload, "previous archive contents");
    await new Zip().add(destination, [previousPayload]);
    const previous = await readFile(destination);
    if (sourceType === "file") {
      await writeFile(source, "new archive bytes");
    } else {
      await mkdir(source);
      await writeFile(path.join(source, "new.txt"), "new archive contents");
    }
    const existing = download("existing", GAME, path.basename(destination));
    const h = setup({ existing });
    h.setNextDialog({ action: "Replace", input: {} });
    h.api.events.on("did-import-downloads", (_ids, cb) => cb(new Error("Registration failed")));

    expect(await importFile(h, source)).toEqual([]);
    expect(await readFile(destination)).toEqual(previous);
    expect(h.getState().persistent.downloads.files).toEqual({ existing });
    expect(await readdir(path.dirname(destination))).toEqual([path.basename(destination)]);
    const extracted = path.join(root, "restored");
    await new Zip().extractFull(destination, extracted);
    expect(await readFile(path.join(extracted, "previous.txt"), "utf8")).toBe(
      "previous archive contents",
    );
  });
}
