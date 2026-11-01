import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { AlreadyDownloaded } from "@vortex/shared/errors";
import Zip from "node-7z";
import { expect, vi } from "vitest";

import { makeDownload, makeGameStored } from "./test-utils/builders";

for (const mode of [
  "single",
  "sequential",
  "concurrent",
  "alias-concurrent",
  "retained",
] as const) {
  test(`archive removal settles all selected owners: ${mode}`, async ({ makeDownloadAdapter }) => {
    const h = makeDownloadAdapter({ download: { state: "finished", localPath: "archive.zip" } });
    const directory = path.dirname(h.dest);
    await mkdir(directory, { recursive: true });
    const payload = path.join(directory, "payload.txt");
    await writeFile(payload, "concurrent archive payload");
    await new Zip().add(h.dest, [payload]);
    const bytes = await readFile(h.dest);
    const alias = path.join(path.dirname(directory), "other-game");
    if (mode === "alias-concurrent") await symlink(directory, alias, "dir");
    h.setState((state) => {
      if (mode !== "single") {
        state.persistent.downloads.files.second = makeDownload({
          id: "second",
          game: [mode === "alias-concurrent" ? "other-game" : "skyrimse"],
          state: "finished",
          localPath: "archive.zip",
        });
      }
      if (mode === "retained") {
        state.persistent.downloads.files.retained = makeDownload({
          id: "retained",
          game: ["skyrimse"],
          state: "finished",
          localPath: "archive.zip",
        });
      }
    });
    const callback = vi.fn();
    const remove = (id: string) =>
      new Promise<Error | null>((resolve) => {
        h.events.emit("remove-download", id, (error) => {
          callback(id, error);
          resolve(error);
        });
      });

    if (mode === "single" || mode === "sequential") {
      expect(await remove(h.downloadId)).toBeNull();
      if (mode === "sequential") {
        expect(await readFile(h.dest)).toEqual(bytes);
        expect(await remove("second")).toBeNull();
      }
    } else {
      expect(await Promise.all([remove(h.downloadId), remove("second")])).toEqual([null, null]);
    }
    expect(callback).toHaveBeenCalledTimes(mode === "single" ? 1 : 2);
    if (mode === "retained") {
      expect(Object.keys(h.getState().persistent.downloads.files)).toEqual(["retained"]);
      expect(await readFile(h.dest)).toEqual(bytes);
      const extracted = path.join(directory, "extracted");
      await new Zip().extractFull(h.dest, extracted);
      expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe(
        "concurrent archive payload",
      );
      expect(await remove("retained")).toBeNull();
      expect(callback).toHaveBeenCalledTimes(3);
    }
    expect(h.getState().persistent.downloads.files).toEqual({});
    await expect(stat(h.dest)).rejects.toMatchObject({ code: "ENOENT" });
  });
}
import { test } from "./test-utils/downloadAdapterTest";

for (const ownership of [
  "same-game",
  "different-game",
  "domain",
  "symlink",
  "unrelated",
] as const) {
  test(`removing archives respects ${ownership} ownership and removes the last owner`, async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { state: "finished", localPath: "archive.zip" } });
    const directory = path.dirname(h.dest);
    const root = path.dirname(directory);
    await mkdir(directory, { recursive: true });
    const payload = path.join(directory, "payload.txt");
    await writeFile(payload, "shared archive payload");
    await new Zip().add(h.dest, [payload]);
    const bytes = await readFile(h.dest);
    let peerGame = "skyrimse";
    if (ownership === "different-game" || ownership === "symlink") {
      peerGame = "other-game";
      if (ownership === "symlink") await symlink(directory, path.join(root, peerGame), "dir");
      else await mkdir(path.join(root, peerGame));
    } else if (ownership === "domain") {
      peerGame = "skyrimspecialedition";
      h.setState((state) => {
        state.session.gameMode.known = [
          makeGameStored({ id: "skyrimse", details: { nexusPageId: peerGame } }),
        ];
      });
    }
    const peerPath = path.join(
      root,
      ownership === "domain" ? "skyrimse" : peerGame,
      ownership === "unrelated" ? "unrelated.zip" : "archive.zip",
    );
    const shared = !["different-game", "unrelated"].includes(ownership);
    if (!shared) await copyFile(h.dest, peerPath);
    else expect(await realpath(peerPath)).toBe(await realpath(h.dest));
    h.setState((state) => {
      state.persistent.downloads.files.peer = makeDownload({
        id: "peer",
        game: [peerGame],
        state: "finished",
        localPath: path.basename(peerPath),
      });
    });
    const callback = vi.fn();
    const remove = (id: string) =>
      new Promise<Error | null>((resolve) => {
        h.events.emit("remove-download", id, (error) => {
          callback(error);
          resolve(error);
        });
      });

    expect(await remove(h.downloadId)).toBeNull();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(h.getState().persistent.downloads.files[h.downloadId]).toBeUndefined();
    expect(h.getState().persistent.downloads.files.peer).toBeDefined();
    expect(await readFile(peerPath)).toEqual(bytes);
    if (!shared) await expect(stat(h.dest)).rejects.toMatchObject({ code: "ENOENT" });
    const extracted = path.join(root, "extracted");
    await new Zip().extractFull(peerPath, extracted);
    expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe(
      "shared archive payload",
    );

    expect(await remove("peer")).toBeNull();
    expect(callback).toHaveBeenCalledTimes(2);
    expect(h.getState().persistent.downloads.files).toEqual({});
    await expect(stat(peerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
}

for (const mode of ["replace", "ask", "always", "never"] as const) {
  test(`a ${mode} download preserves another surviving record's archive`, async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { state: "finished", localPath: "archive.zip" } });
    const directory = path.dirname(h.dest);
    await mkdir(directory, { recursive: true });
    const payload = path.join(directory, "payload.txt");
    await writeFile(payload, "original archive payload");
    await new Zip().add(h.dest, [payload]);
    const oldBytes = await readFile(h.dest);
    h.setNextDialog({ action: "Re-download", input: {} });
    const callbackSpy = vi.fn();
    const result = new Promise<{ error: Error | null; id?: string }>((resolve) =>
      h.events.emit(
        "start-download",
        ["https://cdn.example/archive.zip"],
        { game: "skyrimse" },
        "archive.zip",
        (error, id) => {
          callbackSpy(error, id);
          resolve({ error, id });
        },
        mode,
        { allowInstall: false },
      ),
    );
    if (mode === "never") {
      const completed = await result;
      expect(completed.error).toBeInstanceOf(AlreadyDownloaded);
      expect((completed.error as AlreadyDownloaded).downloadId).toBe(h.downloadId);
      expect(h.start).not.toHaveBeenCalled();
      expect(await readFile(h.dest)).toEqual(oldBytes);
      expect(Object.keys(h.getState().persistent.downloads.files)).toEqual([h.downloadId]);
      return;
    }
    await h.started.promise;
    const { downloadId } = await h.start.mock.results[0].value;
    await Promise.resolve();
    const temporary = h.start.mock.calls[0][0] as string;
    await writeFile(payload, "replacement archive payload");
    const replacementZip = path.join(directory, "incoming.zip");
    await new Zip().add(replacementZip, [payload]);
    await copyFile(replacementZip, temporary);
    const newBytes = await readFile(temporary);
    window.api.hash = {
      compute: async (algorithm, filePath) => {
        const bytes = await readFile(filePath);
        return { hash: createHash(algorithm).update(bytes).digest("hex"), numBytes: bytes.length };
      },
    };
    h.getStates.mockResolvedValue({
      [downloadId]: {
        status: "completed",
        bytesReceived: newBytes.length,
        bytesWritten: newBytes.length,
        size: newBytes.length,
        fileName: "archive.zip",
        isChunked: false,
        error: null,
      },
    });
    await vi.advanceTimersByTimeAsync(200);
    const completed = await result;
    await Promise.resolve();
    expect(completed).toEqual({ error: null, id: downloadId });
    expect(callbackSpy).toHaveBeenCalledTimes(1);
    const files = h.getState().persistent.downloads.files;
    const survivingArchive = path.join(directory, files[downloadId].localPath);
    expect(await readFile(survivingArchive)).toEqual(newBytes);
    const beforeRemoval = path.join(directory, "before-removal");
    await new Zip().extractFull(survivingArchive, beforeRemoval);
    expect(await readFile(path.join(beforeRemoval, "payload.txt"), "utf8")).toBe(
      "replacement archive payload",
    );
    if (mode === "always") expect(await readFile(h.dest)).toEqual(oldBytes);
    const removed = await new Promise<Error | null>((resolve) =>
      h.events.emit("remove-download", h.downloadId, resolve),
    );
    expect(removed).toBeNull();
    expect(h.getState().persistent.downloads.files[downloadId]).toMatchObject({
      state: "finished",
    });
    expect(await readFile(survivingArchive)).toEqual(newBytes);
    const extracted = path.join(directory, "extracted");
    await new Zip().extractFull(survivingArchive, extracted);
    expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe(
      "replacement archive payload",
    );
    await vi.advanceTimersByTimeAsync(0);
  });
}
