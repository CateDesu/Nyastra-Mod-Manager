import type { IFileInfo } from "@nexusmods/nexus-api";
import type { types } from "@nexusmods/vortex-api";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  open: vi.fn<(url: string) => Promise<void>>(async () => undefined),
}));

vi.mock("@nexusmods/vortex-api", () => ({
  actions: {
    setModsEnabled: mocks.enabled,
    setPrimaryTool: (gameId: string, toolId: string) => ({ gameId, toolId }),
  },
  selectors: {
    discoveryByGame: () => ({}),
    lastActiveProfileForGame: (state: {
      settings: { profiles: { lastActiveProfile: { skyrimse: string } } };
    }) => state.settings.profiles.lastActiveProfile.skyrimse,
    gameById: () => ({ name: "Skyrim SE" }),
  },
  log: vi.fn<(...args: unknown[]) => void>(),
  util: {
    getGame: () => ({ getInstalledVersion: async () => "1.6.1170.0" }),
    getSafe: (state: { persistent: { nexus: { userInfo: unknown } } }) =>
      state.persistent.nexus.userInfo,
    opn: mocks.open,
    toPromise: (invoke: (cb: (error: Error | null, value?: string) => void) => void) =>
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
    DataInvalid: class extends Error {},
  },
}));
vi.mock("./util", () => ({ getGameStore: () => "steam" }));

import { downloadScriptExtender } from "./nexusModsDownloader";
import type { IGameSupport } from "./types";

const support = {
  gameId: "skyrimse",
  name: "SKSE",
  toolId: "skse64",
  nexusMods: { gameId: "skyrimspecialedition", modId: 30379 },
} as IGameSupport;

function harness(loggedIn = true) {
  const downloaded: string[] = [];
  const discovered = vi.fn<() => void>();
  const state = {
    persistent: { nexus: { userInfo: loggedIn ? { isPremium: true } : undefined } },
    confidential: { account: { nexus: { APIKey: loggedIn ? "synthetic-key" : undefined } } },
    settings: { profiles: { lastActiveProfile: { skyrimse: "profile" } } },
  };
  const api = {
    getState: () => state,
    ext: {
      nexusGetModFiles: vi.fn<() => Promise<Partial<IFileInfo>[]>>(async () => [
        {
          file_id: 42,
          description: "Steam build",
          category_name: "MAIN",
          version: "2.2.6",
          uploaded_timestamp: 1,
        },
      ]),
    },
    translate: (message: string) => message,
    showDialog: vi.fn<() => Promise<{ action: string; input: { "42": boolean } }>>(async () => ({
      action: "Download",
      input: { "42": true },
    })),
    events: {
      emit: (event: string, ...args: unknown[]) => {
        if (event === "start-download") {
          downloaded.push(...(args[0] as string[]));
          (args[3] as (error: null, id: string) => void)(null, "archive");
        }
        if (event === "start-install-download")
          (args[2] as (error: null, id: string) => void)(null, "extender-mod");
        if (event === "start-quick-discovery") {
          discovered();
          (args[0] as () => void)();
        }
        return true;
      },
    },
    store: { dispatch: vi.fn<(action: unknown) => void>() },
    emitAndAwait: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
    showErrorNotification: vi.fn<(...args: unknown[]) => void>(),
  };
  return {
    api,
    state,
    downloaded,
    discovered,
    run: () => downloadScriptExtender(api as unknown as types.IExtensionApi, support),
  };
}

beforeEach(() => vi.clearAllMocks());

test("installs the file selected when the version cannot be matched automatically", async () => {
  const { api, run, downloaded } = harness();
  await run();
  expect(api.showDialog).toHaveBeenCalled();
  expect(downloaded).toEqual(["nxm://skyrimspecialedition/mods/30379/files/42"]);
  expect(mocks.open).not.toHaveBeenCalled();
  expect(api.emitAndAwait).toHaveBeenCalledWith(
    "deploy-single-mod",
    "skyrimse",
    "extender-mod",
    true,
  );
});

test("canceling version selection leaves the existing primary tool alone", async () => {
  const { api, run, downloaded, discovered } = harness();
  api.showDialog.mockResolvedValue({ action: "Cancel", input: { "42": true } });
  await run();
  expect(downloaded).toEqual([]);
  expect(api.store.dispatch).not.toHaveBeenCalled();
  expect(discovered).not.toHaveBeenCalled();
  expect(api.showErrorNotification).not.toHaveBeenCalled();
});

test("opening the website while logged out does not select an uninstalled tool", async () => {
  const { api, run, discovered } = harness(false);
  await run();
  expect(mocks.open).toHaveBeenCalledWith(
    "https://www.nexusmods.com/skyrimspecialedition/mods/30379?tab=files",
  );
  expect(api.store.dispatch).not.toHaveBeenCalled();
  expect(discovered).not.toHaveBeenCalled();
});

test("a file listing failure opens the website without changing the primary tool", async () => {
  const { api, run, discovered } = harness();
  api.ext.nexusGetModFiles.mockRejectedValue(new Error("connection reset"));
  await run();
  expect(mocks.open).toHaveBeenCalled();
  expect(api.store.dispatch).not.toHaveBeenCalled();
  expect(discovered).not.toHaveBeenCalled();
});

for (const stage of ["start-download", "start-install-download"] as const) {
  test(`switching profiles during ${stage} does not enable or deploy into the new profile`, async () => {
    const { api, state, run } = harness();
    const waiting = Promise.withResolvers<(error: null, id: string) => void>();
    const emit = api.events.emit;
    vi.spyOn(api.events, "emit").mockImplementation((event, ...args) => {
      if (event === stage) {
        waiting.resolve(
          args[event === "start-download" ? 3 : 2] as (error: null, id: string) => void,
        );
        return true;
      }
      return emit(event, ...args);
    });
    const pending = run();
    const finish = await waiting.promise;
    state.settings.profiles.lastActiveProfile.skyrimse = "other-profile";
    finish(null, stage === "start-download" ? "archive" : "extender-mod");
    await pending;
    expect(mocks.enabled).not.toHaveBeenCalled();
    expect(api.emitAndAwait).not.toHaveBeenCalled();
    expect(api.store.dispatch).not.toHaveBeenCalled();
    expect(api.showErrorNotification).not.toHaveBeenCalled();
  });
}
