import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import Zip from "node-7z";
import { expect, vi } from "vitest";

import { makeDownload } from "./test-utils/builders";
import { test } from "./test-utils/downloadAdapterTest";
import type { IDownloadAdapterHarness } from "./test-utils/harnessTypes";
import * as fs from "./util/fs";

function remove(h: IDownloadAdapterHarness, id: string) {
  const callback = vi.fn();
  const promise = new Promise<Error | null>((resolve) =>
    h.events.emit("remove-download", id, (error) => {
      callback(error);
      resolve(error);
    }),
  );
  return { promise, callback };
}

async function archive(file: string, payload = "managed archive payload") {
  await mkdir(path.dirname(file), { recursive: true });
  const input = path.join(path.dirname(file), "payload.txt");
  await writeFile(input, payload);
  await new Zip().add(file, [input]);
  return readFile(file);
}

function peer(h: IDownloadAdapterHarness, id = "peer", game = "other-game") {
  h.setState((state) => {
    state.persistent.downloads.files[id] = makeDownload({
      id,
      game: [game],
      state: "finished",
      localPath: "archive.zip",
    });
  });
}

for (const casing of ["exact", "Wine-root", "Wine-owner", "native-owner"] as const) {
  test(`archive removal respects ${casing} paths`, async ({ makeDownloadAdapter }) => {
    const h = makeDownloadAdapter({ download: { state: "finished", localPath: "archive.zip" } });
    const root = path.join(
      path.dirname(path.dirname(h.dest)),
      casing === "native-owner" ? "native" : "pfx/drive_c/Downloads",
    );
    const target = path.join(root, "skyrimse/archive.zip");
    const bytes = await archive(target);
    h.setState((state) => {
      state.settings.downloads.path =
        casing === "Wine-root" ? root.replace("/Downloads", "/downloads") : root;
      if (casing.endsWith("owner")) {
        state.persistent.downloads.files.peer = makeDownload({
          id: "peer",
          game: ["skyrimse"],
          state: "finished",
          localPath: "ARCHIVE.ZIP",
        });
      }
    });
    if (casing === "Wine-root") {
      await expect(stat(target.replace("/Downloads", "/downloads"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    if (casing === "Wine-owner") {
      const alternate = path.join(root, "skyrimse/ARCHIVE.ZIP");
      await expect(stat(alternate)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.statAsync(alternate)).size).toBe(bytes.length);
    }
    const first = remove(h, h.downloadId);
    expect(await first.promise).toBeNull();
    expect(first.callback).toHaveBeenCalledExactlyOnceWith(null);
    expect(h.getState().persistent.downloads.files[h.downloadId]).toBeUndefined();
    if (casing === "Wine-owner") {
      expect(await readFile(target)).toEqual(bytes);
      const extracted = path.join(root, "extracted");
      await new Zip().extractFull(target, extracted);
      expect(await readFile(path.join(extracted, "payload.txt"), "utf8")).toBe(
        "managed archive payload",
      );
    }
    if (casing.endsWith("owner")) {
      const last = remove(h, "peer");
      expect(await last.promise).toBeNull();
      expect(last.callback).toHaveBeenCalledExactlyOnceWith(null);
    }
    expect(h.getState().persistent.downloads.files).toEqual({});
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
}

for (const alias of ["file", "directory"] as const) {
  for (const order of ["regular-first", "alias-first", "concurrent", "restart"] as const) {
    test(`last ${alias} alias cleans managed bytes with ${order} removal`, async ({
      makeDownloadAdapter,
    }) => {
      let h = makeDownloadAdapter({ download: { state: "finished", localPath: "archive.zip" } });
      const target = h.dest;
      const bytes = await archive(target);
      const other = path.join(path.dirname(path.dirname(target)), "other-game");
      const aliasPath = path.join(other, "archive.zip");
      if (alias === "directory") await symlink(path.dirname(target), other, "dir");
      else {
        await mkdir(other);
        await symlink(target, aliasPath);
      }
      peer(h);
      if (order === "concurrent") {
        const runs = [remove(h, h.downloadId), remove(h, "peer")];
        expect(await Promise.all(runs.map((run) => run.promise))).toEqual([null, null]);
        runs.forEach((run) => expect(run.callback).toHaveBeenCalledExactlyOnceWith(null));
      } else {
        const firstId = order === "alias-first" ? "peer" : h.downloadId;
        const lastId = firstId === "peer" ? h.downloadId : "peer";
        const first = remove(h, firstId);
        expect(await first.promise).toBeNull();
        expect(first.callback).toHaveBeenCalledExactlyOnceWith(null);
        expect(await readFile(target)).toEqual(bytes);
        if (order !== "alias-first") expect(await readFile(aliasPath)).toEqual(bytes);
        if (order === "restart") {
          const persisted = JSON.parse(JSON.stringify(h.getState().persistent.downloads));
          h = makeDownloadAdapter();
          h.setState((state) => {
            state.persistent.downloads = persisted;
          });
        }
        const last = remove(h, lastId);
        expect(await last.promise).toBeNull();
        expect(last.callback).toHaveBeenCalledExactlyOnceWith(null);
      }
      expect(h.getState().persistent.downloads.files).toEqual({});
      await expect(lstat(aliasPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    });
  }
}

for (const concurrent of [false, true]) {
  test(`unproven external file symlinks preserve targets with concurrent=${concurrent}`, async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { state: "finished", localPath: "archive.zip" } });
    const directory = path.dirname(h.dest);
    const target = path.join(path.dirname(directory), "external/archive.zip");
    const bytes = await archive(target, "external archive payload");
    await mkdir(directory);
    await symlink(target, h.dest);
    const alias = path.join(directory, "second.zip");
    await symlink(target, alias);
    h.setState((state) => {
      state.persistent.downloads.files.second = makeDownload({
        id: "second",
        game: ["skyrimse"],
        state: "finished",
        localPath: "second.zip",
      });
    });
    const first = remove(h, h.downloadId);
    if (!concurrent) expect(await first.promise).toBeNull();
    const last = remove(h, "second");
    expect(await Promise.all([first.promise, last.promise])).toEqual([null, null]);
    for (const run of [first, last]) {
      expect(run.callback).toHaveBeenCalledExactlyOnceWith(null);
    }
    expect(h.getState().persistent.downloads.files).toEqual({});
    await expect(lstat(alias)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(h.dest)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(target)).toEqual(bytes);
  });
}

for (const change of ["replace", "repoint", "missing"] as const) {
  test(`a surviving alias cannot delete a ${change} target using stale provenance`, async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { state: "finished", localPath: "archive.zip" } });
    await archive(h.dest);
    const other = path.join(path.dirname(path.dirname(h.dest)), "other-game");
    await mkdir(other);
    const alias = path.join(other, "archive.zip");
    await symlink(h.dest, alias);
    peer(h);
    expect(await remove(h, h.downloadId).promise).toBeNull();
    const external = path.join(other, "external.zip");
    const externalBytes = await archive(external, "unowned replacement payload");
    if (change === "replace") await rename(external, h.dest);
    if (change === "repoint") {
      await rm(alias);
      await symlink(external, alias);
    }
    if (change === "missing") await rm(h.dest);
    const last = remove(h, "peer");
    expect(await last.promise).toBeNull();
    expect(last.callback).toHaveBeenCalledExactlyOnceWith(null);
    expect(h.getState().persistent.downloads.files).toEqual({});
    await expect(lstat(alias)).rejects.toMatchObject({ code: "ENOENT" });
    if (change !== "missing") {
      expect(await readFile(change === "replace" ? h.dest : external)).toEqual(externalBytes);
    }
  });
}

test("provenance passes through surviving file aliases before the final removal", async ({
  makeDownloadAdapter,
}) => {
  const h = makeDownloadAdapter({ download: { state: "finished", localPath: "archive.zip" } });
  const bytes = await archive(h.dest);
  const other = path.join(path.dirname(path.dirname(h.dest)), "other-game");
  await mkdir(other);
  await symlink(h.dest, path.join(other, "archive.zip"));
  peer(h);
  const first = remove(h, h.downloadId);
  expect(await first.promise).toBeNull();
  await symlink(h.dest, path.join(other, "second.zip"));
  h.setState((state) => {
    state.persistent.downloads.files.second = makeDownload({
      id: "second",
      game: ["other-game"],
      state: "finished",
      localPath: "second.zip",
    });
  });
  const middle = remove(h, "peer");
  expect(await middle.promise).toBeNull();
  expect(await readFile(h.dest)).toEqual(bytes);
  const last = remove(h, "second");
  expect(await last.promise).toBeNull();
  for (const run of [first, middle, last]) {
    expect(run.callback).toHaveBeenCalledExactlyOnceWith(null);
  }
  expect(h.getState().persistent.downloads.files).toEqual({});
  await expect(stat(h.dest)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a failed managed target unlink retains the alias and permits a complete retry", async ({
  makeDownloadAdapter,
}) => {
  const h = makeDownloadAdapter({ download: { state: "finished", localPath: "archive.zip" } });
  const bytes = await archive(h.dest);
  const directory = path.dirname(h.dest);
  const other = path.join(path.dirname(directory), "other-game");
  await mkdir(other);
  const alias = path.join(other, "archive.zip");
  await symlink(h.dest, alias);
  peer(h);
  expect(await remove(h, h.downloadId).promise).toBeNull();
  try {
    await chmod(directory, 0o500);
    const failed = remove(h, "peer");
    expect(await failed.promise).toMatchObject({ code: "EACCES" });
    expect(failed.callback).toHaveBeenCalledTimes(1);
    expect(h.getState().persistent.downloads.files.peer.state).toBe("failed");
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await readFile(alias)).toEqual(bytes);
  } finally {
    await chmod(directory, 0o700);
  }
  const retries = [remove(h, "peer"), remove(h, "peer")];
  expect(await Promise.all(retries.map((run) => run.promise))).toEqual([null, null]);
  retries.forEach((run) => expect(run.callback).toHaveBeenCalledExactlyOnceWith(null));
  expect(h.getState().persistent.downloads.files).toEqual({});
  await expect(lstat(alias)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(h.dest)).rejects.toMatchObject({ code: "ENOENT" });
});

for (const entry of ["same-path", "directory-alias", "link-chain"] as const) {
  test(`a removed file alias remains readable through its surviving ${entry} owner`, async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { state: "finished", localPath: "archive.zip" } });
    const directory = path.dirname(h.dest);
    const target = path.join(path.dirname(directory), "managed/archive.zip");
    const bytes = await archive(target);
    await mkdir(directory);
    await symlink(target, h.dest);
    let peerGame = "skyrimse";
    let peerName = "archive.zip";
    if (entry === "directory-alias") {
      peerGame = "other-game";
      await symlink(directory, path.join(path.dirname(directory), peerGame), "dir");
    }
    if (entry === "link-chain") {
      peerName = "second.zip";
      await symlink("archive.zip", path.join(directory, peerName));
    }
    h.setState((state) => {
      state.persistent.downloads.files.peer = makeDownload({
        id: "peer",
        game: [peerGame],
        state: "finished",
        localPath: peerName,
      });
    });
    const first = remove(h, h.downloadId);
    expect(await first.promise).toBeNull();
    expect(first.callback).toHaveBeenCalledExactlyOnceWith(null);
    const surviving = path.join(path.dirname(directory), peerGame, peerName);
    expect(await readFile(surviving)).toEqual(bytes);
    const last = remove(h, "peer");
    expect(await last.promise).toBeNull();
    expect(last.callback).toHaveBeenCalledExactlyOnceWith(null);
    expect(h.getState().persistent.downloads.files).toEqual({});
    expect(await readFile(target)).toEqual(bytes);
    await expect(lstat(surviving)).rejects.toMatchObject({ code: "ENOENT" });
  });
}

test("a file symlink to an external directory removes only the symlink", async ({
  makeDownloadAdapter,
}) => {
  const h = makeDownloadAdapter({ download: { state: "finished", localPath: "archive.zip" } });
  const directory = path.dirname(h.dest);
  const external = path.join(path.dirname(directory), "external");
  const target = path.join(external, "archive.zip");
  const bytes = await archive(target);
  await mkdir(directory);
  await symlink(external, h.dest, "dir");
  const run = remove(h, h.downloadId);
  expect(await run.promise).toBeNull();
  expect(run.callback).toHaveBeenCalledExactlyOnceWith(null);
  expect(h.getState().persistent.downloads.files).toEqual({});
  await expect(lstat(h.dest)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(target)).toEqual(bytes);
});
