import { expect, test, vi } from "vitest";

import type { IState } from "../../../types/IState";
import opn from "../../../util/opn";
import type { IDownload } from "../types/IDownload";

vi.mock("../../../controls/ComponentEx", async (original) => ({
  ...(await original<object>()),
  connect: () => (component: unknown) => component,
  translate: () => (component: unknown) => component,
}));
vi.mock("../../../util/opn", () => ({ default: vi.fn(async (_url: string) => undefined) }));

import DownloadView from "./DownloadView";

const state = {
  session: {
    gameMode: {
      known: [
        { id: "skyrimse", details: { nxmLinkId: "SkyrimSE", nexusPageId: "skyrimspecialedition" } },
      ],
    },
  },
} as unknown as IState;

for (const metadata of [false, true]) {
  test(`opens a download's file under its Nexus domain with metadata=${metadata}`, () => {
    const download = {
      game: ["skyrimse"],
      modInfo: metadata
        ? { meta: { details: { modId: 518, fileId: 42 } } }
        : { nexus: { ids: { gameId: "SkyrimSE", modId: 518, fileId: 42 } } },
    } as unknown as IDownload;
    const View = DownloadView as unknown as new (props: object) => {
      context: object;
      openModPage: (id: string) => void;
    };
    const view = new View({ downloads: { archive: download } });
    view.context = { api: { store: { getState: () => state } } };
    view.openModPage("archive");
    expect(opn).toHaveBeenLastCalledWith(
      "https://www.nexusmods.com/skyrimspecialedition/mods/518?tab=files&file_id=42&nmm=1",
    );
  });
}
