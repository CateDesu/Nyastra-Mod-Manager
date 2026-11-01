import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  rename,
  stat,
  writeFile,
  symlink,
} from "node:fs/promises";
import type * as NativeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { getErrorCode } from "@vortex/shared";
import type { WireResolvedResource } from "@vortex/shared/ipc";
import PromiseBB from "bluebird";
import Zip from "node-7z";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { IPCDownloadAdapter } from "../../IPCDownloadAdapter";
import { makeApiHarness, makeDownload, makeProfile } from "../../test-utils/builders";
import type { IExtensionContext } from "../../types/IExtensionContext";
import * as fs from "../../util/fs";
import init from "./index";
import * as archiveMutations from "./util/archiveOwnership";
import type * as Metadata from "./util/queryDLInfo";

vi.mock("./views/DownloadView", () => ({ default: () => null }));
vi.mock("./views/Settings", () => ({ default: () => null }));
vi.mock("./views/ShutdownButton", () => ({ default: () => null }));
vi.mock("./views/SpeedOMeter", () => ({ default: () => null }));
vi.mock("./downloadAttributes", () => ({ default: () => [] }));
vi.mock("./util/downloadDirectory", () => ({
  ensureDownloadsDirectory: () => PromiseBB.resolve(),
}));
vi.mock("./util/queryDLInfo", async (original) => ({
  ...(await original<typeof Metadata>()),
  default: () => PromiseBB.resolve(),
}));
import { setDownloadHash } from "./actions/state";
import { queryInfoInternal } from "./util/queryDLInfo";

const unlinkGate = vi.hoisted(() => ({
  before: undefined as undefined | ((file: string) => Promise<void>),
  renameDelay: 0,
  stagedRenames: 0,
  renameWork: [] as Promise<void>[],
}));
vi.mock("node:fs/promises", async (original) => {
  const native = await original<typeof NativeFs>();
  const gatedRm = async (...args: Parameters<typeof native.rm>) => {
    await unlinkGate.before?.(String(args[0]));
    return native.rm(...args);
  };
  const gatedRename = (...args: Parameters<typeof native.rename>) => {
    const work = (async () => {
      if (String(args[0]).includes("/__vortex_tmp_")) {
        unlinkGate.stagedRenames++;
        if (unlinkGate.renameDelay) await delay(unlinkGate.renameDelay);
      }
      await native.rename(...args);
    })();
    unlinkGate.renameWork.push(work);
    return work;
  };
  return {
    ...native,
    default: { ...native, rm: gatedRm, rename: gatedRename },
    rm: gatedRm,
    rename: gatedRename,
  };
});

const GAME = "game-a";
let root: string;
let savedApi: typeof window.api;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "nyastra-import-removal-")));
  await mkdir(path.join(root, GAME));
  savedApi = window.api;
  unlinkGate.renameDelay = 0;
  unlinkGate.stagedRenames = 0;
  unlinkGate.renameWork = [];
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  window.api = {
    log: vi.fn(),
    downloader: { onResolve: vi.fn() },
  } as unknown as typeof window.api;
  vi.spyOn(fs, "watch").mockReturnValue({ close: vi.fn(), on: vi.fn() } as unknown as fs.FSWatcher);
});

afterEach(async () => {
  unlinkGate.before = undefined;
  await Promise.all(unlinkGate.renameWork);
  vi.useRealTimers();
  window.api = savedApi;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function setup(previous: boolean) {
  const old = makeDownload({
    id: "old",
    game: [GAME],
    state: "finished",
    localPath: "archive.zip",
    modInfo: { source: "local" },
  });
  const profile = makeProfile({ id: "profile", gameId: GAME });
  const h = makeApiHarness({
    downloads: previous ? { old } : {},
    profiles: { [profile.id]: profile },
    activeProfileId: profile.id,
  });
  h.setState((state) => {
    state.settings.downloads.path = root;
    state.session.base = { commandLine: {} } as typeof state.session.base;
  });
  h.api.registerProtocol = vi.fn();
  h.api.deregisterProtocol = vi.fn();
  h.api.lookupModMeta = vi.fn().mockResolvedValue([]);
  const once: Array<() => void> = [];
  const context = {
    api: h.api,
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
  new IPCDownloadAdapter(h.api);
  h.setNextDialog({ action: "Replace", input: {} });
  return { ...h, old };
}

function registration(h: ReturnType<typeof setup>) {
  const entered = deferred<string>();
  const gate = deferred<Error | undefined>();
  const work: Promise<void>[] = [];
  h.api.events.removeAllListeners("did-import-downloads");
  h.api.events.on("did-import-downloads", (ids: string[], callback: (error?: Error) => void) => {
    work.push(
      (async () => {
        entered.resolve(ids[0]);
        callback(await gate.promise);
      })(),
    );
  });
  return { entered, gate, work };
}

function startImport(h: ReturnType<typeof setup>, source: string) {
  const callback = vi.fn();
  const promise = new Promise<string[]>((resolve) =>
    h.api.events.emit("import-downloads", [source], (ids: string[]) => {
      callback(ids);
      resolve(ids);
    }),
  );
  return { callback, promise };
}

async function archives(kind: "file" | "directory", previous: boolean) {
  const destination = path.join(root, GAME, "archive.zip");
  const payload = path.join(root, "payload.txt");
  await writeFile(payload, "original payload");
  if (previous) await new Zip().add(destination, [payload]);
  const oldBytes = previous ? await readFile(destination) : undefined;
  const incoming = path.join(root, "incoming");
  await mkdir(incoming);
  const source = path.join(incoming, kind === "file" ? "archive.zip" : "archive");
  if (kind === "file") {
    await writeFile(payload, "replacement payload");
    await new Zip().add(source, [payload]);
  } else {
    await mkdir(source);
    await writeFile(path.join(source, "payload.txt"), "replacement payload");
  }
  return { destination, source, oldBytes };
}

for (const mode of ["single", "same-entry", "directory-alias", "file-alias", "unrelated"]) {
  for (const metadata of [false, true]) {
    it(`changing primary game preserves other archive owners: ${mode}, metadata=${metadata}`, async () => {
      const { destination, oldBytes } = await archives("file", true);
      const h = setup(true);
      h.setState((s) => {
        s.persistent.downloads.files.old.size = oldBytes!.length;
        s.persistent.downloads.files.old.received = oldBytes!.length;
      });
      const peerDirectory =
        mode === "same-entry" ? path.dirname(destination) : path.join(root, "alias-game");
      const peerPath = path.join(peerDirectory, "archive.zip");
      if (mode === "directory-alias")
        await symlink(path.dirname(destination), peerDirectory, "dir");
      if (mode === "file-alias") {
        await mkdir(peerDirectory);
        await symlink(destination, peerPath);
      }
      if (mode === "unrelated") {
        await mkdir(peerDirectory);
        await writeFile(peerPath, "unrelated archive");
      }
      if (mode !== "single")
        h.setState((s) => {
          s.persistent.downloads.files.peer = makeDownload({
            id: "peer",
            state: "finished",
            game: [mode === "same-entry" ? GAME : "alias-game"],
            localPath: "archive.zip",
            size: mode === "unrelated" ? 17 : oldBytes!.length,
            received: mode === "unrelated" ? 17 : oldBytes!.length,
          });
        });
      await h.emitAndAwait("set-download-games", "old", ["next-game"], metadata);
      expect(h.errorNotifications).toEqual([]);
      const moved = h.getState().persistent.downloads.files.old;
      expect(moved.game).toEqual(["next-game"]);
      const movedPath = path.join(root, "next-game", moved.localPath!);
      expect(await readFile(movedPath)).toEqual(oldBytes);
      const extracted = path.join(root, "extracted-moved");
      await new Zip().extractFull(movedPath, extracted);
      expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe("original payload");
      if (mode === "single")
        await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      else {
        const bytes = await readFile(peerPath).catch(getErrorCode);
        expect(Buffer.isBuffer(bytes)).toBe(true);
        expect(bytes).toEqual(mode === "unrelated" ? Buffer.from("unrelated archive") : oldBytes);
      }
    });
  }
}

for (const renameDelay of [0, 250]) {
  for (const order of ["remove-first", "import-first", "overlap"]) {
    it(`serializes removal and local replacement: ${order}, rename delay=${renameDelay}`, async () => {
      const { source, destination } = await archives("file", true);
      const replacement = await readFile(source);
      const h = setup(true);
      const entered = deferred<void>();
      const release = deferred<void>();
      const staged = deferred<void>();
      const submitted = deferred<void>();
      let importing = false;
      const nativeQueue = archiveMutations.withArchiveMutation;
      vi.spyOn(archiveMutations, "withArchiveMutation").mockImplementation((api, operation) => {
        const work = nativeQueue(api, operation);
        if (importing) submitted.resolve();
        return work;
      });
      unlinkGate.renameDelay = renameDelay;
      const nativeCopy = fs.copyAsync;
      vi.spyOn(fs, "copyAsync").mockImplementation((...args) =>
        nativeCopy(...args).tap(() => staged.resolve()),
      );
      const writes: Promise<void>[] = [];
      unlinkGate.before = (file) => {
        const work = (async () => {
          if (order === "overlap" && file === destination) {
            entered.resolve();
            await release.promise;
          }
        })();
        writes.push(work);
        return work;
      };
      const removed = vi.fn();
      const remove = () =>
        new Promise<Error | null>((resolve) =>
          h.api.events.emit("remove-download", "old", (error) => {
            removed(error);
            resolve(error);
          }),
        );
      let removal: Promise<Error | null> | undefined;
      let run: ReturnType<typeof startImport> | undefined;
      try {
        if (order !== "import-first") {
          removal = remove();
          if (order === "overlap") await entered.promise;
          else expect(await removal).toBeNull();
        }
        importing = true;
        run = startImport(h, source);
        if (order === "overlap") {
          await staged.promise;
          // Queued imports can wait. Uncoordinated imports must finish before unlink resumes.
          await Promise.race([submitted.promise, run.promise]);
          release.resolve();
        }
        await run.promise;
        if (order === "import-first") removal = remove();
      } finally {
        release.resolve();
        if (run) await run.promise;
        if (removal) await removal;
        await Promise.all(writes);
        await Promise.all(unlinkGate.renameWork);
        unlinkGate.before = undefined;
      }
      const ids = await run!.promise;
      expect(ids).toHaveLength(1);
      expect(run!.callback).toHaveBeenCalledExactlyOnceWith(ids);
      expect(await removal).toBeNull();
      expect(removed).toHaveBeenCalledExactlyOnceWith(null);
      expect(unlinkGate.stagedRenames).toBe(1);
      expect(Object.keys(h.getState().persistent.downloads.files)).toEqual(ids);
      expect(await readFile(destination).catch(getErrorCode)).toEqual(replacement);
      expect(await readFile(source)).toEqual(replacement);
      expect(await readdir(path.dirname(destination))).toEqual(["archive.zip"]);
      const extracted = path.join(root, "extracted");
      await new Zip().extractFull(destination, extracted);
      expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe(
        "replacement payload",
      );
    });
  }
}

for (const previous of [false, true]) {
  it(`awaits a reentrant metadata game move during registration with previous=${previous}`, async () => {
    const { source, destination } = await archives("file", previous);
    const replacement = await readFile(source);
    const h = setup(previous);
    const work: Promise<void>[] = [];
    h.api.lookupModMeta = vi.fn().mockReturnValue(
      PromiseBB.resolve([
        {
          key: "metadata",
          value: {
            gameId: "next-game",
            fileName: "archive.zip",
            sourceURI: "https://example.invalid/archive.zip",
          },
        },
      ]),
    );
    h.api.emitAndAwait = ((event: string, ...args: unknown[]) =>
      h.emitAndAwait(event, ...args)) as typeof h.api.emitAndAwait;
    h.api.events.removeAllListeners("did-import-downloads");
    h.api.events.on("did-import-downloads", (ids: string[], callback: (error?: Error) => void) => {
      h.api.store.dispatch(setDownloadHash(ids[0], "0123456789abcdef0123456789abcdef"));
      const metadata = queryInfoInternal(h.api, ids[0], false).then(() => callback(), callback);
      work.push(Promise.resolve(metadata));
    });
    const run = startImport(h, source);
    const ids = await run.promise;
    await Promise.all(work);
    expect(ids).toHaveLength(1);
    expect(run.callback).toHaveBeenCalledExactlyOnceWith(ids);
    expect(Object.keys(h.getState().persistent.downloads.files)).toEqual(ids);
    const row = h.getState().persistent.downloads.files[ids[0]];
    expect(row.game).toEqual(["next-game", GAME]);
    expect(await readFile(path.join(root, "next-game", row.localPath!))).toEqual(replacement);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(path.dirname(destination))).toEqual([]);
    expect(h.errorNotifications).toEqual([]);
    const extracted = path.join(root, "extracted");
    await new Zip().extractFull(path.join(root, "next-game", row.localPath!), extracted);
    expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe("replacement payload");
  });
}

it("queues two game moves using the row's live source", async () => {
  const { destination, oldBytes } = await archives("file", true);
  const h = setup(true);
  h.setState((state) => {
    state.persistent.downloads.files.peer = makeDownload({
      id: "peer",
      state: "finished",
      game: [GAME],
      localPath: "archive.zip",
    });
  });
  await Promise.all([
    h.emitAndAwait("set-download-games", "old", ["next-game"], true),
    h.emitAndAwait("set-download-games", "old", ["final-game"], false),
  ]);
  const row = h.getState().persistent.downloads.files.old;
  expect(row.game).toEqual(["final-game"]);
  expect(await readFile(path.join(root, "final-game", row.localPath!))).toEqual(oldBytes);
  expect(await readFile(destination)).toEqual(oldBytes);
  await expect(stat(path.join(root, "next-game", "archive.zip"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(h.errorNotifications).toEqual([]);
});

it("copies a shared archive to a free name without overwriting existing destinations", async () => {
  const { destination, oldBytes } = await archives("file", true);
  const h = setup(true);
  h.setState((state) => {
    state.persistent.downloads.files.peer = makeDownload({
      id: "peer",
      state: "finished",
      game: [GAME],
      localPath: "archive.zip",
    });
  });
  const target = path.join(root, "next-game");
  await mkdir(target);
  await writeFile(path.join(target, "archive.zip"), "first existing file");
  await writeFile(path.join(target, "archive.1.zip"), "second existing file");
  await h.emitAndAwait("set-download-games", "old", ["next-game"], true);
  const row = h.getState().persistent.downloads.files.old;
  expect(row.localPath).toBe("archive.2.zip");
  expect(await readFile(path.join(target, row.localPath!))).toEqual(oldBytes);
  expect(await readFile(path.join(target, "archive.zip"), "utf8")).toBe("first existing file");
  expect(await readFile(path.join(target, "archive.1.zip"), "utf8")).toBe("second existing file");
  expect(await readFile(destination)).toEqual(oldBytes);
  expect(h.errorNotifications).toEqual([]);
});

for (const peer of [false, true]) {
  it(`moves a relative file alias without breaking its target with peer=${peer}`, async () => {
    const { destination, oldBytes } = await archives("file", true);
    const shared = path.join(root, "shared");
    await mkdir(shared);
    const target = path.join(shared, "archive.zip");
    await rename(destination, target);
    await symlink("../shared/archive.zip", destination);
    const h = setup(true);
    if (peer)
      h.setState((state) => {
        state.persistent.downloads.files.peer = makeDownload({
          id: "peer",
          state: "finished",
          game: ["shared"],
          localPath: "archive.zip",
        });
      });
    await h.emitAndAwait("set-download-games", "old", ["next-game"], true);
    const row = h.getState().persistent.downloads.files.old;
    const moved = path.join(root, "next-game", row.localPath!);
    expect(await readFile(moved)).toEqual(oldBytes);
    expect(await readFile(target)).toEqual(oldBytes);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    const removed = await new Promise<Error | null>((resolve) =>
      h.api.events.emit("remove-download", "old", resolve),
    );
    expect(removed).toBeNull();
    expect(await readFile(target)).toEqual(oldBytes);
    await expect(stat(moved)).rejects.toMatchObject({ code: "ENOENT" });
    expect(h.errorNotifications).toEqual([]);
    const extracted = path.join(root, "extracted");
    await new Zip().extractFull(target, extracted);
    expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe("original payload");
  });
}

it("keeps newer archive bytes and the backup if registration rollback loses file identity", async () => {
  const { source, destination, oldBytes } = await archives("file", true);
  const h = setup(true);
  const pending = registration(h);
  const run = startImport(h, source);
  try {
    await pending.entered.promise;
    const newer = path.join(root, "newer.zip");
    const payload = path.join(root, "newer.txt");
    await writeFile(payload, "newer archive payload");
    await new Zip().add(newer, [payload]);
    const bytes = await readFile(newer);
    await rename(newer, destination);
    pending.gate.resolve(new Error("metadata failed"));
    await Promise.all(pending.work);
    expect(await run.promise).toEqual([]);
    expect(run.callback).toHaveBeenCalledExactlyOnceWith([]);
    expect(await readFile(destination)).toEqual(bytes);
    const staging = (await readdir(path.dirname(destination))).filter((name) =>
      name.startsWith("__vortex_tmp_"),
    );
    expect(staging).toHaveLength(1);
    const backup = path.join(path.dirname(destination), staging[0], "previous");
    expect(await readFile(backup)).toEqual(oldBytes);
    expect(h.errorNotifications).toHaveLength(1);
    expect((h.errorNotifications[0].message as Error).message).toContain(backup);
    expect(Object.keys(h.getState().persistent.downloads.files)).toEqual(["old"]);
    const extracted = path.join(root, "extracted");
    await new Zip().extractFull(destination, extracted);
    expect(await readFile(path.join(extracted, "newer.txt"), "utf8")).toBe("newer archive payload");
  } finally {
    pending.gate.resolve(undefined);
    await Promise.all(pending.work);
    await run.promise;
  }
});

it("persists ownership for an alias peer after a game move and a serialized restart", async () => {
  const { destination, oldBytes } = await archives("file", true);
  const h = setup(true);
  const aliasDirectory = path.join(root, "alias-game");
  await mkdir(aliasDirectory);
  await symlink(destination, path.join(aliasDirectory, "archive.zip"));
  h.setState((state) => {
    state.persistent.downloads.files.peer = makeDownload({
      id: "peer",
      state: "finished",
      game: ["alias-game"],
      localPath: "archive.zip",
    });
  });
  await h.emitAndAwait("set-download-games", "old", ["next-game"], true);
  const downloads = JSON.parse(JSON.stringify(h.getState().persistent.downloads));
  expect(downloads.files.peer.modInfo.__nyastraManagedArchive).toMatchObject({ path: destination });
  const reloaded = makeApiHarness();
  reloaded.setState((state) => {
    state.settings.downloads.path = root;
    state.persistent.downloads = downloads;
  });
  new IPCDownloadAdapter(reloaded.api);
  const error = await new Promise<Error | null>((resolve) =>
    reloaded.api.events.emit("remove-download", "peer", resolve),
  );
  expect(error).toBeNull();
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  const moved = path.join(
    root,
    "next-game",
    reloaded.getState().persistent.downloads.files.old.localPath!,
  );
  expect(await readFile(moved)).toEqual(oldBytes);
});

it("keeps proven target ownership when the destination is a file alias", async () => {
  const { destination, oldBytes } = await archives("file", true);
  const h = setup(true);
  const aliasDirectory = path.join(root, "next-game");
  await mkdir(aliasDirectory);
  await symlink(destination, path.join(aliasDirectory, "archive.zip"));
  await h.emitAndAwait("set-download-games", "old", ["next-game"], true);
  expect(h.getState().persistent.downloads.files.old.game).toEqual(["next-game"]);
  expect(await readFile(path.join(aliasDirectory, "archive.zip"))).toEqual(oldBytes);
  const error = await new Promise<Error | null>((resolve) =>
    h.api.events.emit("remove-download", "old", resolve),
  );
  expect(error).toBeNull();
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
});

for (const timing of ["sequential", "overlap"]) {
  for (const outcome of ["cancel", "finish"]) {
    it(`retry follows the live row after a queued game move: ${timing}, ${outcome}`, async () => {
      const { destination } = await archives("file", true);
      const h = setup(true);
      h.setState((state) => {
        state.persistent.downloads.checkpoints = {};
        state.persistent.downloads.files.old.state = "failed";
        state.persistent.downloads.files.old.urls = ["https://example.invalid/archive.zip"];
      });
      const incoming = path.join(root, "retry.zip");
      const payload = path.join(root, "retry.txt");
      await writeFile(payload, "retry bytes from main");
      await new Zip().add(incoming, [payload]);
      const replacement = await readFile(incoming);
      const resolveHandler = vi.mocked(window.api.downloader.onResolve).mock.calls[0][0];
      const resolverWork: Promise<WireResolvedResource>[] = [];
      const start = vi.fn(async (file: string, collation: number, id?: string) => {
        const resolving = Promise.resolve(resolveHandler(collation));
        resolverWork.push(resolving);
        await resolving;
        await writeFile(file, replacement);
        return { downloadId: id! };
      });
      const cancel = vi.fn(async () => {
        const file = start.mock.calls[0]?.[0];
        if (file) await rm(file, { force: true });
      });
      Object.assign(window.api.downloader, { start, cancel });
      const entered = deferred<void>();
      const release = deferred<void>();
      const submitted = deferred<void>();
      const nativeQueue = archiveMutations.withArchiveMutation;
      let resuming = false;
      vi.spyOn(archiveMutations, "withArchiveMutation").mockImplementation((api, operation) => {
        const work = nativeQueue(api, operation);
        if (resuming) submitted.resolve();
        return work;
      });
      const nativeMove = fs.moveRenameAsync;
      const moveWork: Promise<string>[] = [];
      vi.spyOn(fs, "moveRenameAsync").mockImplementation((...args) => {
        const work = PromiseBB.resolve(
          (async () => {
            if (timing === "overlap") {
              entered.resolve();
              await release.promise;
            }
            return nativeMove(...args);
          })(),
        );
        moveWork.push(Promise.resolve(work));
        return work;
      });
      const moving = h.emitAndAwait("set-download-games", "old", ["next-game"], false);
      const resumed = vi.fn();
      let retry: Promise<Error | null> | undefined;
      try {
        if (timing === "overlap") await entered.promise;
        else await moving;
        resuming = true;
        retry = new Promise((resolve) =>
          h.api.events.emit("resume-download", "old", (error, id) => {
            resumed(error, id);
            resolve(error);
          }),
        );
        if (timing === "overlap") await submitted.promise;
      } finally {
        release.resolve();
        await moving;
        if (retry) await retry;
        await Promise.all(moveWork);
        await Promise.all(resolverWork);
      }
      const result = await retry;
      let row = h.getState().persistent.downloads.files.old;
      const startedPath = start.mock.calls[0][0];
      const rowPath = path.join(root, row.game[0], row.localPath!);
      const completed = vi.fn();
      const getStates = vi.fn().mockResolvedValue({
        old: {
          status: "completed",
          error: null,
          bytesReceived: replacement.length,
          bytesWritten: replacement.length,
          size: replacement.length,
          fileName: "archive.zip",
          isChunked: false,
        },
      });
      const hashWork: Promise<{ hash: string; numBytes: number }>[] = [];
      const compute = vi.fn((algorithm: string, file: string) => {
        const work = readFile(file).then((bytes) => ({
          hash: createHash(algorithm).update(bytes).digest("hex"),
          numBytes: bytes.length,
        }));
        hashWork.push(work);
        return work;
      });
      if (outcome === "finish") {
        const finished = deferred<void>();
        h.api.events.on("did-finish-download", (id, state) => {
          completed(id, state);
          if (id === "old" && state === "finished") finished.resolve();
        });
        Object.assign(window.api.downloader, { getStates });
        window.api.hash = { compute };
        await vi.advanceTimersByTimeAsync(200);
        await finished.promise;
        await Promise.all(hashWork);
        row = h.getState().persistent.downloads.files.old;
      }
      const rowBytes = await readFile(rowPath);
      const startedBytes = await readFile(startedPath);
      const extracted = path.join(root, "extracted-retry");
      await new Zip().extractFull(rowPath, extracted);
      const extractedPayload = await readFile(path.join(extracted, "retry.txt"), "utf8").catch(
        getErrorCode,
      );
      const removed = vi.fn();
      // Removal awaits any finalizer still registered after its completion event.
      const removal = await new Promise<Error | null>((resolve) =>
        h.api.events.emit("remove-download", "old", (error) => {
          removed(error);
          resolve(error);
        }),
      );
      const remaining = await stat(startedPath).then(
        () => true,
        (error) => {
          if (getErrorCode(error) === "ENOENT") return false;
          throw error;
        },
      );
      expect(result).toBeNull();
      expect(resumed).toHaveBeenCalledExactlyOnceWith(null, "old");
      expect(h.errorNotifications).toEqual([]);
      expect(start).toHaveBeenCalledTimes(1);
      expect(moveWork).toHaveLength(1);
      expect(resolverWork).toHaveLength(1);
      expect(await resolverWork[0]).toEqual({
        probeEndpoint: { url: "https://example.invalid/archive.zip", headers: undefined },
      });
      expect(removal).toBeNull();
      expect(removed).toHaveBeenCalledExactlyOnceWith(null);
      expect(h.getState().persistent.downloads.files).toEqual({});
      expect(row.game).toEqual(["next-game"]);
      if (outcome === "finish") {
        expect(completed).toHaveBeenCalledExactlyOnceWith("old", "finished");
        expect(getStates).toHaveBeenCalledExactlyOnceWith(["old"]);
        expect(compute).toHaveBeenCalledExactlyOnceWith("md5", rowPath);
        expect(row.state).toBe("finished");
        expect(row.fileMD5).toBe(createHash("md5").update(replacement).digest("hex"));
        expect(cancel).not.toHaveBeenCalled();
      } else {
        expect(cancel).toHaveBeenCalledExactlyOnceWith("old");
        expect(compute).not.toHaveBeenCalled();
      }
      expect(startedBytes).toEqual(replacement);
      expect(startedPath).toBe(rowPath);
      expect(rowBytes).toEqual(replacement);
      expect(extractedPayload).toBe("retry bytes from main");
      expect(remaining).toBe(false);
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(path.join(root, "next-game"))).toEqual([]);
    });
  }
}

for (const previousRemoval of [false, true]) {
  for (const outcome of ["registration-error", "removed"]) {
    it(`registration rollback retains final alias ownership with original removed=${previousRemoval}, ${outcome}`, async () => {
      const { source, destination, oldBytes } = await archives("file", true);
      const h = setup(true);
      const aliasDirectory = path.join(root, "alias-game");
      await mkdir(aliasDirectory);
      const alias = path.join(aliasDirectory, "archive.zip");
      await symlink(destination, alias);
      h.setState((state) => {
        state.persistent.downloads.files.peer = makeDownload({
          id: "peer",
          game: ["alias-game"],
          state: "finished",
          localPath: "archive.zip",
        });
      });
      const pending = registration(h);
      const run = startImport(h, source);
      const callbacks: ReturnType<typeof vi.fn>[] = [];
      const remove = (id: string) => {
        const callback = vi.fn();
        callbacks.push(callback);
        return new Promise<Error | null>((resolve) =>
          h.api.events.emit("remove-download", id, (error) => {
            callback(error);
            resolve(error);
          }),
        );
      };
      let originalRemoval: Error | null | undefined;
      let provisionalRemoval: Error | null | undefined;
      try {
        const importedId = await pending.entered.promise;
        if (previousRemoval) originalRemoval = await remove("old");
        if (outcome === "removed") provisionalRemoval = await remove(importedId);
      } finally {
        pending.gate.resolve(
          outcome === "registration-error" ? new Error("metadata failed") : undefined,
        );
        await Promise.all(pending.work);
        await run.promise;
      }
      const ids = await run.promise;
      const restored = await readFile(alias);
      const restoredIdentity = await stat(destination);
      const extracted = path.join(root, "extracted-rollback");
      await new Zip().extractFull(alias, extracted);
      const extractedPayload = await readFile(path.join(extracted, "payload.txt"), "utf8");
      if (!previousRemoval) originalRemoval = await remove("old");
      const ownership =
        h.getState().persistent.downloads.files.peer.modInfo?.[
          archiveMutations.MANAGED_ARCHIVE_KEY
        ];
      const peerRemoval = await remove("peer");
      const remains = await stat(destination).then(
        () => true,
        (error) => {
          if (getErrorCode(error) === "ENOENT") return false;
          throw error;
        },
      );
      expect(ids).toEqual([]);
      expect(run.callback).toHaveBeenCalledExactlyOnceWith([]);
      expect(pending.work).toHaveLength(1);
      expect(restored).toEqual(oldBytes);
      expect(extractedPayload).toBe("original payload");
      expect(remains).toBe(false);
      expect(ownership).toEqual({
        path: destination,
        dev: restoredIdentity.dev,
        ino: restoredIdentity.ino,
        birthtimeMs: restoredIdentity.birthtimeMs,
      });
      expect(originalRemoval).toBeNull();
      if (outcome === "removed") expect(provisionalRemoval).toBeNull();
      expect(peerRemoval).toBeNull();
      expect(callbacks).toHaveLength(outcome === "removed" ? 3 : 2);
      callbacks.forEach((callback) => expect(callback).toHaveBeenCalledExactlyOnceWith(null));
      expect(h.getState().persistent.downloads.files).toEqual({});
      await expect(stat(alias)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(path.dirname(destination))).toEqual([]);
      expect(await readdir(aliasDirectory)).toEqual([]);
      expect(await readFile(source)).not.toEqual(oldBytes);
    });
  }
}

for (const metadataError of [false, true]) {
  it(`rollback preserves an unowned external alias target with metadata error=${metadataError}`, async () => {
    const { source, destination, oldBytes } = await archives("file", true);
    const external = path.join(root, "external.zip");
    await rename(destination, external);
    await symlink(external, destination);
    const h = setup(true);
    const aliasDirectory = path.join(root, "alias-game");
    await mkdir(aliasDirectory);
    const alias = path.join(aliasDirectory, "archive.zip");
    await symlink(destination, alias);
    h.setState((state) => {
      state.persistent.downloads.files.peer = makeDownload({
        id: "peer",
        game: ["alias-game"],
        state: "finished",
        localPath: "archive.zip",
      });
    });
    const callbacks: ReturnType<typeof vi.fn>[] = [];
    const remove = (id: string) => {
      const callback = vi.fn();
      callbacks.push(callback);
      return new Promise<Error | null>((resolve) =>
        h.api.events.emit("remove-download", id, (error) => {
          callback(error);
          resolve(error);
        }),
      );
    };
    const pending = registration(h);
    const run = startImport(h, source);
    const results: Array<Error | null> = [];
    try {
      const importedId = await pending.entered.promise;
      results.push(await remove("old"));
      if (!metadataError) results.push(await remove(importedId));
    } finally {
      pending.gate.resolve(metadataError ? new Error("metadata failed") : undefined);
      await Promise.all(pending.work);
      await run.promise;
    }
    const restored = await readFile(alias);
    results.push(await remove("peer"));
    expect(await run.promise).toEqual([]);
    expect(run.callback).toHaveBeenCalledExactlyOnceWith([]);
    expect(pending.work).toHaveLength(1);
    expect(results).toEqual(metadataError ? [null, null] : [null, null, null]);
    callbacks.forEach((callback) => expect(callback).toHaveBeenCalledExactlyOnceWith(null));
    expect(restored).toEqual(oldBytes);
    expect(await readFile(external)).toEqual(oldBytes);
    expect(h.getState().persistent.downloads.files).toEqual({});
    await expect(stat(alias)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(path.dirname(destination))).toEqual(["archive.zip"]);
  });
}

it("rollback does not grant alias ownership after the replacement loses its identity", async () => {
  const { source, destination, oldBytes } = await archives("file", true);
  const h = setup(true);
  const aliasDirectory = path.join(root, "alias-game");
  await mkdir(aliasDirectory);
  const alias = path.join(aliasDirectory, "archive.zip");
  await symlink(destination, alias);
  h.setState((state) => {
    state.persistent.downloads.files.peer = makeDownload({
      id: "peer",
      game: ["alias-game"],
      state: "finished",
      localPath: "archive.zip",
    });
  });
  const oldRemoved = vi.fn();
  const peerRemoved = vi.fn();
  const pending = registration(h);
  const run = startImport(h, source);
  const newer = path.join(root, "newer.zip");
  const payload = path.join(root, "newer.txt");
  await writeFile(payload, "newer unowned bytes");
  await new Zip().add(newer, [payload]);
  const newBytes = await readFile(newer);
  let oldResult: Error | null | undefined;
  try {
    await pending.entered.promise;
    oldResult = await new Promise<Error | null>((resolve) =>
      h.api.events.emit("remove-download", "old", (error) => {
        oldRemoved(error);
        resolve(error);
      }),
    );
    await rename(newer, destination);
  } finally {
    pending.gate.resolve(new Error("metadata failed"));
    await Promise.all(pending.work);
    await run.promise;
  }
  const removal = await new Promise<Error | null>((resolve) =>
    h.api.events.emit("remove-download", "peer", (error) => {
      peerRemoved(error);
      resolve(error);
    }),
  );
  const staging = (await readdir(path.dirname(destination))).filter((name) =>
    name.startsWith("__vortex_tmp_"),
  );
  expect(await run.promise).toEqual([]);
  expect(run.callback).toHaveBeenCalledExactlyOnceWith([]);
  expect(pending.work).toHaveLength(1);
  expect(oldResult).toBeNull();
  expect(removal).toBeNull();
  expect(oldRemoved).toHaveBeenCalledExactlyOnceWith(null);
  expect(peerRemoved).toHaveBeenCalledExactlyOnceWith(null);
  expect(h.getState().persistent.downloads.files).toEqual({});
  await expect(stat(alias)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(destination)).toEqual(newBytes);
  expect(staging).toHaveLength(1);
  const backup = path.join(path.dirname(destination), staging[0], "previous");
  expect(await readFile(backup)).toEqual(oldBytes);
  expect(h.errorNotifications).toHaveLength(1);
  expect((h.errorNotifications[0].message as Error).message).toContain(backup);
});
