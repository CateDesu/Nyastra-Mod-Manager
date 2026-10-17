import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { UserCanceled } from "@vortex/shared/errors";
import type { WireDownloadState } from "@vortex/shared/ipc";
import { afterEach, beforeEach, describe, expect, type Mock, vi } from "vitest";

const paths = vi.hoisted(() => ({ root: "" }));
vi.mock("./util/getVortexPath", () => ({ default: () => paths.root }));

import { test, type IDownloadAdapterFixtures } from "./test-utils/downloadAdapterTest";
import type { IDownloadAdapterHarness } from "./test-utils/harnessTypes";

const completed: WireDownloadState = {
  status: "completed",
  bytesReceived: 3,
  bytesWritten: 3,
  size: 3,
  fileName: "archive.7z",
  isChunked: false,
  error: null,
};

describe("download finalization", () => {
  beforeEach(async () => {
    paths.root = await mkdtemp(path.join(tmpdir(), "nyastra-finalize-"));
  });
  afterEach(async () => {
    await rm(paths.root, { recursive: true, force: true });
  });

  const finish = async (
    h: IDownloadAdapterHarness,
    ids = [h.downloadId],
    hydrate = true,
    fileName = completed.fileName,
  ) => {
    window.api.hash = {
      compute: async (algorithm, filePath) => {
        const bytes = await readFile(filePath);
        return { hash: createHash(algorithm).update(bytes).digest("hex"), numBytes: bytes.length };
      },
    };
    const pending = new Set(ids);
    const finished = new Promise<void>((resolve) => {
      h.events.on("did-finish-download", (id) => {
        pending.delete(id);
        if (pending.size === 0) resolve();
      });
    });
    h.getStates.mockResolvedValue(
      Object.fromEntries(ids.map((id) => [id, { ...completed, fileName }])),
    );
    if (hydrate) h.adapter.hydrateFromState();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.getStates).toHaveBeenCalled();
    await finished;
  };

  const seed = (makeDownloadAdapter: IDownloadAdapterFixtures["makeDownloadAdapter"]) =>
    makeDownloadAdapter({
      download: { state: "started", localPath: "__vortex_tmp_fixture" },
      checkpoint: {
        downloadId: "",
        resource: "https://cdn.example/archive.7z",
        dest: "unused",
        completedRanges: [{ start: 0, end: 2 }],
        etag: undefined,
      },
    });

  const startFresh = async (h: IDownloadAdapterHarness, mode: "replace" | "ask" | "always") => {
    const directory = path.dirname(h.dest);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "archive.7z"), "old");
    h.setNextDialog({ action: "Re-download", input: {} });
    const callbackSpy = vi.fn();
    const callback = new Promise<{ err: Error | null; id?: string }>((resolve) => {
      h.events.emit(
        "start-download",
        ["https://cdn.example/archive.7z"],
        { game: "skyrimse" },
        "archive.7z",
        (err, id) => {
          callbackSpy(err, id);
          resolve({ err, id });
        },
        mode,
      );
    });
    await h.started.promise;
    const { downloadId } = await h.start.mock.results[0].value;
    await Promise.resolve();
    return {
      directory,
      downloadId: downloadId as string,
      temporary: h.start.mock.calls[0][0] as string,
      callback,
      callbackSpy,
    };
  };

  const holdHash = () => {
    const entered = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    window.api.hash = {
      compute: async (algorithm, filePath) => {
        const bytes = await readFile(filePath);
        entered.resolve(filePath);
        await release.promise;
        return { hash: createHash(algorithm).update(bytes).digest("hex"), numBytes: bytes.length };
      },
    };
    return { entered: entered.promise, release: () => release.resolve() };
  };

  for (const source of ["network", "browser"] as const) {
    test(`removing a ${source} download during hashing cancels completion and removes its archive`, async ({
      makeDownloadAdapter,
    }) => {
      const h = makeDownloadAdapter({ automationInstall: true });
      const hash = holdHash();
      const finished = vi.fn();
      const installed = vi.fn();
      h.events.on("did-finish-download", finished);
      h.events.on("start-install-download", installed);
      let callbackSpy: Mock<(err: Error | null, id?: string) => void>;
      let result: Promise<{ err: Error | null; id?: string }>;
      if (source === "network") {
        const started = await startFresh(h, "always");
        callbackSpy = started.callbackSpy;
        result = started.callback;
        await writeFile(started.temporary, "new");
        h.getStates.mockResolvedValue({ [started.downloadId]: completed });
        await vi.advanceTimersByTimeAsync(200);
      } else {
        await writeFile(path.join(paths.root, "archive.7z.tmp"), "new");
        callbackSpy = vi.fn();
        result = new Promise((resolve) => {
          h.events.emit(
            "start-download",
            ["blob:https://example.com/file|archive.7z"],
            { game: "skyrimse" },
            undefined,
            (err, id) => {
              callbackSpy(err, id);
              resolve({ err, id });
            },
          );
        });
      }
      const archive = await hash.entered;
      const id = Object.keys(h.getState().persistent.downloads.files).find(
        (downloadId) => downloadId !== h.downloadId,
      )!;
      const removed = Promise.all(
        [0, 1].map(
          () =>
            new Promise<Error | null>((resolve) => h.events.emit("remove-download", id, resolve)),
        ),
      );
      hash.release();
      expect(await removed).toEqual([null, null]);
      expect((await result).err).toBeInstanceOf(UserCanceled);
      expect(callbackSpy).toHaveBeenCalledTimes(1);
      expect(h.getState().persistent.downloads.files[id]).toBeUndefined();
      await expect(access(archive)).rejects.toMatchObject({ code: "ENOENT" });
      expect(finished).not.toHaveBeenCalled();
      expect(installed).not.toHaveBeenCalled();
    });
  }

  test("removing a paused download settles its original completion callback", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter();
    const started = await startFresh(h, "always");
    await writeFile(started.temporary, "partial");
    window.api.downloader.pause = vi.fn().mockResolvedValue({
      downloadId: started.downloadId,
      resource: "https://cdn.example/archive.7z",
      dest: started.temporary,
      completedRanges: [{ start: 0, end: 2 }],
      etag: undefined,
    });
    await new Promise<void>((resolve) =>
      h.events.emit("pause-download", started.downloadId, () => resolve()),
    );
    await new Promise<void>((resolve) =>
      h.events.emit("remove-download", started.downloadId, () => resolve()),
    );
    expect(started.callbackSpy).toHaveBeenCalledExactlyOnceWith(
      expect.any(UserCanceled),
      started.downloadId,
    );
    await expect(access(started.temporary)).rejects.toMatchObject({ code: "ENOENT" });
    expect(h.getState().persistent.downloads.files[started.downloadId]).toBeUndefined();
  });

  test("does not restart an archive while finalization is still hashing it", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter();
    const hash = holdHash();
    const started = await startFresh(h, "always");
    await writeFile(started.temporary, "new");
    h.getStates.mockResolvedValue({ [started.downloadId]: completed });
    await vi.advanceTimersByTimeAsync(200);
    const archive = await hash.entered;
    try {
      await new Promise<void>((resolve) =>
        h.events.emit("resume-download", started.downloadId, () => resolve()),
      );
      expect(h.start).toHaveBeenCalledTimes(1);
      expect(await readFile(archive, "utf8")).toBe("new");
    } finally {
      hash.release();
      await started.callback;
    }
  });

  test("reports a removal failure during hashing and permits cleanup to be retried", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ automationInstall: true });
    const hash = holdHash();
    const started = await startFresh(h, "always");
    const installed = vi.fn();
    h.events.on("start-install-download", installed);
    await writeFile(started.temporary, "new");
    h.getStates.mockResolvedValue({ [started.downloadId]: completed });
    await vi.advanceTimersByTimeAsync(200);
    const archive = await hash.entered;
    await rm(archive);
    await mkdir(archive);
    const remove = () =>
      new Promise<Error | null>((resolve) =>
        h.events.emit("remove-download", started.downloadId, resolve),
      );
    const removed = remove();
    hash.release();
    expect(await removed).toBeInstanceOf(Error);
    expect((await started.callback).err).toBeInstanceOf(Error);
    expect(h.getState().persistent.downloads.files[started.downloadId].state).toBe("failed");
    await rm(archive, { recursive: true });
    expect(await remove()).toBeNull();
    expect(started.callbackSpy).toHaveBeenCalledTimes(1);
    expect(installed).not.toHaveBeenCalled();
    expect(h.getState().persistent.downloads.files[started.downloadId]).toBeUndefined();
  });

  test("retains the completion callback when canceling the running transfer fails", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter();
    const started = await startFresh(h, "always");
    await writeFile(started.temporary, "new");
    const error = new Error("cancel unavailable");
    vi.mocked(window.api.downloader.cancel).mockRejectedValueOnce(error);
    expect(
      await new Promise<Error | null>((resolve) =>
        h.events.emit("remove-download", started.downloadId, resolve),
      ),
    ).toBe(error);
    expect(started.callbackSpy).not.toHaveBeenCalled();
    await finish(h, [started.downloadId], false);
    expect(started.callbackSpy).toHaveBeenCalledExactlyOnceWith(null, started.downloadId);
  });

  for (const status of ["completed", "failed", "paused"] as const) {
    test(`removes a transfer that became ${status} before its next poll`, async ({
      makeDownloadAdapter,
    }) => {
      const h = makeDownloadAdapter({ automationInstall: true });
      const started = await startFresh(h, "always");
      await writeFile(started.temporary, "new");
      const installed = vi.fn();
      h.events.on("start-install-download", installed);
      const cancel = Promise.withResolvers<void>();
      vi.mocked(window.api.downloader.cancel).mockReturnValueOnce(cancel.promise);
      h.getStates.mockResolvedValue({ [started.downloadId]: { ...completed, status } });
      const removed = new Promise<Error | null>((resolve) =>
        h.events.emit("remove-download", started.downloadId, resolve),
      );
      await vi.advanceTimersByTimeAsync(200);
      cancel.resolve();
      expect(await removed).toBeNull();
      expect(h.getState().persistent.downloads.files[started.downloadId]).toBeUndefined();
      expect(started.callbackSpy).toHaveBeenCalledExactlyOnceWith(
        expect.any(UserCanceled),
        started.downloadId,
      );
      await expect(access(started.temporary)).rejects.toMatchObject({ code: "ENOENT" });
      expect(installed).not.toHaveBeenCalled();
    });
  }

  test("keeps a retryable record when cancellation succeeds but archive cleanup fails", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter();
    const started = await startFresh(h, "always");
    await mkdir(started.temporary);
    vi.mocked(window.api.downloader.cancel).mockRejectedValueOnce(new Error("cleanup failed"));
    h.getStates.mockResolvedValue({ [started.downloadId]: { ...completed, status: "canceled" } });
    const remove = () =>
      new Promise<Error | null>((resolve) =>
        h.events.emit("remove-download", started.downloadId, resolve),
      );
    expect(await remove()).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(200);
    expect((await started.callback).err).toBeInstanceOf(Error);
    expect(h.getState().persistent.downloads.files[started.downloadId]?.state).toBe("failed");
    await rm(started.temporary, { recursive: true });
    expect(await remove()).toBeNull();
    expect(h.getState().persistent.downloads.files[started.downloadId]).toBeUndefined();
    expect(started.callbackSpy).toHaveBeenCalledTimes(1);
  });

  for (const state of ["finished", "finalizing"] as const) {
    test(`leaves a persisted ${state} archive intact when bulk resume includes it`, async ({
      makeDownloadAdapter,
    }) => {
      const h = makeDownloadAdapter({ download: { state } });
      await mkdir(path.dirname(h.dest), { recursive: true });
      await writeFile(h.dest, "complete archive");
      const resumed = await new Promise<Error | null>((resolve) =>
        h.events.emit("resume-download", h.downloadId, resolve),
      );
      expect(resumed).toBeNull();
      expect(h.start).not.toHaveBeenCalled();
      expect(h.resume).not.toHaveBeenCalled();
      expect(await readFile(h.dest, "utf8")).toBe("complete archive");
      expect(h.getState().persistent.downloads.files[h.downloadId].state).toBe(state);
    });
  }

  test("does not resume a paused download while its archive is being removed", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { state: "paused" } });
    await mkdir(path.dirname(h.dest), { recursive: true });
    await writeFile(h.dest, "partial archive");
    const removed = new Promise<Error | null>((resolve) =>
      h.events.emit("remove-download", h.downloadId, resolve),
    );
    const resumed = new Promise<Error | null>((resolve) =>
      h.events.emit("resume-download", h.downloadId, resolve),
    );
    expect(await removed).toBeNull();
    expect(await resumed).toBeInstanceOf(UserCanceled);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.getState().persistent.downloads.files[h.downloadId]).toBeUndefined();
    await expect(access(h.dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not settle completion twice or install when its caller immediately removes the archive", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ automationInstall: true });
    const started = await startFresh(h, "always");
    const removed = Promise.withResolvers<void>();
    started.callbackSpy.mockImplementation((_err, id) => {
      h.events.emit("remove-download", id, () => removed.resolve());
    });
    const installed = vi.fn();
    h.events.on("start-install-download", installed);
    await writeFile(started.temporary, "new");
    await finish(h, [started.downloadId], false);
    await removed.promise;
    expect(started.callbackSpy).toHaveBeenCalledExactlyOnceWith(null, started.downloadId);
    expect(installed).not.toHaveBeenCalled();
    expect(h.getState().persistent.downloads.files[started.downloadId]).toBeUndefined();
  });

  for (const name of ["../escaped.7z", "nested\\escaped.7z", "/escaped.7z"]) {
    test(`stores the basename of the server filename ${name} inside the download folder`, async ({
      makeDownloadAdapter,
    }) => {
      const h = seed(makeDownloadAdapter);
      const directory = path.dirname(h.dest);
      await mkdir(directory, { recursive: true });
      await writeFile(h.dest, "new");
      await finish(h, [h.downloadId], true, name);
      const record = h.getState().persistent.downloads.files[h.downloadId];
      expect(record.state).toBe("finished");
      await expect(access(path.join(directory, "..", "escaped.7z"))).rejects.toThrow();
      expect(record.localPath).toBe("escaped.7z");
      expect(await readFile(path.join(directory, "escaped.7z"), "utf8")).toBe("new");
    });
  }

  for (const name of [".", "..", "nested/", "bad\u0000name.7z"]) {
    test(`fails finalization for an invalid server filename ${JSON.stringify(name)}`, async ({
      makeDownloadAdapter,
    }) => {
      const h = seed(makeDownloadAdapter);
      await mkdir(path.dirname(h.dest), { recursive: true });
      await writeFile(h.dest, "new");
      await finish(h, [h.downloadId], true, name);
      expect(h.getState().persistent.downloads.files[h.downloadId].state).toBe("failed");
      expect(await readFile(h.dest, "utf8")).toBe("new");
    });
  }

  test("preserves an existing archive when the server returns the same filename", async ({
    makeDownloadAdapter,
  }) => {
    const h = seed(makeDownloadAdapter);
    const directory = path.dirname(h.dest);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "archive.7z"), "old");
    await writeFile(h.dest, "new");
    await finish(h);
    expect(await readFile(path.join(directory, "archive.7z"), "utf8")).toBe("old");
    const record = h.getState().persistent.downloads.files[h.downloadId];
    expect(record.localPath).not.toBe("archive.7z");
    expect(await readFile(path.join(directory, record.localPath), "utf8")).toBe("new");
    expect(record.fileMD5).toBe(createHash("md5").update("new").digest("hex"));
  });

  test("retains the original completion callback after pausing before a range completes", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter();
    const started = await startFresh(h, "always");
    window.api.downloader.pause = vi.fn().mockResolvedValue({
      downloadId: started.downloadId,
      resource: "https://cdn.example/archive.7z",
      dest: started.temporary,
      completedRanges: [],
      etag: undefined,
    });
    await new Promise<void>((resolve) =>
      h.events.emit("pause-download", started.downloadId, () => resolve()),
    );
    const resumed = vi.fn();
    const restarted = new Promise<void>((resolve) => {
      h.start.mockImplementationOnce(async () => {
        resolve();
        return { downloadId: started.downloadId };
      });
    });
    h.events.emit("resume-download", started.downloadId, resumed);
    await restarted;
    await writeFile(started.temporary, "new");
    await finish(h, [started.downloadId], false);
    expect(started.callbackSpy).toHaveBeenCalledExactlyOnceWith(null, started.downloadId);
    expect(resumed).toHaveBeenCalledExactlyOnceWith(null, started.downloadId);
  });

  test("settles concurrent checkpointless resume callers after one restart", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { state: "paused" } });
    await mkdir(path.dirname(h.dest), { recursive: true });
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.start.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { downloadId: h.downloadId };
    });
    const callbacks = [vi.fn(), vi.fn()];
    h.events.emit("resume-download", h.downloadId, callbacks[0]);
    await entering;
    h.events.emit("resume-download", h.downloadId, callbacks[1]);
    release();
    await writeFile(h.dest, "new");
    await finish(h, [h.downloadId], false);
    expect(h.start).toHaveBeenCalledTimes(1);
    for (const callback of callbacks) {
      expect(callback).toHaveBeenCalledExactlyOnceWith(null, h.downloadId);
    }
  });

  test("reports a partial-file cleanup failure and allows a later restart", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { state: "paused" } });
    await mkdir(h.dest, { recursive: true });
    const resume = () =>
      new Promise<Error | null>((resolve) =>
        h.events.emit("resume-download", h.downloadId, resolve),
      );
    expect(await resume()).toBeInstanceOf(Error);
    expect(h.getState().persistent.downloads.files[h.downloadId].state).toBe("failed");
    expect(h.start).not.toHaveBeenCalled();
    await rm(h.dest, { recursive: true });
    expect(await resume()).toBeNull();
    await writeFile(h.dest, "new");
    await finish(h, [h.downloadId], false);
    expect(h.getState().persistent.downloads.files[h.downloadId].state).toBe("finished");
  });

  for (const releaseBeforeRemoval of [false, true]) {
    test(`cancels a checkpointless restart if the record is removed during resolution with early release=${releaseBeforeRemoval}`, async ({
      makeDownloadAdapter,
    }) => {
      const h = makeDownloadAdapter({ download: { state: "paused" } });
      const finished = vi.fn();
      h.events.on("did-finish-download", finished);
      let release: () => void = () => undefined;
      let entered: () => void = () => undefined;
      const entering = new Promise<void>((resolve) => {
        entered = resolve;
      });
      h.start.mockImplementationOnce(async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { downloadId: h.downloadId };
      });
      const resumed = new Promise<Error | null>((resolve) =>
        h.events.emit("resume-download", h.downloadId, resolve),
      );
      await entering;
      const removed = new Promise<void>((resolve) =>
        h.events.emit("remove-download", h.downloadId, () => resolve()),
      );
      if (releaseBeforeRemoval) release();
      await removed;
      if (!releaseBeforeRemoval) release();
      expect(await resumed).toBeInstanceOf(Error);
      expect(h.getState().persistent.downloads.files[h.downloadId]).toBeUndefined();
      await vi.advanceTimersByTimeAsync(250);
      expect(window.api.downloader.cancel).toHaveBeenCalledWith(h.downloadId);
      expect(h.getStates).not.toHaveBeenCalled();
      expect(finished).not.toHaveBeenCalled();
    });
  }

  for (const hasOriginalCallback of [false, true]) {
    for (const resolverSucceeds of [false, true]) {
      test(`removal settles restore callers before resolution with original callback=${hasOriginalCallback} and resolver success=${resolverSucceeds}`, async ({
        makeDownloadAdapter,
      }) => {
        const h = makeDownloadAdapter({ download: { state: "paused" } });
        let downloadId = h.downloadId;
        let originalCallback: Mock | undefined;
        if (hasOriginalCallback) {
          const started = await startFresh(h, "always");
          downloadId = started.downloadId;
          originalCallback = started.callbackSpy;
          await writeFile(started.temporary, "partial");
          window.api.downloader.pause = vi.fn().mockResolvedValue({
            downloadId,
            resource: "https://cdn.example/archive.7z",
            dest: started.temporary,
            completedRanges: [],
            etag: undefined,
          });
          await new Promise<void>((resolve) =>
            h.events.emit("pause-download", downloadId, () => resolve()),
          );
        } else {
          await mkdir(path.dirname(h.dest), { recursive: true });
          await writeFile(h.dest, "partial");
        }
        const entered = Promise.withResolvers<void>();
        const resolver = Promise.withResolvers<{ downloadId: string }>();
        h.start.mockImplementationOnce(() => {
          entered.resolve();
          return resolver.promise;
        });
        const callbacks = [vi.fn(), vi.fn()];
        const finished = vi.fn();
        h.events.on("did-finish-download", finished);
        h.events.emit("resume-download", downloadId, callbacks[0]);
        await entered.promise;
        h.events.emit("resume-download", downloadId, callbacks[1]);
        const removed = await new Promise<Error | null>((resolve) =>
          h.events.emit("remove-download", downloadId, resolve),
        );
        const callsAtRemoval = callbacks.map((callback) => callback.mock.calls.length);
        const originalCallsAtRemoval = originalCallback?.mock.calls.length;
        if (resolverSucceeds) resolver.resolve({ downloadId });
        else resolver.reject(new Error("resolver failed after removal"));
        await vi.advanceTimersByTimeAsync(250);
        expect(removed).toBeNull();
        expect(callsAtRemoval).toEqual([1, 1]);
        for (const callback of callbacks) {
          expect(callback).toHaveBeenCalledExactlyOnceWith(expect.any(UserCanceled));
        }
        if (originalCallback !== undefined) {
          expect(originalCallsAtRemoval).toBe(1);
          expect(originalCallback).toHaveBeenCalledExactlyOnceWith(
            expect.any(UserCanceled),
            downloadId,
          );
        }
        expect(window.api.downloader.cancel).toHaveBeenCalledTimes(resolverSucceeds ? 1 : 0);
        expect(h.getState().persistent.downloads.files[downloadId]).toBeUndefined();
        expect(h.getStates).not.toHaveBeenCalled();
        expect(finished).not.toHaveBeenCalled();
      });
    }
  }

  test("reports cleanup failure to the original caller while canceling an unresolved restore", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter();
    const started = await startFresh(h, "always");
    window.api.downloader.pause = vi.fn().mockResolvedValue({
      downloadId: started.downloadId,
      resource: "https://cdn.example/archive.7z",
      dest: started.temporary,
      completedRanges: [],
      etag: undefined,
    });
    await new Promise<void>((resolve) =>
      h.events.emit("pause-download", started.downloadId, () => resolve()),
    );
    const entered = Promise.withResolvers<void>();
    const resolver = Promise.withResolvers<{ downloadId: string }>();
    h.start.mockImplementationOnce(() => {
      entered.resolve();
      return resolver.promise;
    });
    const resumed = vi.fn();
    h.events.emit("resume-download", started.downloadId, resumed);
    await entered.promise;
    await mkdir(started.temporary);
    const error = await new Promise<Error | null>((resolve) =>
      h.events.emit("remove-download", started.downloadId, resolve),
    );
    const originalAtRemoval = started.callbackSpy.mock.calls.slice();
    const retry = () =>
      new Promise<Error | null>((resolve) =>
        h.events.emit("resume-download", started.downloadId, resolve),
      );
    const retryWhileResolving = await retry();
    await rm(started.temporary, { recursive: true });
    resolver.resolve({ downloadId: started.downloadId });
    await vi.advanceTimersByTimeAsync(250);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UserCanceled);
    expect(originalAtRemoval).toEqual([[error, started.downloadId]]);
    expect(started.callbackSpy).toHaveBeenCalledTimes(1);
    expect(resumed).toHaveBeenCalledExactlyOnceWith(expect.any(UserCanceled));
    expect(retryWhileResolving).toBeInstanceOf(UserCanceled);
    expect(window.api.downloader.cancel).toHaveBeenCalledExactlyOnceWith(started.downloadId);
    expect(h.getState().persistent.downloads.files[started.downloadId].state).toBe("failed");
    expect(await retry()).toBeNull();
    expect(h.start).toHaveBeenCalledTimes(3);
  });

  test("registers a shared restore before publishing state changes to subscribers", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { state: "paused" } });
    await mkdir(path.dirname(h.dest), { recursive: true });
    const nested = Promise.withResolvers<Error | null>();
    const unsubscribe = h.api.store.subscribe(() => {
      unsubscribe();
      h.events.emit("resume-download", h.downloadId, nested.resolve);
    });
    const first = new Promise<Error | null>((resolve) =>
      h.events.emit("resume-download", h.downloadId, resolve),
    );
    expect(await Promise.all([first, nested.promise])).toEqual([null, null]);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  test("removal during restore setup prevents a fresh transfer from being started", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { state: "paused" } });
    await mkdir(path.dirname(h.dest), { recursive: true });
    await writeFile(h.dest, "partial");
    const removed = Promise.withResolvers<Error | null>();
    const unsubscribe = h.api.store.subscribe(() => {
      unsubscribe();
      h.events.emit("remove-download", h.downloadId, removed.resolve);
    });
    const resumed = new Promise<Error | null>((resolve) =>
      h.events.emit("resume-download", h.downloadId, resolve),
    );
    expect(await resumed).toBeInstanceOf(UserCanceled);
    expect(await removed.promise).toBeNull();
    await vi.advanceTimersByTimeAsync(250);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.getState().persistent.downloads.files[h.downloadId]).toBeUndefined();
  });

  test("preserves both archives when two completions choose the same filename", async ({
    makeDownloadAdapter,
  }) => {
    const h = seed(makeDownloadAdapter);
    const directory = path.dirname(h.dest);
    await mkdir(directory, { recursive: true });
    await writeFile(h.dest, "one");
    await writeFile(path.join(directory, "__vortex_tmp_second"), "two");
    h.setState((state) => {
      state.persistent.downloads.files.second = {
        ...state.persistent.downloads.files[h.downloadId],
        id: "second",
        localPath: "__vortex_tmp_second",
      };
      state.persistent.downloads.checkpoints.second = {
        ...state.persistent.downloads.checkpoints[h.downloadId],
        downloadId: "second",
      };
    });
    await finish(h, [h.downloadId, "second"]);
    const records = h.getState().persistent.downloads.files;
    expect(records[h.downloadId].localPath).not.toBe(records.second.localPath);
    expect(await readFile(path.join(directory, records[h.downloadId].localPath), "utf8")).toBe(
      "one",
    );
    expect(await readFile(path.join(directory, records.second.localPath), "utf8")).toBe("two");
    expect(records[h.downloadId].fileMD5).toBe(createHash("md5").update("one").digest("hex"));
    expect(records.second.fileMD5).toBe(createHash("md5").update("two").digest("hex"));
  });

  for (const allowInstall of [undefined, false]) {
    test(`tracks a paused checkpoint after restart with allowInstall=${allowInstall}`, async ({
      makeDownloadAdapter,
    }) => {
      const h = makeDownloadAdapter({
        download: { state: "paused", localPath: "partial", received: 2 },
        automationInstall: true,
        checkpoint: {
          downloadId: "",
          resource: "https://cdn.example/archive.7z",
          dest: "unused",
          completedRanges: [{ start: 0, end: 1 }],
          etag: undefined,
        },
      });
      await mkdir(path.dirname(h.dest), { recursive: true });
      await writeFile(h.dest, "new");
      const installed = vi.fn();
      h.events.on("start-install-download", installed);
      const resumed = new Promise<void>((resolve) => {
        h.events.emit(
          "resume-download",
          h.downloadId,
          (error) => {
            expect(error).toBeNull();
            resolve();
          },
          { allowInstall },
        );
      });
      await resumed;
      expect(h.getState().persistent.downloads.files[h.downloadId].state).toBe("started");
      await finish(h, [h.downloadId], false);
      expect(h.getState().persistent.downloads.files[h.downloadId].state).toBe("finished");
      expect(installed).toHaveBeenCalledTimes(allowInstall === false ? 0 : 1);
    });
  }

  test("shares concurrent checkpoint resumes and answers both callers", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({
      download: { state: "paused" },
      checkpoint: {
        downloadId: "",
        resource: "https://cdn.example/archive.7z",
        dest: "unused",
        completedRanges: [{ start: 0, end: 1 }],
        etag: undefined,
      },
    });
    let release: () => void = () => undefined;
    h.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const callbacks = [vi.fn(), vi.fn()];
    for (const callback of callbacks) h.events.emit("resume-download", h.downloadId, callback);
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(h.resume).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await vi.advanceTimersByTimeAsync(0);
    }
    for (const callback of callbacks) expect(callback).toHaveBeenCalledWith(null, h.downloadId);
  });

  test("can retry a rejected checkpoint resume without changing the paused record", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({
      download: { state: "paused" },
      checkpoint: {
        downloadId: "",
        resource: "https://cdn.example/archive.7z",
        dest: "unused",
        completedRanges: [{ start: 0, end: 1 }],
        etag: undefined,
      },
    });
    h.resume.mockRejectedValueOnce(new Error("resume unavailable"));
    const resume = () =>
      new Promise<Error | null>((resolve) =>
        h.events.emit("resume-download", h.downloadId, resolve),
      );
    expect(await resume()).toMatchObject({ message: "resume unavailable" });
    expect(h.getState().persistent.downloads.files[h.downloadId].state).toBe("paused");
    expect(await resume()).toBeNull();
    expect(h.resume).toHaveBeenCalledTimes(2);
    expect(h.getState().persistent.downloads.files[h.downloadId].state).toBe("init");
  });

  for (const releaseBeforeRemoval of [false, true]) {
    test(`cancels a pending resume when its download was removed with early release=${releaseBeforeRemoval}`, async ({
      makeDownloadAdapter,
    }) => {
      const h = makeDownloadAdapter({
        download: { state: "paused" },
        checkpoint: {
          downloadId: "",
          resource: "https://cdn.example/archive.7z",
          dest: "unused",
          completedRanges: [{ start: 0, end: 1 }],
          etag: undefined,
        },
      });
      let release: () => void = () => undefined;
      h.resume.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const resumed = new Promise<Error | null>((resolve) =>
        h.events.emit("resume-download", h.downloadId, resolve),
      );
      await vi.advanceTimersByTimeAsync(0);
      const removed = new Promise<void>((resolve) =>
        h.events.emit("remove-download", h.downloadId, () => resolve()),
      );
      if (releaseBeforeRemoval) release();
      await removed;
      if (!releaseBeforeRemoval) release();
      expect(await resumed).toBeInstanceOf(Error);
      expect(window.api.downloader.cancel).toHaveBeenCalledWith(h.downloadId);
      expect(h.getState().persistent.downloads.files[h.downloadId]).toBeUndefined();
      await vi.advanceTimersByTimeAsync(250);
      expect(h.getStates).not.toHaveBeenCalled();
    });
  }

  for (const mode of ["replace", "ask"] as const) {
    test(`honors an explicit ${mode} choice for the requested archive`, async ({
      makeDownloadAdapter,
    }) => {
      const h = makeDownloadAdapter();
      const started = await startFresh(h, mode);
      await writeFile(started.temporary, "new");
      await finish(h, [started.downloadId], false);
      expect((await started.callback).err).toBeNull();
      expect(h.getState().persistent.downloads.files[started.downloadId].localPath).toBe(
        "archive.7z",
      );
      expect(await readFile(path.join(started.directory, "archive.7z"), "utf8")).toBe("new");
    });
  }

  test("marks a missing completed file as failed and settles the caller", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ automationInstall: true });
    const installed = vi.fn();
    h.events.on("start-install-download", installed);
    const started = await startFresh(h, "always");
    await finish(h, [started.downloadId], false);
    const result = await started.callback;
    expect(result.err).toBeInstanceOf(Error);
    const record = h.getState().persistent.downloads.files[started.downloadId];
    expect(record.state).toBe("failed");
    expect(record.fileMD5).toBeUndefined();
    expect(installed).not.toHaveBeenCalled();
    expect(await readFile(path.join(started.directory, "archive.7z"), "utf8")).toBe("old");
  });

  test("does not replace another server filename when replacement was requested for a different archive", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter();
    const started = await startFresh(h, "replace");
    await writeFile(path.join(started.directory, "other.7z"), "unrelated");
    await writeFile(started.temporary, "new");
    await finish(h, [started.downloadId], false, "other.7z");
    expect((await started.callback).err).toBeNull();
    expect(await readFile(path.join(started.directory, "other.7z"), "utf8")).toBe("unrelated");
    expect(await readFile(path.join(started.directory, "archive.7z"), "utf8")).toBe("old");
    const record = h.getState().persistent.downloads.files[started.downloadId];
    expect(await readFile(path.join(started.directory, record.localPath), "utf8")).toBe("new");
  });

  test("keeps paused partial files when a fresh renderer starts another download", async ({
    makeDownloadAdapter,
  }) => {
    const first = makeDownloadAdapter({
      download: { state: "paused", localPath: "__vortex_tmp_00000000" },
    });
    await mkdir(path.dirname(first.dest), { recursive: true });
    await writeFile(first.dest, "legacy partial");
    const startedFirst = await startFresh(first, "always");
    await writeFile(startedFirst.temporary, "first partial");
    expect(await readFile(first.dest, "utf8")).toBe("legacy partial");
    const second = makeDownloadAdapter({
      download: { state: "paused", localPath: path.basename(startedFirst.temporary) },
    });
    const startedSecond = await startFresh(second, "always");
    await writeFile(startedSecond.temporary, "second partial");
    expect(startedSecond.temporary).not.toBe(startedFirst.temporary);
    expect(await readFile(startedFirst.temporary, "utf8")).toBe("first partial");
  });
});
