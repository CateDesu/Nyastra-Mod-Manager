import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import Bluebird from "bluebird";
import { afterEach, expect, it, vi } from "vitest";

import { makeApiHarness, makeProfile, resetHarnessRegistries } from "../../test-utils/builders";
import type { IExtensionContext } from "../../types/IExtensionContext";
import * as fs from "../../util/fs";
import * as paths from "../../util/getVortexPath";
import { purgeMods } from "../mod_management/util/deploy";
import init from "./index";
import { profilesReducer } from "./reducers/profiles";
import { settingsReducer } from "./reducers/settings";
import { profilePath } from "./util/manage";

vi.mock("../mod_management/util/deploy", () => ({
  purgeMods: vi.fn().mockResolvedValue(undefined),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  resetHarnessRegistries();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("allows a retained profile to sync again after Stop Managing fails to remove it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nyastra-unmanage-profile-"));
  roots.push(root);
  const original = paths.default;
  vi.spyOn(paths, "default").mockImplementation((id) => (id === "userData" ? root : original(id)));
  const h = makeApiHarness(
    { profiles: { p: makeProfile({ id: "p", gameId: "game" }) }, mods: { game: {} } },
    [
      { path: ["persistent", "profiles"], reducer: profilesReducer },
      { path: ["settings", "profiles"], reducer: settingsReducer },
    ],
  );
  h.setNextDialog({ action: "Delete profiles", input: {} });
  const directory = profilePath(h.getState().persistent.profiles.p);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "settings.ini"), "kept profile settings");
  let unmanage: (gameId: string) => PromiseLike<void>;
  const context: Partial<IExtensionContext> = {
    api: h.api,
    registerAPI: (name, callback) => {
      if (name === "unmanageGame") unmanage = callback;
    },
  };
  init(
    new Proxy(context, {
      get: (target, key) => Reflect.get(target, key) ?? (() => undefined),
    }) as IExtensionContext,
  );
  const failure = Object.assign(new Error("fixture removal denied"), { code: "EACCES" });
  const fault = vi.spyOn(fs, "removeAsync").mockImplementationOnce(() => Bluebird.reject(failure));
  await unmanage("game");
  expect(purgeMods).toHaveBeenCalledWith(h.api, "game", true);
  expect(h.errorNotifications).toEqual([
    expect.objectContaining({ title: "Failed to remove profile", message: failure }),
  ]);
  expect(h.getState().persistent.profiles.p.pendingRemove).not.toBe(true);
  expect(await readFile(path.join(directory, "settings.ini"), "utf8")).toBe(
    "kept profile settings",
  );
  fault.mockRestore();
  await unmanage("game");
  expect(h.getState().persistent.profiles.p).toBeUndefined();
});
