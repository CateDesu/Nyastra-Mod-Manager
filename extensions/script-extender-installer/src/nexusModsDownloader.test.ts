import type { types } from "@nexusmods/vortex-api";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()),
  open: vi.fn<(url: string) => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("@nexusmods/vortex-api", () => ({
  actions: {
    setModsEnabled: mocks.enabled,
    setPrimaryTool: (gameId: string, toolId: string) => ({ gameId, toolId }),
  },
  selectors: { discoveryByGame: () => ({}), lastActiveProfileForGame: () => "profile" },
  log: vi.fn<(...args: unknown[]) => void>(),
  util: {
    getGame: () => ({ getInstalledVersion: async () => "1.6.1170.0" }),
    getSafe: (state: { persistent: { nexus: { userInfo: object } } }) =>
      state.persistent.nexus.userInfo,
    opn: mocks.open,
    toPromise: (invoke: (cb: (error: Error | null, value: string) => void) => void) =>
      new Promise((resolve, reject) =>
        invoke((error, value) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(value);
        }),
      ),
    UserCanceled: class extends Error {},
    ProcessCanceled: class extends Error {},
  },
}));
vi.mock("./util", () => ({ getGameStore: () => "steam" }));

import { downloadScriptExtender } from "./nexusModsDownloader";
import type { IGameSupport } from "./types";

beforeEach(() => vi.clearAllMocks());

for (const credential of ["OAuthCredentials", "APIKey"] as const) {
  test(`deploys the installed extender before discovery with ${credential}`, async () => {
    const order: string[] = [];
    const emitAndAwait = vi.fn<(...args: unknown[]) => Promise<void>>(async (..._args) => {
      order.push("deploy");
    });
    const dispatch = vi.fn<(action: unknown) => void>();
    const api = {
      getState: () => ({
        persistent: { nexus: { userInfo: { isPremium: true } } },
        confidential: { account: { nexus: { [credential]: "synthetic-credential" } } },
      }),
      ext: {
        nexusGetModFiles: vi.fn<() => Promise<Array<{ file_id: number; description: string }>>>(
          async () => [{ file_id: 42, description: "1.6.1170 Steam" }],
        ),
      },
      events: {
        emit: (event: string, ...args: unknown[]) => {
          if (event === "start-download")
            (args[3] as (error: null, id: string) => void)(null, "archive");
          if (event === "start-install-download")
            (args[2] as (error: null, id: string) => void)(null, "extender-mod");
          if (event === "start-quick-discovery") {
            order.push("discovery");
            (args[0] as () => void)();
          }
        },
      },
      store: { dispatch },
      emitAndAwait,
      showErrorNotification: vi.fn<(...args: unknown[]) => void>(),
    } as unknown as types.IExtensionApi;
    await downloadScriptExtender(api, {
      gameId: "skyrimse",
      name: "SKSE",
      toolId: "skse",
      nexusMods: { gameId: "skyrimspecialedition", modId: 518 },
    } as IGameSupport);
    expect(api.showErrorNotification).not.toHaveBeenCalled();
    expect(emitAndAwait).toHaveBeenCalledWith(
      "deploy-single-mod",
      "skyrimse",
      "extender-mod",
      true,
    );
    expect(mocks.enabled).toHaveBeenCalledWith(api, "profile", ["extender-mod"], true, {
      allowAutoDeploy: false,
      installed: true,
      isCurrent: expect.any(Function),
    });
    expect(order).toEqual(["deploy", "discovery"]);
    expect(mocks.open).not.toHaveBeenCalled();
  });
}
