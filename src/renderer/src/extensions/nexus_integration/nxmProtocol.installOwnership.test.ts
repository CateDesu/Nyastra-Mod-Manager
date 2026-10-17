import { writeFile } from "node:fs/promises";

import type NexusT from "@nexusmods/nexus-api";
import { describe, expect, vi } from "vitest";

import { makeGameStored, makeNxmHarness, makeProfile } from "../../test-utils/builders";
import { test } from "../../test-utils/downloadAdapterTest";
import type { IExtensionApi } from "../../types/IExtensionContext";
import { setDownloadModInfo } from "../download_management/actions/state";
import type { RedownloadMode } from "../download_management/types/IDownload";
import { NxmProtocol } from "./nxmProtocol";
import type * as nexusUtil from "./util";
import { startDownload } from "./util";

vi.mock("./util", async (importOriginal) => ({
  ...(await importOriginal<typeof nexusUtil>()),
  ensureLoggedIn: vi.fn(() => Promise.resolve()),
  startDownload: vi.fn(
    (
      api: IExtensionApi,
      _nexus: NexusT,
      url: string,
      _redownload?: RedownloadMode,
      _filename?: string,
      allowInstall?: boolean,
    ) =>
      new Promise<string>((resolve, reject) => {
        api.events.emit(
          "start-download",
          [url],
          { game: "skyrimse", source: "nexus" },
          "mod.7z",
          (error: Error | null, downloadId: string) =>
            error === null ? resolve(downloadId) : reject(error),
          undefined,
          { allowInstall },
        );
      }),
  ),
}));

describe("NXM download installation ownership", () => {
  for (const automationInstall of [false, true]) {
    for (const install of [false, true]) {
      test(`install=${install} automation=${automationInstall} installs at most once`, async ({
        makeDownloadAdapter,
      }) => {
        const harness = makeDownloadAdapter({ automationInstall });
        const profile = makeProfile({ id: "nxm-download", gameId: "skyrimse" });
        harness.setState((draft) => {
          draft.persistent.profiles[profile.id] = profile;
          draft.settings.profiles.activeProfileId = profile.id;
          draft.session.gameMode.known = [makeGameStored()];
        });
        harness.adapter.registerProtocol("nxm", () =>
          Promise.resolve({ urls: ["https://cdn.example/mod.7z"], meta: {} }),
        );
        const { nexus } = makeNxmHarness();
        const nxm = new NxmProtocol(harness.api, () => nexus);
        const installed = vi.fn();
        harness.events.on("start-install-download", installed);
        const url = "nxm://skyrimspecialedition/mods/100/files/500";

        void nxm.handleLink(url, install);
        await harness.started.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(installed).not.toHaveBeenCalled();

        await writeFile(harness.start.mock.calls[0][0] as string, Buffer.alloc(100));
        const downloadId = "new-0";
        harness.getStates.mockResolvedValue({
          [downloadId]: {
            status: "completed",
            bytesReceived: 100,
            size: 100,
            error: null,
            fileName: undefined,
            isChunked: false,
          },
        });
        await vi.waitFor(() => {
          expect(harness.getState().persistent.downloads.files[downloadId].state).toBe("finished");
          // NXM tags the record after the download completion callback resumes.
          expect(harness.dispatched).toContainEqual(
            setDownloadModInfo(downloadId, "source", "nexus"),
          );
        });
        expect(installed).toHaveBeenCalledTimes(install || automationInstall ? 1 : 0);
        expect(startDownload).toHaveBeenCalledWith(
          harness.api,
          nexus,
          url,
          undefined,
          undefined,
          install ? false : undefined,
        );
      });
    }
  }
});
