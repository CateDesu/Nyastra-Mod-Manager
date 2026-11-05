import type { IFileInfo } from "@nexusmods/nexus-api";
import type { types } from "@nexusmods/vortex-api";
import { util } from "@nexusmods/vortex-api";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  open: vi.fn<(url: string) => Promise<void>>(async () => undefined),
}));
vi.mock("@nexusmods/vortex-api", () => ({
  actions: {
    setPrimaryTool: (gameId: string, toolId: string) => ({ gameId, toolId }),
    setModsEnabled: async (
      api: any,
      profileId: string,
      ids: string[],
      _enable: boolean,
      options: any,
    ) => {
      if (options.isCurrent && !options.isCurrent()) return;
      api.getState().persistent.profiles[profileId].enabled.push(...ids);
    },
  },
  selectors: {
    lastActiveProfileForGame: (state: any, gameId: string) =>
      state.settings.profiles.lastActiveProfile[gameId],
    discoveryByGame: () => ({ tools: { smapi: { id: "smapi" } } }),
  },
  util: {
    opn: mocks.open,
    UserCanceled: class extends Error {},
    ProcessCanceled: class extends Error {},
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
  },
}));

import { downloadSMAPI } from "./download";
import { deploySMAPI } from "./lifecycle";
import { downloadAndInstallSMAPI } from "./workflow";

function harness() {
  const state = {
    settings: {
      profiles: { activeProfileId: "original", lastActiveProfile: { stardewvalley: "original" } },
    },
    persistent: {
      profiles: { original: { enabled: [] as string[] }, replacement: { enabled: [] as string[] } },
    },
  };
  const downloads: string[] = [];
  const deployments: string[] = [];
  const api = {
    getState: () => state,
    ext: {
      ensureLoggedIn: vi.fn<() => Promise<void>>(async () => undefined),
      nexusGetModFiles: vi.fn<() => Promise<Partial<IFileInfo>[]>>(async () => [
        {
          file_id: 10,
          category_id: 1,
          uploaded_time: "2026-01-01T00:00:00Z",
          uploaded_timestamp: 1767225600,
        },
        {
          file_id: 20,
          category_id: 1,
          uploaded_time: "2026-10-01T00:00:00Z",
          uploaded_timestamp: 1790812800,
        },
      ]),
    },
    events: {
      emit: (event: string, ...args: any[]) => {
        if (event === "start-download") {
          downloads.push(...args[0]);
          args[3](null, "archive");
        }
        if (event === "start-install-download") args[2](null, "smapi-mod");
        if (event === "deploy-mods") {
          deployments.push(args[1] ?? state.settings.profiles.activeProfileId);
          args[0](null);
        }
        if (event === "start-quick-discovery") args[0]();
        return true;
      },
    },
    store: { dispatch: vi.fn<(action: unknown) => void>() },
    showErrorNotification: vi.fn<(...args: unknown[]) => void>(),
    sendNotification: vi.fn<(...args: unknown[]) => void>(),
    dismissNotification: vi.fn<(id: string) => void>(),
  };
  return {
    api,
    state,
    downloads,
    deployments,
    extensionApi: api as unknown as types.IExtensionApi,
  };
}

beforeEach(() => vi.clearAllMocks());

test("SMAPI acquisition selects the newest main file", async () => {
  const { extensionApi, downloads } = harness();
  await downloadSMAPI(extensionApi);
  expect(downloads).toEqual(["nxm://stardewvalley/mods/2400/files/20"]);
});

test("canceling SMAPI acquisition stays canceled without opening the browser", async () => {
  const { api, extensionApi, deployments } = harness();
  api.ext.ensureLoggedIn.mockRejectedValue(new util.UserCanceled());
  await downloadAndInstallSMAPI(extensionApi);
  expect(api.showErrorNotification).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
  expect(deployments).toEqual([]);
  expect(api.dismissNotification).toHaveBeenCalledWith("smapi-installing");
});

for (const stage of ["start-download", "start-install-download"] as const) {
  test(`SMAPI does not enable or deploy for a replacement profile during ${stage}`, async () => {
    const { api, extensionApi, state, deployments } = harness();
    const waiting = Promise.withResolvers<(error: null, id: string) => void>();
    const emit = api.events.emit;
    vi.spyOn(api.events, "emit").mockImplementation((event, ...args) => {
      if (event === stage) {
        waiting.resolve(args[event === "start-download" ? 3 : 2]);
        return true;
      }
      return emit(event, ...args);
    });
    const pending = downloadAndInstallSMAPI(extensionApi);
    const finish = await waiting.promise;
    state.settings.profiles.activeProfileId = "replacement";
    state.settings.profiles.lastActiveProfile.stardewvalley = "replacement";
    finish(null, stage === "start-download" ? "archive" : "smapi-mod");
    await pending;
    expect(state.persistent.profiles.replacement.enabled).toEqual([]);
    expect(deployments).toEqual([]);
    expect(api.showErrorNotification).not.toHaveBeenCalled();
  });
}

test("deploying SMAPI names its Stardew profile even when another game is active", async () => {
  const { extensionApi, state, deployments } = harness();
  state.settings.profiles.activeProfileId = "another-game";
  await deploySMAPI(extensionApi);
  expect(deployments).toEqual(["original"]);
});

test("successful SMAPI acquisition enables and deploys the requested profile", async () => {
  const { extensionApi, state, deployments, api } = harness();
  await downloadAndInstallSMAPI(extensionApi);
  expect(state.persistent.profiles.original.enabled).toEqual(["smapi-mod"]);
  expect(state.persistent.profiles.replacement.enabled).toEqual([]);
  expect(deployments).toEqual(["original"]);
  expect(api.store.dispatch).toHaveBeenCalledWith({ gameId: "stardewvalley", toolId: "smapi" });
  expect(api.showErrorNotification).not.toHaveBeenCalled();
});

test("an actual SMAPI download error still reports the error and opens the manual fallback", async () => {
  const { extensionApi, api, deployments } = harness();
  const error = new Error("connection reset");
  api.ext.nexusGetModFiles.mockRejectedValue(error);
  await downloadAndInstallSMAPI(extensionApi);
  expect(api.showErrorNotification).toHaveBeenCalledWith("Failed to download/install SMAPI", error);
  expect(mocks.open).toHaveBeenCalled();
  expect(deployments).toEqual([]);
});
