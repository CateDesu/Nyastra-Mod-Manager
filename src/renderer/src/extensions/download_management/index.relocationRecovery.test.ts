import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  rename,
  stat,
  writeFile,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getErrorCode } from "@vortex/shared";
import type { WireDownloadCheckpoint, WireDownloadState } from "@vortex/shared/ipc";
import PromiseBB from "bluebird";
import Zip from "node-7z";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { IPCDownloadAdapter } from "../../IPCDownloadAdapter";
import { downloadsReducer } from "../../reducers/downloads";
import { makeApiHarness, makeDownload, makeProfile } from "../../test-utils/builders";
import type { IExtensionContext } from "../../types/IExtensionContext";
import * as fs from "../../util/fs";
import { addLocalDownload, pauseDownload } from "./actions/state";
import init from "./index";
import * as archiveMutations from "./util/archiveOwnership";
import { withArchiveMutation } from "./util/archiveOwnership";

vi.mock("./views/DownloadView", () => ({ default: () => null }));
vi.mock("./views/Settings", () => ({ default: () => null }));
vi.mock("./views/ShutdownButton", () => ({ default: () => null }));
vi.mock("./views/SpeedOMeter", () => ({ default: () => null }));
vi.mock("./downloadAttributes", () => ({ default: () => [] }));
vi.mock("./util/downloadDirectory", () => ({
  ensureDownloadsDirectory: () => PromiseBB.resolve(),
}));
vi.mock("./util/queryDLInfo", () => ({ default: () => PromiseBB.resolve() }));

const mainHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("../../../../main/src/ipc", () => ({
  betterIpcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mainHandlers.set(channel, handler),
    callback: vi.fn(),
  },
}));
vi.mock("../../../../main/src/logging", () => ({ log: vi.fn() }));

interface NativeHandle {
  promise: Promise<void>;
  cancel(): unknown;
  waitForWrites(): Promise<void>;
}
interface NativeDownloads {
  get(id: string): NativeHandle | undefined;
  getState(id: string): { status: string } | undefined;
  numPending: number;
  numRunning: number;
}

// Load main through its own runtime boundary without adding it to the renderer type graph.
async function nativeDownloader() {
  const mainRoot = path.resolve(__dirname, "../../../../main/src/downloading");
  const managerPath = path.join(mainRoot, "manager.ts");
  const ipcPath = path.join(mainRoot, "ipc.ts");
  const managerModule = (await import(managerPath)) as {
    DownloadManager: new (options: { concurrency: number }) => NativeDownloads;
  };
  const ipcModule = (await import(ipcPath)) as { init(manager: NativeDownloads): void };
  const manager = new managerModule.DownloadManager({ concurrency: 1 });
  mainHandlers.clear();
  ipcModule.init(manager);
  return manager;
}

function invokeMain(channel: string, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve(mainHandlers.get(channel)!({ sender: {} }, ...args));
}

async function rangeServer(body: Buffer) {
  const http = await import("node:http");
  const requests: Array<{ method: string; range?: string }> = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method!, range: request.headers.range });
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : body.length - 1;
    response.writeHead(range ? 206 : 200, {
      "content-length": end - start + 1,
      "accept-ranges": "bytes",
      etag: '"local-fixture"',
      "content-disposition": 'attachment; filename="archive.zip"',
      ...(range ? { "content-range": `bytes ${start}-${end}/${body.length}` } : {}),
    });
    response.end(request.method === "HEAD" ? undefined : body.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  return {
    url: `http://127.0.0.1:${address.port}/archive.zip`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const GAME = "game-a";
let root: string;
let harnesses: ReturnType<typeof makeApiHarness>[] = [];
let savedApi: typeof window.api;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nyastra-import-removal-"));
  await mkdir(path.join(root, GAME));
  savedApi = window.api;
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  window.api = {
    log: vi.fn(),
    downloader: { onResolve: vi.fn() },
  } as unknown as typeof window.api;
  vi.spyOn(fs, "watch").mockReturnValue({ close: vi.fn(), on: vi.fn() } as unknown as fs.FSWatcher);
});

afterEach(async () => {
  for (const h of harnesses) await withArchiveMutation(h.api, async () => undefined);
  harnesses = [];
  vi.clearAllTimers();
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
  const h = makeApiHarness(
    {
      downloads: previous ? { old } : {},
      profiles: { [profile.id]: profile },
      activeProfileId: profile.id,
    },
    [{ path: ["persistent", "downloads"], reducer: downloadsReducer }],
  );
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
  const adapter = new IPCDownloadAdapter(h.api);
  harnesses.push(h);
  h.setNextDialog({ action: "Replace", input: {} });
  return { ...h, old, adapter };
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

function publicRemove(h: ReturnType<typeof setup>, id: string) {
  const callback = vi.fn();
  const promise = new Promise<Error | null>((resolve) =>
    h.api.events.emit("remove-download", id, (error) => {
      callback(error);
      resolve(error);
    }),
  );
  return { callback, promise };
}

for (const mode of [
  "unchanged",
  "move",
  "queued",
  "collision",
  "shared",
  "twice",
  "resume-first",
  "duplicate",
  "file-alias",
] as const) {
  for (const outcome of ["finish", "cancel"] as const) {
    it(`checkpoint relocation uses the actual writer: ${mode}, ${outcome}`, async () => {
      const { source, destination } = await archives("file", false);
      const complete = await readFile(source);
      const prefix = complete.subarray(0, Math.floor(complete.length / 2));
      await writeFile(destination, prefix);
      const externalPath = path.join(root, "external.zip");
      if (mode === "file-alias") {
        await rename(destination, externalPath);
        await symlink(externalPath, destination);
      }
      const h = setup(true);
      const server = await rangeServer(complete);
      const manager = await nativeDownloader();
      h.setState((state) => {
        const row = state.persistent.downloads.files.old;
        row.state = "paused";
        row.received = prefix.length;
        row.size = complete.length;
        state.persistent.downloads.checkpoints = {
          old: {
            downloadId: "old",
            resource: server.url,
            dest: destination,
            completedRanges: [{ start: 0, end: prefix.length - 1 }],
            etag: '"local-fixture"',
          },
        };
        if (mode === "shared")
          state.persistent.downloads.files.peer = makeDownload({
            id: "peer",
            game: [GAME],
            localPath: "archive.zip",
            state: "paused",
          });
      });
      const collisionPath = path.join(root, "next-game", "archive.zip");
      if (mode === "collision") {
        await mkdir(path.dirname(collisionPath));
        await writeFile(collisionPath, "unrelated newer archive");
      }
      const entered = deferred<void>();
      const release = deferred<void>();
      const submitted = deferred<void>();
      const moveWork: Promise<string>[] = [];
      const nativeMove = fs.moveRenameAsync;
      vi.spyOn(fs, "moveRenameAsync").mockImplementation((...args) => {
        const work = PromiseBB.resolve(
          (async () => {
            if (mode === "queued") {
              entered.resolve();
              await release.promise;
            }
            return nativeMove(...args);
          })(),
        );
        moveWork.push(Promise.resolve(work));
        return work;
      });
      let resuming = false;
      const nativeMutation = archiveMutations.withArchiveMutation;
      vi.spyOn(archiveMutations, "withArchiveMutation").mockImplementation((api, run) => {
        const work = nativeMutation(api, run);
        if (resuming) submitted.resolve();
        return work;
      });
      const transfers: Promise<void>[] = [];
      const resume = vi.fn(async (checkpoint: WireDownloadCheckpoint) => {
        if (mode === "resume-first") {
          entered.resolve();
          await release.promise;
        }
        await invokeMain("download:resume", checkpoint);
        transfers.push(manager.get(checkpoint.downloadId)!.promise);
      });
      const cancel = vi.fn((id: string) => invokeMain("download:cancel", id));
      const getStates = vi.fn(
        async (ids: string[]) =>
          (await invokeMain("download:getStates", ids)) as Record<string, WireDownloadState>,
      );
      const hashWork: Promise<{ hash: string; numBytes: number }>[] = [];
      const compute = vi.fn((algorithm: string, file: string) => {
        const work = readFile(file).then((bytes) => ({
          hash: createHash(algorithm).update(bytes).digest("hex"),
          numBytes: bytes.length,
        }));
        hashWork.push(work);
        return work;
      });
      Object.assign(window.api.downloader, { resume, cancel, getStates });
      window.api.hash = { compute };
      const completed = vi.fn();
      const finished = deferred<void>();
      h.api.events.on("did-finish-download", (id, state) => {
        completed(id, state);
        finished.resolve();
      });
      const resumed = vi.fn();
      let moving: Promise<void> | undefined;
      let retry: Promise<Error | null> | undefined;
      let duplicate: Promise<Error | null> | undefined;
      let removal: ReturnType<typeof publicRemove> | undefined;
      try {
        if (!["unchanged", "resume-first"].includes(mode)) {
          moving = h.emitAndAwait("set-download-games", "old", ["next-game"], false);
          if (mode === "queued") await entered.promise;
          else await moving;
          if (mode === "twice")
            await h.emitAndAwait("set-download-games", "old", ["final-game"], true);
        }
        resuming = true;
        retry = new Promise((resolve) =>
          h.api.events.emit("resume-download", "old", (error, id) => {
            resumed(error, id);
            resolve(error);
          }),
        );
        if (mode === "duplicate")
          duplicate = new Promise((resolve) =>
            h.api.events.emit("resume-download", "old", (error, id) => {
              resumed(error, id);
              resolve(error);
            }),
          );
        if (mode === "queued") {
          await Promise.race([
            submitted.promise,
            retry.then(async () => {
              await Promise.all(transfers);
              await manager.get("old")?.waitForWrites();
            }),
          ]);
          release.resolve();
        }
        if (mode === "resume-first") {
          await entered.promise;
          moving = h.emitAndAwait("set-download-games", "old", ["next-game"], false);
          release.resolve();
        }
        await retry;
        if (duplicate) await duplicate;
        if (moving) await moving;
        await Promise.all(moveWork);
        await Promise.all(transfers);
        await manager.get("old")!.waitForWrites();
        const writerPath = resume.mock.calls[0][0].dest;
        const startedRow = h.getState().persistent.downloads.files.old;
        const startedPath = path.join(root, startedRow.game[0], startedRow.localPath!);
        const checkpointPath = h.getState().persistent.downloads.checkpoints.old.dest;
        if (outcome === "finish") {
          await vi.advanceTimersByTimeAsync(200);
          await finished.promise;
        }
        const row = h.getState().persistent.downloads.files.old;
        const rowPath = path.join(root, row.game[0], row.localPath!);
        const bytes = await readFile(rowPath);
        removal = publicRemove(h, "old");
        await removal.promise;
        await Promise.all(hashWork);
        await withArchiveMutation(h.api, async () => undefined);
        expect(await retry).toBeNull();
        if (mode === "duplicate") {
          expect(await duplicate).toBeNull();
          expect(resumed.mock.calls).toEqual([
            [null, "old"],
            [null, "old"],
          ]);
        } else expect(resumed).toHaveBeenCalledExactlyOnceWith(null, "old");
        expect(resume).toHaveBeenCalledTimes(1);
        expect(transfers).toHaveLength(1);
        expect(manager.numPending).toBe(0);
        expect(manager.numRunning).toBe(0);
        expect(manager.getState("old")!.status).toBe("completed");
        expect(startedPath).toBe(writerPath);
        expect(checkpointPath).toBe(writerPath);
        if (mode !== "collision" || outcome !== "finish") expect(rowPath).toBe(writerPath);
        expect(bytes).toEqual(complete);
        expect(server.requests).toEqual([
          { method: "HEAD", range: undefined },
          { method: "GET", range: `bytes=${prefix.length}-${complete.length - 1}` },
        ]);
        expect(await removal.promise).toBeNull();
        expect(removal.callback).toHaveBeenCalledExactlyOnceWith(null);
        expect(h.errorNotifications).toEqual([]);
        expect(Object.keys(h.getState().persistent.downloads.files)).toEqual(
          mode === "shared" ? ["peer"] : [],
        );
        expect(h.getState().persistent.downloads.checkpoints).toEqual({});
        if (outcome === "finish") {
          expect(row.state).toBe("finished");
          expect(row.fileMD5).toBe(createHash("md5").update(complete).digest("hex"));
          expect(completed).toHaveBeenCalledExactlyOnceWith("old", "finished");
          expect(getStates).toHaveBeenCalledExactlyOnceWith(["old"]);
          expect(compute).toHaveBeenCalledExactlyOnceWith("md5", rowPath);
          expect(cancel).not.toHaveBeenCalled();
        } else {
          expect(completed).not.toHaveBeenCalled();
          expect(compute).not.toHaveBeenCalled();
          expect(cancel).toHaveBeenCalledExactlyOnceWith("old");
        }
        if (mode === "shared") expect(await readFile(destination)).toEqual(prefix);
        if (mode === "file-alias") expect(await readFile(externalPath)).toEqual(prefix);
        if (mode === "collision")
          expect(await readFile(collisionPath, "utf8")).toBe("unrelated newer archive");
        if (mode === "resume-first") expect(row.game).toEqual([GAME]);
        await expect(stat(writerPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(stat(rowPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readdir(path.dirname(rowPath))).toEqual(
          mode === "collision" ? ["archive.zip"] : [],
        );
        expect(await readdir(path.join(root, GAME))).toEqual(
          mode === "shared" ? ["archive.zip"] : [],
        );
        if (mode === "twice") expect(await readdir(path.join(root, "next-game"))).toEqual([]);
        const checked = path.join(root, "checked.zip");
        await writeFile(checked, bytes);
        const extracted = path.join(root, "checked");
        await new Zip().extractFull(checked, extracted);
        expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe(
          "replacement payload",
        );
      } finally {
        release.resolve();
        if (moving) await moving;
        if (retry) await retry;
        if (duplicate) await duplicate;
        manager.get("old")?.cancel();
        await Promise.allSettled(transfers);
        await manager.get("old")?.waitForWrites();
        if (!removal) removal = publicRemove(h, "old");
        await removal.promise;
        await Promise.all(moveWork);
        await Promise.all(hashWork);
        await withArchiveMutation(h.api, async () => undefined);
        await server.close();
      }
    });
  }
}

for (const previous of [false, true]) {
  for (const mode of [
    "success",
    "error",
    "twice",
    "collision",
    "peer",
    "newer",
    "removed",
    "unowned",
  ] as const) {
    it(`registration relocation recovery preserves ownership: previous=${previous}, ${mode}`, async () => {
      const { source, destination, oldBytes } = await archives("file", previous);
      const replacement = await readFile(source);
      const h = setup(previous);
      if (mode === "collision") {
        await mkdir(path.join(root, "next-game"));
        await writeFile(path.join(root, "next-game", "archive.zip"), "collision bytes");
      }
      const metadataWork: Promise<void>[] = [];
      const metadataCallback = vi.fn();
      const metadataError =
        mode === "success" ? undefined : new Error("registration failed after relocation");
      const removedCallbacks: ReturnType<typeof publicRemove>[] = [];
      let relocatedPath: string;
      let importedId: string;
      const newer = path.join(root, "newer.zip");
      await writeFile(newer, "newer unowned bytes");
      const metadata = vi.fn((ids: string[], callback: (error?: Error) => void) => {
        const work = (async () => {
          importedId = ids[0];
          if (mode === "unowned") await rename(newer, destination);
          await h.emitAndAwait("set-download-games", importedId, ["next-game"], true);
          if (mode === "twice")
            await h.emitAndAwait("set-download-games", importedId, ["final-game"], true);
          const row = h.getState().persistent.downloads.files[importedId];
          relocatedPath = path.join(root, row.game[0], row.localPath!);
          if (mode === "peer")
            h.api.store.dispatch(
              addLocalDownload("peer", row.game[0], row.localPath!, replacement.length),
            );
          if (mode === "newer") await rename(newer, relocatedPath);
          if (mode === "removed") {
            const removal = publicRemove(h, importedId);
            removedCallbacks.push(removal);
            await removal.promise;
          }
          metadataCallback(metadataError);
          callback(metadataError);
        })();
        metadataWork.push(work);
      });
      h.api.events.removeAllListeners("did-import-downloads");
      h.api.events.on("did-import-downloads", metadata);
      const run = startImport(h, source);
      const ids = await run.promise;
      await Promise.all(metadataWork);
      await withArchiveMutation(h.api, async () => undefined);
      expect(metadata).toHaveBeenCalledTimes(1);
      expect(metadataWork).toHaveLength(1);
      expect(metadataCallback).toHaveBeenCalledExactlyOnceWith(metadataError);
      expect(metadata.mock.calls.map(([ids]) => ids)).toEqual([[importedId!]]);
      expect(run.callback).toHaveBeenCalledExactlyOnceWith(ids);
      expect(removedCallbacks).toHaveLength(mode === "removed" ? 1 : 0);
      expect(h.errorNotifications).toHaveLength(mode === "success" ? 0 : 1);
      for (const removal of removedCallbacks) {
        expect(await removal.promise).toBeNull();
        expect(removal.callback).toHaveBeenCalledExactlyOnceWith(null);
      }
      expect(await readFile(source)).toEqual(replacement);
      if (mode === "success") {
        expect(ids).toEqual([importedId!]);
        expect(Object.keys(h.getState().persistent.downloads.files)).toEqual(ids);
        expect(await readFile(relocatedPath!)).toEqual(replacement);
        expect(await readdir(path.dirname(destination))).toEqual([]);
        const removal = publicRemove(h, importedId!);
        expect(await removal.promise).toBeNull();
        expect(removal.callback).toHaveBeenCalledExactlyOnceWith(null);
      } else {
        expect(ids).toEqual([]);
        expect(Object.keys(h.getState().persistent.downloads.files).sort()).toEqual(
          [...(previous ? ["old"] : []), ...(mode === "peer" ? ["peer"] : [])].sort(),
        );
        if (mode === "unowned" && previous) {
          expect(await readFile(destination, "utf8")).toBe("newer unowned bytes");
          const files = await readdir(path.dirname(destination));
          const staging = files.filter((name) => name.startsWith("__vortex_tmp_"));
          expect(staging).toHaveLength(1);
          const backup = path.join(path.dirname(destination), staging[0], "previous");
          expect(await readFile(backup)).toEqual(oldBytes);
          expect(files.sort()).toEqual([staging[0], "archive.zip"].sort());
          expect(h.errorNotifications).toHaveLength(1);
          expect((h.errorNotifications[0].message as Error).message).toContain(backup);
        } else {
          if (previous) expect(await readFile(destination)).toEqual(oldBytes);
          expect(await readdir(path.dirname(destination))).toEqual(previous ? ["archive.zip"] : []);
        }
        if (mode === "peer") {
          expect(await readFile(relocatedPath!)).toEqual(replacement);
          const removal = publicRemove(h, "peer");
          expect(await removal.promise).toBeNull();
          expect(removal.callback).toHaveBeenCalledExactlyOnceWith(null);
          await expect(stat(relocatedPath!)).rejects.toMatchObject({ code: "ENOENT" });
        } else if (mode === "newer" || mode === "unowned") {
          expect(await readFile(relocatedPath!, "utf8").catch(getErrorCode)).toBe(
            "newer unowned bytes",
          );
        } else {
          await expect(stat(relocatedPath!)).rejects.toMatchObject({ code: "ENOENT" });
        }
        if (mode === "collision")
          expect(await readFile(path.join(root, "next-game", "archive.zip"), "utf8")).toBe(
            "collision bytes",
          );
        if (mode === "twice") expect(await readdir(path.join(root, "next-game"))).toEqual([]);
        if (mode === "error") {
          h.api.events.removeAllListeners("did-import-downloads");
          const liveMetadata = vi.fn((_ids: string[], callback: () => void) => callback());
          h.api.events.on("did-import-downloads", liveMetadata);
          const retry = startImport(h, source);
          const retryIds = await retry.promise;
          await withArchiveMutation(h.api, async () => undefined);
          expect(retryIds).toHaveLength(1);
          expect(retry.callback).toHaveBeenCalledExactlyOnceWith(retryIds);
          expect(liveMetadata).toHaveBeenCalledTimes(1);
          expect(await readFile(destination)).toEqual(replacement);
          expect(await readdir(path.dirname(destination))).toEqual(["archive.zip"]);
        }
      }
    });
  }
}

for (const rejected of [false, true]) {
  it(`late duplicate checkpoint callers await the same response: rejected=${rejected}`, async () => {
    const { destination, oldBytes } = await archives("file", true);
    const h = setup(true);
    h.setState((state) => {
      state.persistent.downloads.files.old.state = "started";
      state.persistent.downloads.checkpoints = {
        old: {
          downloadId: "old",
          resource: "https://example.invalid/archive.zip",
          dest: destination,
          completedRanges: [{ start: 0, end: 1 }],
          etag: undefined,
        },
      };
    });
    const entered = deferred<void>();
    const release = deferred<void>();
    const error = new Error("resume unavailable");
    const responseWork: Promise<void>[] = [];
    const resume = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementation(() => {
        const work = (async () => {
          entered.resolve();
          await release.promise;
          if (rejected) throw error;
        })();
        responseWork.push(work);
        return work;
      });
    const configure = vi.fn().mockResolvedValue(undefined);
    const cancel = vi.fn().mockResolvedValue(undefined);
    Object.assign(window.api.downloader, { resume, configure, cancel });
    await h.adapter.hydrateFromState();
    h.api.store.dispatch(pauseDownload("old", true));
    const callback = vi.fn();
    const run = () =>
      new Promise<Error | null>((resolve) =>
        h.api.events.emit("resume-download", "old", (result, id) => {
          callback(result, id);
          resolve(result);
        }),
      );
    const original = run();
    let duplicate: Promise<Error | null> | undefined;
    let callbacksBeforeRelease: number;
    try {
      await entered.promise;
      duplicate = run();
      await withArchiveMutation(h.api, async () => undefined);
      callbacksBeforeRelease = callback.mock.calls.length;
    } finally {
      release.resolve();
      await original;
      if (duplicate) await duplicate;
      await Promise.allSettled(responseWork);
    }
    const stateBeforeRemoval = h.getState().persistent.downloads.files.old.state;
    const pauseCount = h.getState().persistent.downloads.files.old.pauseCount;
    const bytesBeforeRemoval = await readFile(destination);
    const removal = publicRemove(h, "old");
    await removal.promise;
    await withArchiveMutation(h.api, async () => undefined);
    expect(callbacksBeforeRelease!).toBe(0);
    expect(await original).toBe(rejected ? error : null);
    expect(await duplicate).toBe(rejected ? error : null);
    expect(callback.mock.calls).toEqual(
      rejected
        ? [
            [error, undefined],
            [error, undefined],
          ]
        : [
            [null, "old"],
            [null, "old"],
          ],
    );
    expect(responseWork).toHaveLength(1);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(configure).toHaveBeenCalledTimes(1);
    expect(stateBeforeRemoval).toBe(rejected ? "paused" : "init");
    expect(pauseCount).toBe(1);
    expect(bytesBeforeRemoval).toEqual(oldBytes);
    expect(await removal.promise).toBeNull();
    expect(removal.callback).toHaveBeenCalledExactlyOnceWith(null);
    if (rejected) expect(cancel).not.toHaveBeenCalled();
    else expect(cancel).toHaveBeenCalledExactlyOnceWith("old");
    expect(h.getState().persistent.downloads.files).toEqual({});
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
}
