import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import Bluebird from "bluebird";
import { afterEach, expect, it, vi } from "vitest";

import {
  makeApiHarness,
  makeMod,
  makeProfile,
  registerHarnessGame,
  resetHarnessRegistries,
} from "../../test-utils/builders";
import type { IDialogResult } from "../../types/IDialog";
import type { IExtensionContext } from "../../types/IExtensionContext";
import { getGame } from "../gamemode_management/util/getGame";
import { profilesReducer } from "../profile_management/reducers/profiles";
import init from "./index";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  resetHarnessRegistries();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(sameNames: boolean) {
  const root = await mkdtemp(path.join(tmpdir(), "nyastra-recovery-"));
  roots.push(root);
  const deployPath = path.join(root, "game");
  const stagingPath = path.join(root, "staging");
  await Promise.all([mkdir(deployPath), mkdir(stagingPath)]);
  registerHarnessGame("game");
  getGame("game").queryModPath = () => deployPath;
  const source = sameNames ? "deployed" : "staging-deployed";
  const merged = sameNames ? "merged" : "staging-merged";
  await writeFile(
    path.join(deployPath, "vortex.deployment.json"),
    JSON.stringify({
      version: 1,
      instance: "recovery-test",
      files: [{ relPath: "config.ini", source, merged: [merged], time: 123 }],
    }),
  );
  const h = makeApiHarness(
    {
      activeProfileId: "p",
      profiles: {
        p: makeProfile({
          id: "p",
          gameId: "game",
          modState: {
            deployed: { enabled: false, enabledTime: 1 },
            merged: { enabled: false, enabledTime: 2 },
            unrelated: { enabled: true, enabledTime: 3 },
          },
        }),
      },
      mods: {
        game: {
          deployed: makeMod({ id: "deployed", installationPath: source }),
          merged: makeMod({ id: "merged", installationPath: merged }),
          unrelated: makeMod({ id: "unrelated", installationPath: "not-deployed" }),
        },
      },
      installPath: { game: stagingPath },
    },
    [{ path: ["persistent", "profiles"], reducer: profilesReducer }],
  );
  h.setState((state) => {
    state.app = { ...state.app, instanceId: "recovery-test" };
    state.settings.gameMode.discovered.game = { path: deployPath };
  });
  const response = Promise.withResolvers<IDialogResult>();
  const dialog = Bluebird.resolve(response.promise);
  const entered = Promise.withResolvers<void>();
  vi.spyOn(h.api, "showDialog").mockImplementation(() => {
    entered.resolve();
    return dialog;
  });
  let reset: () => unknown;
  init({
    api: h.api,
    once: () => undefined,
    registerSettings: () => undefined,
    registerAction: (...args) => {
      reset = args[5] as () => unknown;
    },
  } as unknown as IExtensionContext);
  return { h, reset: () => reset(), response, dialog, entered, deployPath };
}

it.each([false, true])(
  "restores record IDs from a real deployment manifest with sameNames=%s",
  async (sameNames) => {
    const { h, reset, response, dialog, entered } = await setup(sameNames);
    reset();
    try {
      await entered.promise;
    } finally {
      response.resolve({ action: "Continue", input: {} });
    }
    await dialog;
    const states = h.getState().persistent.profiles.p.modState;
    expect([states.deployed.enabled, states.merged.enabled, states.unrelated.enabled]).toEqual([
      true,
      true,
      false,
    ]);
    expect(h.errorNotifications).toEqual([]);
  },
);

it("leaves profile flags unchanged when reset is canceled", async () => {
  const { h, reset, response, dialog, entered } = await setup(false);
  const before = h.getState().persistent.profiles.p;
  reset();
  try {
    await entered.promise;
  } finally {
    response.resolve({ action: "Cancel", input: {} });
  }
  await dialog;
  expect(h.getState().persistent.profiles.p).toBe(before);
  expect(h.errorNotifications).toEqual([]);
});
