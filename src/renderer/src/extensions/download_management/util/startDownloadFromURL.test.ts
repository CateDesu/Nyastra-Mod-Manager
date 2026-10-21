import { writeFile } from "node:fs/promises";

import { describe, expect, vi } from "vitest";

import { makeProfile } from "../../../test-utils/builders";
import { test } from "../../../test-utils/downloadAdapterTest";
import { startDownloadFromURL } from "./startDownloadFromURL";

describe("HTTP download installation", () => {
  for (const protocol of ["http", "https"]) {
    for (const automationInstall of [false, true]) {
      for (const install of [false, true]) {
        test(`${protocol} install=${install} automation=${automationInstall} installs at most once`, async ({
          makeDownloadAdapter,
        }) => {
          const h = makeDownloadAdapter({ automationInstall });
          const profile = makeProfile({ id: "http-download", gameId: "skyrimse" });
          h.setState((draft) => {
            draft.persistent.profiles[profile.id] = profile;
            draft.settings.profiles.activeProfileId = profile.id;
          });
          const installed = vi.fn();
          h.events.on("start-install-download", installed);

          startDownloadFromURL(h.api, `${protocol}://cdn.example/mod.7z`, install);
          await h.started.promise;
          await vi.advanceTimersByTimeAsync(0);
          expect(installed).not.toHaveBeenCalled();

          await writeFile(h.start.mock.calls[0][0] as string, Buffer.alloc(100));
          const finished = new Promise<void>((resolve) =>
            h.events.once("did-finish-download", () => resolve()),
          );
          const downloadId = "new-0";
          h.getStates.mockResolvedValue({
            [downloadId]: {
              status: "completed",
              bytesReceived: 100,
              size: 100,
              error: null,
              fileName: undefined,
              isChunked: false,
            },
          });
          await vi.advanceTimersByTimeAsync(250);
          await finished;

          expect(h.getState().persistent.downloads.files[downloadId].state).toBe("finished");
          expect(installed).toHaveBeenCalledTimes(install || automationInstall ? 1 : 0);
          if (install || automationInstall) {
            expect(installed).toHaveBeenCalledWith(downloadId);
          }
        });
      }
    }
  }

  test("does not install when the download fails", async ({ makeDownloadAdapter }) => {
    const h = makeDownloadAdapter({ automationInstall: true });
    h.start.mockImplementationOnce(async () => {
      h.started.resolve();
      throw new Error("download failed");
    });
    const installed = vi.fn();
    h.events.on("start-install-download", installed);

    startDownloadFromURL(h.api, "https://cdn.example/mod.7z", true);
    await h.started.promise;
    await vi.advanceTimersByTimeAsync(250);

    expect(h.start).toHaveBeenCalledTimes(1);
    expect(installed).not.toHaveBeenCalled();
  });
});
