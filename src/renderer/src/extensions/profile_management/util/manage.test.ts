import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import Bluebird from "bluebird";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { makeApiHarness, makeProfile, resetHarnessRegistries } from "../../../test-utils/builders";
import type { IExtensionApi } from "../../../types/IExtensionContext";
import * as fs from "../../../util/fs";
import * as paths from "../../../util/getVortexPath";
import { setProfile } from "../actions/profiles";
import { setCurrentProfile } from "../actions/settings";
import { profilesReducer } from "../reducers/profiles";
import { settingsReducer } from "../reducers/settings";
import { profilePath, removeProfile } from "./manage";

let h: ReturnType<typeof makeApiHarness>;
let completed: PromiseLike<unknown>;
let root: string;
const api = {
  getState: () => h.api.getState(),
  get store() {
    return h.api.store;
  },
  showErrorNotification: (...args) => h.api.showErrorNotification(...args),
  withPrePost:
    (_event, callback) =>
    (...args) => {
      completed = callback(...args);
      return completed;
    },
} as IExtensionApi;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nyastra-remove-profile-"));
  const original = paths.default;
  vi.spyOn(paths, "default").mockImplementation((id) => (id === "userData" ? root : original(id)));
  h = makeApiHarness(
    {
      activeProfileId: "active",
      profiles: {
        active: makeProfile({ id: "active", gameId: "active-game" }),
        removed: makeProfile({ id: "removed", gameId: "other-game" }),
      },
    },
    [
      { path: ["persistent", "profiles"], reducer: profilesReducer },
      { path: ["settings", "profiles"], reducer: settingsReducer },
    ],
  );
  h.setState((state) => {
    state.settings.profiles.lastActiveProfile = {
      "active-game": "active",
      "other-game": "removed",
    };
  });
  const directory = profilePath(h.getState().persistent.profiles.removed);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "settings.ini"), "retained settings");
});

afterEach(async () => {
  await completed;
  vi.restoreAllMocks();
  resetHarnessRegistries();
  await rm(root, { recursive: true, force: true });
});

it("clears the removed game's last profile while another game is active", async () => {
  removeProfile(api, "removed");
  await completed;
  expect(h.getState().persistent.profiles.removed).toBeUndefined();
  expect(h.getState().settings.profiles.lastActiveProfile).toEqual({ "active-game": "active" });
  expect(h.getState().settings.profiles.activeProfileId).toBe("active");
  expect(h.errorNotifications).toEqual([]);
});

it("keeps a failed removal usable and preserves edits made while deletion waits", async () => {
  const failure = Object.assign(new Error("fixture removal denied"), { code: "EACCES" });
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  vi.spyOn(fs, "removeAsync").mockImplementationOnce(() => {
    entered.resolve();
    return Bluebird.resolve(gate.promise).then(() => {
      throw failure;
    });
  });
  removeProfile(api, "removed");
  try {
    await entered.promise;
    expect(h.getState().persistent.profiles.removed.pendingRemove).toBe(true);
    h.api.store.dispatch(
      setProfile({ ...h.getState().persistent.profiles.removed, name: "Edited while waiting" }),
    );
  } finally {
    gate.resolve();
    await completed;
  }
  expect(h.errorNotifications).toEqual([
    expect.objectContaining({ title: "Failed to remove profile", message: failure }),
  ]);
  const profile = h.getState().persistent.profiles.removed;
  expect(profile.pendingRemove).not.toBe(true);
  expect(profile.name).toBe("Edited while waiting");
  expect(await readFile(path.join(profilePath(profile), "settings.ini"), "utf8")).toBe(
    "retained settings",
  );
  expect(h.getState().settings.profiles.lastActiveProfile["other-game"]).toBe("removed");
  removeProfile(api, "removed");
  await completed;
  expect(h.getState().persistent.profiles.removed).toBeUndefined();
});

it("keeps a newer last active profile selected while deletion is pending", async () => {
  h.api.store.dispatch(setCurrentProfile("other-game", "removed"));
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const remove = fs.removeAsync;
  vi.spyOn(fs, "removeAsync").mockImplementationOnce((target) => {
    entered.resolve();
    return Bluebird.resolve(gate.promise).then(() => remove(target));
  });
  removeProfile(api, "removed");
  try {
    await entered.promise;
    h.api.store.dispatch(setProfile(makeProfile({ id: "newer", gameId: "other-game" })));
    h.api.store.dispatch(setCurrentProfile("other-game", "newer"));
  } finally {
    gate.resolve();
    await completed;
  }
  expect(h.getState().persistent.profiles.removed).toBeUndefined();
  expect(h.getState().settings.profiles.lastActiveProfile["other-game"]).toBe("newer");
  expect(h.getState().settings.profiles.activeProfileId).toBe("newer");
});
