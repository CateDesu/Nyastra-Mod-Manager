import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import PromiseBB from "bluebird";
import Zip from "node-7z";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { IPCDownloadAdapter } from "../../IPCDownloadAdapter";
import { makeApiHarness, makeDownload, makeProfile } from "../../test-utils/builders";
import type { IExtensionContext } from "../../types/IExtensionContext";
import * as fs from "../../util/fs";
import init from "./index";

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
let root: string;
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

for (const kind of ["file", "directory"] as const) {
  for (const previous of [false, true]) {
    for (const outcome of ["removed", "registration-error", "committed"] as const) {
      it(`settles ${kind} registration and cleanup with previous=${previous}, ${outcome}`, async () => {
        const { source, oldBytes } = await archives(kind, previous);
        // Directory imports use 7z for the destination archive.
        const destination = path.join(root, GAME, kind === "file" ? "archive.zip" : "archive.7z");
        if (kind === "directory" && previous) {
          await fs.renameAsync(path.join(root, GAME, "archive.zip"), destination);
        }
        const h = setup(previous);
        if (kind === "directory" && previous) {
          h.setState((state) => {
            state.persistent.downloads.files.old.localPath = "archive.7z";
          });
        }
        const existing = h.getState().persistent.downloads.files.old;
        const pending = registration(h);
        const run = startImport(h, source);
        const removed = vi.fn();
        try {
          const id = await pending.entered.promise;
          expect(run.callback).not.toHaveBeenCalled();
          expect(
            h.notifications.some((notification) => notification.title === "File imported"),
          ).toBe(false);
          expect(await readdir(path.dirname(destination))).toHaveLength(2);
          expect(h.getState().persistent.downloads.files[id]).toBeDefined();
          if (previous) expect(h.getState().persistent.downloads.files.old).toEqual(existing);
          if (outcome === "removed") {
            const error = await new Promise<Error | null>((resolve) =>
              h.api.events.emit("remove-download", id, (result) => {
                removed(result);
                resolve(result);
              }),
            );
            expect(error).toBeNull();
            expect(removed).toHaveBeenCalledExactlyOnceWith(null);
            expect(h.getState().persistent.downloads.files[id]).toBeUndefined();
            expect(run.callback).not.toHaveBeenCalled();
          }
        } finally {
          pending.gate.resolve(
            outcome === "registration-error" ? new Error("metadata failed") : undefined,
          );
          await Promise.all(pending.work);
          await run.promise;
        }
        const ids = await run.promise;
        expect(run.callback).toHaveBeenCalledExactlyOnceWith(ids);
        const files = h.getState().persistent.downloads.files;
        if (outcome === "committed") {
          expect(ids).toHaveLength(1);
          expect(Object.keys(files)).toEqual(ids);
          const extracted = path.join(root, "extracted");
          await new Zip().extractFull(destination, extracted);
          expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe(
            "replacement payload",
          );
          const deleted = await new Promise<Error | null>((resolve) =>
            h.api.events.emit("remove-download", ids[0], resolve),
          );
          expect(deleted).toBeNull();
          expect(h.getState().persistent.downloads.files).toEqual({});
          await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(ids).toEqual([]);
          expect(Object.keys(files)).toEqual(previous ? ["old"] : []);
          if (previous) {
            expect(files.old).toMatchObject(existing);
            expect(await readFile(destination)).toEqual(oldBytes);
          } else await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
          expect(
            h.notifications.some((notification) => notification.title === "File imported"),
          ).toBe(false);
          expect(h.errorNotifications).toHaveLength(1);
          const retryGate = registration(h);
          const retry = startImport(h, source);
          try {
            await retryGate.entered.promise;
            expect(retry.callback).not.toHaveBeenCalled();
          } finally {
            retryGate.gate.resolve(undefined);
            await Promise.all(retryGate.work);
            await retry.promise;
          }
          const retryIds = await retry.promise;
          expect(retryIds).toHaveLength(1);
          expect(retry.callback).toHaveBeenCalledExactlyOnceWith(retryIds);
          expect(Object.keys(h.getState().persistent.downloads.files)).toEqual(retryIds);
          const extracted = path.join(root, "retry-extracted");
          await new Zip().extractFull(destination, extracted);
          expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe(
            "replacement payload",
          );
        }
        expect(
          (await readdir(path.dirname(destination))).filter((name) =>
            name.startsWith("__vortex_tmp_"),
          ),
        ).toEqual([]);
      });
    }
  }
}

it("retains the backup and reports its path if removed-row rollback cannot restore it", async () => {
  const { source, destination, oldBytes } = await archives("file", true);
  const h = setup(true);
  const pending = registration(h);
  const run = startImport(h, source);
  try {
    const id = await pending.entered.promise;
    const deleted = await new Promise<Error | null>((resolve) =>
      h.api.events.emit("remove-download", id, resolve),
    );
    expect(deleted).toBeNull();
    await chmod(path.dirname(destination), 0o500);
    expect(run.callback).not.toHaveBeenCalled();
    pending.gate.resolve(undefined);
    await Promise.all(pending.work);
    expect(await run.promise).toEqual([]);
    expect(run.callback).toHaveBeenCalledExactlyOnceWith([]);
  } finally {
    await chmod(path.dirname(destination), 0o700);
    pending.gate.resolve(undefined);
    await Promise.all(pending.work);
    await run.promise;
  }
  const staging = (await readdir(path.dirname(destination))).filter((name) =>
    name.startsWith("__vortex_tmp_"),
  );
  expect(staging).toHaveLength(1);
  const backup = path.join(path.dirname(destination), staging[0], "previous");
  expect(await readFile(backup)).toEqual(oldBytes);
  expect(Object.keys(h.getState().persistent.downloads.files)).toEqual(["old"]);
  expect(h.errorNotifications).toHaveLength(1);
  const error = h.errorNotifications[0].message as AggregateError;
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.message).toContain(backup);
  expect(error.errors[1]).toMatchObject({ code: "EACCES" });
});
