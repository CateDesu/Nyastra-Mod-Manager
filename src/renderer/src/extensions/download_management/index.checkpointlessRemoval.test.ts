import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { UserCanceled } from "@vortex/shared/errors";
import PromiseBB from "bluebird";
import Zip from "node-7z";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { IPCDownloadAdapter } from "../../IPCDownloadAdapter";
import { downloadsReducer } from "../../reducers/downloads";
import { makeApiHarness, makeDownload, makeProfile } from "../../test-utils/builders";
import type { IExtensionContext } from "../../types/IExtensionContext";
import * as fs from "../../util/fs";
import init from "./index";
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

const { mainHandlers, resolveResource } = vi.hoisted(() => ({
  mainHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  resolveResource: vi.fn(),
}));
vi.mock("../../../../main/src/ipc", () => ({
  betterIpcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mainHandlers.set(channel, handler),
    callback: resolveResource,
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

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const schedule of [
  "pending-resolution",
  "pending-response",
  "response-turn",
  "settled-response",
  "cancel-error",
  "cancel-user",
  "cleanup-directory",
] as const) {
  for (const duplicate of [false, true]) {
    for (const delayedWrites of [false, true]) {
      const cleanupFails = schedule.startsWith("cancel-") || schedule === "cleanup-directory";
      if (cleanupFails && (duplicate || delayedWrites)) continue;
      it(`checkpointless removal drains native work: ${schedule}, duplicate=${duplicate}, delayedWrites=${delayedWrites}`, async () => {
        const { source, destination } = await archives("file", false);
        const complete = await readFile(source);
        await writeFile(destination, complete.subarray(0, 16));
        const h = setup(true);
        h.setState((state) => {
          Object.assign(state.persistent.downloads.files.old, {
            state: "paused",
            received: 16,
            size: complete.length,
          });
          state.persistent.downloads.checkpoints = {};
        });
        const manager = await nativeDownloader();
        const resolving = deferred<void>();
        const admitted = deferred<void>();
        const releaseResolution = deferred<void>();
        const releaseResponse = deferred<void>();
        const releaseBody = deferred<void>();
        const writesEntered = deferred<void>();
        let cancelSubscribed = deferred<void>();
        const releaseWrites = deferred<void>();
        const removalEntered = deferred<void>();
        const serverWork: Promise<void>[] = [];
        const requests: Array<{ method: string; range?: string }> = [];
        const http = await import("node:http");
        const server = http.createServer((request, response) => {
          requests.push({ method: request.method!, range: request.headers.range });
          response.writeHead(200, {
            "content-length": complete.length,
            "content-type": "application/zip",
          });
          if (request.method === "HEAD") response.end();
          else {
            response.flushHeaders();
            admitted.resolve();
            serverWork.push(
              releaseBody.promise.then(() => {
                response.end(complete);
              }),
            );
          }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as { port: number };
        h.setState((state) => {
          state.persistent.downloads.files.old.urls = [
            `http://127.0.0.1:${address.port}/archive.zip`,
          ];
        });
        const resolver = vi.mocked(window.api.downloader.onResolve).mock.calls[0][0];
        const work: Promise<unknown>[] = [];
        const transfers: Promise<void>[] = [];
        const track = <T>(operation: Promise<T>) => {
          work.push(operation);
          void operation.catch(() => undefined);
          return operation;
        };
        resolveResource.mockImplementation((_channel, _sender, _timeout, collationId) =>
          track(
            (async () => {
              resolving.resolve();
              if (schedule === "pending-resolution") await releaseResolution.promise;
              return resolver(collationId);
            })(),
          ),
        );
        let removal: ReturnType<typeof publicRemove> | undefined;
        let secondRemoval: ReturnType<typeof publicRemove> | undefined;
        let cleanedAtRemoval = false;
        let nativeCleaned = false;
        const remove = () => {
          const result = publicRemove(h, "old");
          track(
            result.promise.then(() => {
              cleanedAtRemoval = nativeCleaned;
            }),
          );
          return result;
        };
        const start = vi.fn((dest: string, collationId: number, id: string) => {
          const response = track(
            (async () => {
              const result = await invokeMain("download:start", dest, collationId, id);
              const handle = manager.get(id)!;
              transfers.push(handle.promise);
              void handle.promise.catch(() => undefined);
              const wait = handle.waitForWrites.bind(handle);
              vi.spyOn(handle, "waitForWrites").mockImplementation(async () => {
                writesEntered.resolve();
                if (delayedWrites) await releaseWrites.promise;
                await wait();
              });
              if (schedule !== "settled-response") await releaseResponse.promise;
              return result;
            })(),
          );
          if (schedule === "response-turn")
            void response.then(() =>
              queueMicrotask(() => {
                removal = remove();
                if (duplicate) secondRemoval = remove();
                removalEntered.resolve();
              }),
            );
          return response;
        });
        const cancellationError =
          schedule === "cancel-user" ? new UserCanceled() : new Error("cancel IPC unavailable");
        let nativeCleanupError: unknown;
        const cancel = vi.fn((id: string) =>
          track(
            (async () => {
              if (schedule.startsWith("cancel-") && cancel.mock.calls.length === 1)
                throw cancellationError;
              try {
                await invokeMain("download:cancel", id);
              } catch (error) {
                nativeCleanupError = error;
                throw error;
              }
              nativeCleaned = true;
            })(),
          ),
        );
        Object.assign(window.api.downloader, {
          start,
          cancel: (id: string) =>
            new Proxy(cancel(id), {
              get(target, key) {
                if (key === "then")
                  return (...args: Parameters<typeof target.then>) => {
                    cancelSubscribed.resolve();
                    return target.then(...args);
                  };
                const value: unknown = Reflect.get(target, key, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
        });
        const metadata = vi.fn((_ids: string[], callback: () => void) => callback());
        h.api.events.removeAllListeners("did-import-downloads");
        h.api.events.on("did-import-downloads", metadata);
        const resumeCallback = vi.fn();
        const resume = () =>
          track(
            new Promise<Error | null>((resolve) =>
              h.api.events.emit("resume-download", "old", (error, id) => {
                resumeCallback(error, id);
                resolve(error);
              }),
            ),
          );
        const race = Promise.race.bind(Promise);
        let capturing = true;
        let restoreWork: Promise<unknown> | undefined;
        vi.spyOn(Promise, "race").mockImplementation((operations) => {
          const values = Array.from(operations);
          if (capturing) {
            capturing = false;
            // Retain the original restart passed to the caller's cancellation race.
            restoreWork = track(Promise.resolve(values[0]));
          }
          return race(values);
        });
        const resumed = resume();
        capturing = false;
        let second: Promise<Error | null> | undefined;
        let imported: ReturnType<typeof startImport> | undefined;
        const drain = async () => {
          let count = -1;
          while (count !== work.length + transfers.length + serverWork.length) {
            count = work.length + transfers.length + serverWork.length;
            await Promise.allSettled([...work, ...transfers, ...serverWork]);
            await withArchiveMutation(h.api, async () => undefined);
            await tick();
          }
        };
        try {
          await resolving.promise;
          if (schedule !== "pending-resolution") await admitted.promise;
          if (schedule === "settled-response") await resumed;
          if (duplicate) second = resume();
          if (schedule === "cleanup-directory") {
            await rm(destination);
            await mkdir(destination);
          }
          if (schedule === "response-turn") {
            releaseResponse.resolve();
            await removalEntered.promise;
          } else {
            removal = remove();
            if (duplicate) secondRemoval = remove();
          }
          if (
            schedule === "pending-resolution" ||
            schedule === "pending-response" ||
            cleanupFails
          ) {
            await resumed;
            await second;
          }
          await withArchiveMutation(h.api, async () => undefined);
          await tick();
          const callbacksBeforeResponse = removal!.callback.mock.calls.length;
          // Preserve an escaped removal's ordering so its obsolete native unlink stays observable.
          if (callbacksBeforeResponse > 0) {
            imported = startImport(h, source);
            await imported.promise;
          }
          releaseResolution.resolve();
          await admitted.promise;
          releaseResponse.resolve();
          let failedRemoval: ReturnType<typeof publicRemove> | undefined;
          let retainedAfterFailure = false;
          if (cleanupFails) {
            failedRemoval = removal;
            await failedRemoval!.promise;
            retainedAfterFailure = h.getState().persistent.downloads.files.old !== undefined;
            if (schedule === "cleanup-directory") await rm(destination, { recursive: true });
            cancelSubscribed = deferred<void>();
            removal = remove();
          }
          const boundary = await Promise.race([
            cancelSubscribed.promise.then(() => "canceling"),
            removal!.promise.then(() => "removed"),
          ]);
          if (boundary === "removed" && !nativeCleaned) {
            releaseWrites.resolve();
            await invokeMain("download:cancel", "old");
          }
          await writesEntered.promise;
          await withArchiveMutation(h.api, async () => undefined);
          await tick();
          const callbacksBeforeWrites = removal!.callback.mock.calls.length;
          releaseWrites.resolve();
          await resumed;
          await second;
          await removal!.promise;
          await secondRemoval?.promise;
          releaseBody.resolve();
          await drain();
          if (!imported) {
            imported = startImport(h, source);
            await imported.promise;
            await drain();
          }
          const ids = await imported.promise;
          const actual = await readFile(destination).catch(() => null);
          expect(restoreWork).toBeDefined();
          expect
            .soft(actual, "obsolete native cleanup must finish before the destination is reused")
            .toEqual(complete);
          expect.soft(cleanedAtRemoval).toBe(true);
          if (schedule === "pending-resolution" || schedule === "pending-response" || cleanupFails)
            expect.soft(callbacksBeforeResponse).toBe(0);
          if (delayedWrites) expect.soft(callbacksBeforeWrites).toBe(0);
          expect(removal!.callback).toHaveBeenCalledExactlyOnceWith(null);
          if (secondRemoval) expect(secondRemoval.callback).toHaveBeenCalledExactlyOnceWith(null);
          if (failedRemoval) {
            expect(failedRemoval.callback).toHaveBeenCalledExactlyOnceWith(
              schedule === "cleanup-directory" ? nativeCleanupError : cancellationError,
            );
            if (schedule === "cleanup-directory")
              expect(nativeCleanupError).toMatchObject({ code: "ERR_FS_EISDIR" });
            expect(retainedAfterFailure).toBe(true);
          }
          expect(imported.callback).toHaveBeenCalledExactlyOnceWith(ids);
          expect(metadata).toHaveBeenCalledTimes(1);
          expect(ids).toHaveLength(1);
          expect(start).toHaveBeenCalledExactlyOnceWith(destination, expect.any(Number), "old");
          expect(cancel.mock.calls).toEqual(
            Array.from({ length: cleanupFails ? 2 : 1 }, () => ["old"]),
          );
          expect(resumeCallback).toHaveBeenCalledTimes(duplicate ? 2 : 1);
          for (const [error, id] of resumeCallback.mock.calls) {
            if (schedule === "settled-response") {
              expect(error).toBeNull();
              expect(id).toBe("old");
            } else expect(error).toBeInstanceOf(UserCanceled);
          }
          expect(manager.getState("old")?.status).toBe("canceled");
          expect(manager.numRunning).toBe(0);
          expect(manager.numPending).toBe(0);
          expect(transfers).toHaveLength(1);
          await expect(transfers[0]).resolves.toBeUndefined();
          expect(requests).toEqual([
            { method: "HEAD", range: undefined },
            { method: "GET", range: undefined },
          ]);
          expect(Object.keys(h.getState().persistent.downloads.files)).toEqual(ids);
          expect(h.getState().persistent.downloads.files[ids[0]].state).toBe("finished");
          expect(h.getState().persistent.downloads.checkpoints).toEqual({});
          expect(await readFile(source)).toEqual(complete);
          expect(
            (await readdir(path.dirname(destination))).filter((name) => name.startsWith(".")),
          ).toEqual([]);
          if (actual !== null) {
            const extracted = path.join(root, "verified-import");
            await new Zip().extractFull(destination, extracted);
            expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe(
              "replacement payload",
            );
          }
        } finally {
          releaseResolution.resolve();
          releaseResponse.resolve();
          releaseWrites.resolve();
          releaseBody.resolve();
          manager.get("old")?.cancel();
          await drain();
          await Promise.allSettled([removal?.promise, secondRemoval?.promise, imported?.promise]);
          await manager.get("old")?.waitForWrites();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          h.api.events.removeAllListeners();
        }
      });
    }
  }
}

it("removes a checkpointless restart before archive queue admission", async () => {
  const { destination } = await archives("file", true);
  const h = setup(true);
  h.setState((state) => {
    state.persistent.downloads.files.old.state = "paused";
  });
  const entered = deferred<void>();
  const release = deferred<void>();
  const queue = withArchiveMutation(h.api, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const start = vi.fn();
  const cancel = vi.fn();
  Object.assign(window.api.downloader, { start, cancel });
  const callback = vi.fn();
  const resumed = new Promise<Error | null>((resolve) =>
    h.api.events.emit("resume-download", "old", (error, id) => {
      callback(error, id);
      resolve(error);
    }),
  );
  const removed = publicRemove(h, "old");
  release.resolve();
  await queue;
  await resumed;
  await removed.promise;
  await withArchiveMutation(h.api, async () => undefined);
  expect(callback).toHaveBeenCalledExactlyOnceWith(expect.any(UserCanceled), undefined);
  expect(start).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  expect(removed.callback).toHaveBeenCalledExactlyOnceWith(null);
  expect(h.getState().persistent.downloads.files).toEqual({});
  expect(await readdir(path.dirname(destination))).toEqual([]);
});
