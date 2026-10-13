import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import PromiseBB from "bluebird";
import Zip from "node-7z";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeApiHarness, makeDownload, makeProfile } from "../../test-utils/builders";
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

function setup(downloads: Record<string, IDownload>) {
  const profile = makeProfile({ id: "profile-a", gameId: GAME });
  const otherProfile = makeProfile({ id: "profile-b", gameId: OTHER_GAME });
  const harness = makeApiHarness({
    downloads,
    profiles: { [profile.id]: profile, [otherProfile.id]: otherProfile },
    activeProfileId: profile.id,
  });
  harness.setState((state) => {
    state.settings.downloads.path = root;
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
