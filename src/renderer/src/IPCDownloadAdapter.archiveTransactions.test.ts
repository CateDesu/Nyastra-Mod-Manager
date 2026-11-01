import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { getErrorCode } from "@vortex/shared";
import Zip from "node-7z";
import { expect, vi } from "vitest";

import { removeDownloadSilent } from "./extensions/download_management/actions/state";
import { makeDownload } from "./test-utils/builders";
import { test } from "./test-utils/downloadAdapterTest";
import type { IState } from "./types/IState";

for (const ownership of ["unshared", "same-entry", "directory-alias", "file-alias"]) {
  test(`startup stale cleanup preserves surviving archive owner: ${ownership}`, async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { state: "started", localPath: "archive.zip" } });
    const directory = path.dirname(h.dest),
      root = path.dirname(directory);
    await mkdir(directory, { recursive: true });
    const payload = path.join(root, "payload.txt");
    await writeFile(payload, "shared startup archive");
    await new Zip().add(h.dest, [payload]);
    const original = await readFile(h.dest);
    h.setState((s) => {
      s.persistent.downloads.files[h.downloadId].size = original.length;
      s.persistent.downloads.files[h.downloadId].received = original.length;
    });
    const peerDirectory = ownership === "same-entry" ? directory : path.join(root, "other-game");
    const peerPath = path.join(peerDirectory, "archive.zip");
    if (ownership === "directory-alias") await symlink(directory, peerDirectory, "dir");
    if (ownership === "file-alias") {
      await mkdir(peerDirectory);
      await symlink(h.dest, peerPath);
    }
    if (ownership !== "unshared")
      h.setState((s) => {
        s.persistent.downloads.files.peer = makeDownload({
          id: "peer",
          game: [ownership === "same-entry" ? "skyrimse" : "other-game"],
          state: "finished",
          localPath: "archive.zip",
          size: original.length,
          received: original.length,
        });
      });
    await h.adapter.hydrateFromState();
    expect(h.getState().persistent.downloads.files[h.downloadId]).toBeUndefined();
    expect(h.start).not.toHaveBeenCalled();
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.dispatched).toContainEqual(removeDownloadSilent(h.downloadId));
    if (ownership === "unshared") {
      expect(h.getState().persistent.downloads.files).toEqual({});
      await expect(stat(h.dest)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(Object.keys(h.getState().persistent.downloads.files)).toEqual(["peer"]);
      const bytes = await readFile(peerPath).catch(getErrorCode);
      expect(Buffer.isBuffer(bytes)).toBe(true);
      expect(bytes).toEqual(original);
      const extracted = path.join(root, "extracted");
      await new Zip().extractFull(peerPath, extracted);
      expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe(
        "shared startup archive",
      );
    }
  });
}

for (const next of ["restart", "retry"]) {
  test(`failed removal and checkpointless retry preserve a shared archive: ${next}`, async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { state: "finished", localPath: "archive.zip" } });
    const directory = path.dirname(h.dest),
      root = path.dirname(directory);
    await mkdir(directory, { recursive: true });
    const payload = path.join(root, "payload.txt");
    await writeFile(payload, "archive kept by another owner");
    await new Zip().add(h.dest, [payload]);
    const original = await readFile(h.dest);
    h.setState((s) => {
      s.persistent.downloads.files[h.downloadId].size = original.length;
      s.persistent.downloads.files[h.downloadId].received = original.length;
    });
    const locked = path.join(root, "locked-game");
    await mkdir(locked);
    await writeFile(path.join(locked, "unrelated.zip"), "unrelated");
    h.setState((s) => {
      s.persistent.downloads.files.peer = makeDownload({
        id: "peer",
        game: ["skyrimse"],
        state: "finished",
        localPath: "archive.zip",
        size: original.length,
        received: original.length,
      });
      s.persistent.downloads.files.locked = makeDownload({
        id: "locked",
        game: ["locked-game"],
        state: "finished",
        localPath: "unrelated.zip",
        size: 9,
        received: 9,
      });
    });
    const remove = () =>
      new Promise<Error | null>((resolve) =>
        h.events.emit("remove-download", h.downloadId, resolve),
      );
    await chmod(locked, 0);
    try {
      const error = await remove();
      expect(getErrorCode(error)).toBe("EACCES");
    } finally {
      await chmod(locked, 0o755);
    }
    expect(h.getState().persistent.downloads.files[h.downloadId].state).toBe("failed");
    expect(await readFile(h.dest)).toEqual(original);
    let snapshot: IState["persistent"]["downloads"];
    const stop = h.api.store.subscribe(() => {
      const s = h.getState();
      if (s.persistent.downloads.files[h.downloadId]?.state === "init")
        snapshot = JSON.parse(JSON.stringify(s.persistent.downloads));
    });
    if (next === "restart") await chmod(directory, 0o555);
    try {
      const error = await new Promise<Error | null>((resolve) =>
        h.events.emit("resume-download", h.downloadId, resolve),
      );
      if (next === "restart") expect(getErrorCode(error)).toBe("EACCES");
      else expect(error).toBeNull();
    } finally {
      stop();
      await chmod(directory, 0o755);
    }
    expect(snapshot.files[h.downloadId].state).toBe("init");
    if (next === "restart") {
      expect(await readFile(h.dest)).toEqual(original);
      const reloaded = makeDownloadAdapter({ downloadDirectory: root });
      reloaded.setState((s) => {
        s.persistent.downloads = snapshot;
      });
      await reloaded.adapter.hydrateFromState();
      expect(Object.keys(reloaded.getState().persistent.downloads.files)).toEqual([
        "peer",
        "locked",
      ]);
    } else {
      expect(h.start).toHaveBeenCalledTimes(1);
      expect(h.start.mock.calls[0][0]).not.toBe(h.dest);
      expect(h.start.mock.calls[0][0]).toBe(
        path.join(directory, h.getState().persistent.downloads.files[h.downloadId].localPath!),
      );
    }
    const bytes = await readFile(h.dest).catch(getErrorCode);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes).toEqual(original);
  });
}

for (const ownership of ["same-entry", "directory-alias", "file-alias"]) {
  for (const outcome of ["cancel", "finish"] as const) {
    test(`checkpointless retry owns its writes and ${outcome} cleanup with ${ownership}`, async ({
      makeDownloadAdapter,
    }) => {
      const h = makeDownloadAdapter({ download: { state: "failed", localPath: "archive.zip" } });
      const directory = path.dirname(h.dest);
      const root = path.dirname(directory);
      await mkdir(directory, { recursive: true });
      const payload = path.join(root, "payload.txt");
      await writeFile(payload, "peer payload");
      await new Zip().add(h.dest, [payload]);
      const original = await readFile(h.dest);
      const peerDirectory = ownership === "same-entry" ? directory : path.join(root, "other-game");
      const peerPath = path.join(peerDirectory, "archive.zip");
      if (ownership === "directory-alias") await symlink(directory, peerDirectory, "dir");
      if (ownership === "file-alias") {
        await mkdir(peerDirectory);
        await symlink(h.dest, peerPath);
      }
      h.setState((state) => {
        state.persistent.downloads.files.peer = makeDownload({
          id: "peer",
          game: [ownership === "same-entry" ? "skyrimse" : "other-game"],
          state: "finished",
          localPath: "archive.zip",
          size: original.length,
          received: original.length,
        });
      });
      await writeFile(payload, "retry payload");
      const incoming = path.join(root, "incoming.zip");
      await new Zip().add(incoming, [payload]);
      const replacement = await readFile(incoming);
      h.start.mockImplementationOnce(async (destination: string) => {
        await writeFile(destination, replacement);
        return { downloadId: h.downloadId };
      });
      const resumed = vi.fn();
      const error = await new Promise<Error | null>((resolve) =>
        h.events.emit("resume-download", h.downloadId, (value, id) => {
          resumed(value, id);
          resolve(value);
        }),
      );
      expect(error).toBeNull();
      expect(resumed).toHaveBeenCalledExactlyOnceWith(null, h.downloadId);
      const destination = h.start.mock.calls[0][0] as string;
      expect(destination).not.toBe(h.dest);
      expect(destination).toBe(
        path.join(directory, h.getState().persistent.downloads.files[h.downloadId].localPath!),
      );
      expect(await readFile(destination)).toEqual(replacement);
      expect(await readFile(peerPath)).toEqual(original);
      if (outcome === "cancel") {
        const removed = vi.fn();
        const error = await new Promise<Error | null>((resolve) =>
          h.events.emit("remove-download", h.downloadId, (value) => {
            removed(value);
            resolve(value);
          }),
        );
        expect(error).toBeNull();
        expect(removed).toHaveBeenCalledExactlyOnceWith(null);
        expect(window.api.downloader.cancel).toHaveBeenCalledExactlyOnceWith(h.downloadId);
        await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
        expect(Object.keys(h.getState().persistent.downloads.files)).toEqual(["peer"]);
      } else {
        const finished = Promise.withResolvers<void>();
        h.events.on("did-finish-download", (id, state) => {
          if (id === h.downloadId && state === "finished") finished.resolve();
        });
        window.api.hash = {
          compute: async (_algorithm, filePath) => ({
            hash: "abc",
            numBytes: (await readFile(filePath)).length,
          }),
        };
        h.getStates.mockResolvedValue({
          [h.downloadId]: {
            status: "completed",
            error: null,
            bytesReceived: replacement.length,
            bytesWritten: replacement.length,
            size: replacement.length,
            fileName: "retry.zip",
            isChunked: false,
          },
        });
        await vi.advanceTimersByTimeAsync(200);
        await finished.promise;
        const row = h.getState().persistent.downloads.files[h.downloadId];
        expect(row.state).toBe("finished");
        expect(row.localPath).toBe("retry.zip");
        expect(await readFile(path.join(directory, row.localPath!))).toEqual(replacement);
        await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
        const extracted = path.join(root, "extracted-retry");
        await new Zip().extractFull(path.join(directory, row.localPath!), extracted);
        expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe("retry payload");
      }
      expect(await readFile(peerPath)).toEqual(original);
      const extracted = path.join(root, "extracted-peer");
      await new Zip().extractFull(peerPath, extracted);
      expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe("peer payload");
    });
  }
}

test("uses resolved Wine directory casing for a shared retry and its cancellation", async ({
  makeDownloadAdapter,
}) => {
  const h = makeDownloadAdapter({ download: { state: "failed", localPath: "ARCHIVE.ZIP" } });
  const root = path.dirname(path.dirname(h.dest));
  const actualDirectory = path.join(root, ".wine", "drive_c", "Downloads", "SkyrimSE");
  await mkdir(actualDirectory, { recursive: true });
  const archive = path.join(actualDirectory, "Archive.zip");
  const payload = path.join(root, "payload.txt");
  await writeFile(payload, "Wine shared archive");
  await new Zip().add(archive, [payload]);
  const original = await readFile(archive);
  h.setState((state) => {
    state.settings.downloads.path = path.join(root, ".wine", "drive_c", "downloads");
    state.persistent.downloads.files.peer = makeDownload({
      id: "peer",
      state: "finished",
      game: ["skyrimse"],
      localPath: "archive.zip",
    });
  });
  h.start.mockImplementationOnce(async (destination: string) => {
    await writeFile(destination, "partial retry");
    return { downloadId: h.downloadId };
  });
  const resumed = await new Promise<Error | null>((resolve) =>
    h.events.emit("resume-download", h.downloadId, resolve),
  );
  expect(resumed).toBeNull();
  const destination = h.start.mock.calls[0][0] as string;
  expect(path.dirname(destination)).toBe(actualDirectory);
  expect(await readFile(destination, "utf8")).toBe("partial retry");
  const removed = await new Promise<Error | null>((resolve) =>
    h.events.emit("remove-download", h.downloadId, resolve),
  );
  expect(removed).toBeNull();
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(archive)).toEqual(original);
  expect(Object.keys(h.getState().persistent.downloads.files)).toEqual(["peer"]);
});
