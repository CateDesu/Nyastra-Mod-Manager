import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { AlreadyDownloaded } from "@vortex/shared/errors";
import { afterEach, describe, expect } from "vitest";

import { addLocalDownload } from "./extensions/download_management/actions/state";
import { test } from "./test-utils/downloadAdapterTest";
import type { IDownloadAdapterHarness } from "./test-utils/harnessTypes";

// These tests exercise the "file already on disk" probe in #handleStartDownload, so the
// caller-named file is written to the fixture's isolated download folder.
const TRACKED = "gh23885-tracked.7z";
const ORPHAN = "gh23885-orphan.7z";
const FILE_BYTES = "archive bytes";

const onDisk: string[] = [];

const putOnDisk = async (filePath: string) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, FILE_BYTES);
  onDisk.push(filePath);
};

afterEach(async () => {
  await Promise.all(onDisk.splice(0).map((filePath) => rm(filePath, { force: true })));
});

// the collection dependency downloader's emit shape: a caller-supplied fileName and
// redownload "never", awaiting the callback
const startDownload = (h: IDownloadAdapterHarness, fileName: string) =>
  new Promise<{ err: Error | null; id?: string }>((resolve) => {
    h.events.emit(
      "start-download",
      [`https://cdn.example/${fileName}`],
      { game: "skyrimse" },
      fileName,
      (err: Error | null, id?: string) => resolve({ err, id }),
      "never",
      { allowInstall: false },
    );
  });

describe("start-download for a file already on disk (GH #23885)", () => {
  test("adopts the current game's archive when another game tracks the same filename", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { localPath: TRACKED, game: ["fallout4"] } });
    const target = path.join(path.dirname(path.dirname(h.dest)), "skyrimse", TRACKED);
    await putOnDisk(h.dest);
    await putOnDisk(target);

    const result = await startDownload(h, TRACKED);

    expect(result.err).toBeInstanceOf(AlreadyDownloaded);
    const adoptedId = (result.err as AlreadyDownloaded).downloadId;
    expect(adoptedId).not.toBe(h.downloadId);
    expect(h.getState().persistent.downloads.files[adoptedId!].game).toContain("skyrimse");
    expect(h.dispatched).toContainEqual(
      addLocalDownload(adoptedId!, "skyrimse", TRACKED, FILE_BYTES.length),
    );
    expect(h.start).not.toHaveBeenCalled();
  });

  test("finds the current game's tracked archive after another game's matching filename", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { localPath: TRACKED, game: ["fallout4"] } });
    h.setState((state) => {
      state.persistent.downloads.files.current = {
        ...state.persistent.downloads.files[h.downloadId],
        id: "current",
        game: ["skyrimse"],
      };
    });
    await putOnDisk(path.join(path.dirname(path.dirname(h.dest)), "skyrimse", TRACKED));
    const result = await startDownload(h, TRACKED);
    expect((result.err as AlreadyDownloaded).downloadId).toBe("current");
    expect(h.start).not.toHaveBeenCalled();
  });

  test("discards directory components from a caller's filename before checking existing files", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter();
    const directory = path.dirname(h.dest);
    await putOnDisk(path.join(directory, ORPHAN));

    const pending = startDownload(h, `../${ORPHAN}`);
    await Promise.race([pending, h.started.promise]);
    expect(h.start).not.toHaveBeenCalled();
    const result = await pending;

    expect(result.err).toBeInstanceOf(AlreadyDownloaded);
    const adoptedId = (result.err as AlreadyDownloaded).downloadId;
    expect(h.getState().persistent.downloads.files[adoptedId!].localPath).toBe(ORPHAN);
    expect(h.start).not.toHaveBeenCalled();
  });

  test("resolves AlreadyDownloaded with the id of the record tracking the file", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter({ download: { localPath: TRACKED } });
    await putOnDisk(h.dest);

    const result = await startDownload(h, TRACKED);

    expect(result.err).toBeInstanceOf(AlreadyDownloaded);
    expect((result.err as AlreadyDownloaded).downloadId).toBe(h.downloadId);
    expect(h.start).not.toHaveBeenCalled();
  });

  test("adopts an on-disk file that no record tracks as a local download", async ({
    makeDownloadAdapter,
  }) => {
    const h = makeDownloadAdapter();
    // on disk, but no download record has this localPath - the state a manual browser download
    // or a file left behind by an earlier session produces
    await putOnDisk(path.join(path.dirname(h.dest), ORPHAN));

    const result = await startDownload(h, ORPHAN);

    expect(result.err).toBeInstanceOf(AlreadyDownloaded);
    const adoptedId = (result.err as AlreadyDownloaded).downloadId;
    // registered like the download-folder scan registers unknown archives
    expect(h.dispatched).toContainEqual(
      addLocalDownload(adoptedId!, "skyrimse", ORPHAN, FILE_BYTES.length),
    );
    expect(h.start).not.toHaveBeenCalled();
  });
});
