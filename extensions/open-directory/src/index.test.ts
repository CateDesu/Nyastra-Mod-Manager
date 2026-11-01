import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { util, type types } from "@nexusmods/vortex-api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import init from "./index";

vi.mock("./gameSupport", () => ({ initGameSupport: vi.fn<() => void>() }));

let stagingPath: string;
beforeEach(async () => {
  vi.clearAllMocks();
  stagingPath = await mkdtemp(path.join(tmpdir(), "nyastra-open-directory-"));
});
afterEach(async () => {
  await rm(stagingPath, { recursive: true, force: true });
});

function registerOpenMod(mod: object) {
  const state = { stagingPath, persistent: { mods: { "test-game": { "mod-id": mod } } } };
  const registerAction = vi.fn<types.IExtensionContext["registerAction"]>();
  init({
    registerAction,
    api: { store: { getState: () => state } },
  } as unknown as types.IExtensionContext);
  const registration = registerAction.mock.calls.find(
    ([group, , , , title]) => group === "mods-action-icons" && title === "Open in File Manager",
  )!;
  return { action: registration[5], condition: registration[6] };
}

it.each(["mod-id", "original-staging-folder"])(
  "opens the selected mod's installation directory: %s",
  async (installationPath) => {
    const target = path.join(stagingPath, installationPath);
    await mkdir(target);
    const { action, condition } = registerOpenMod({ id: "mod-id", installationPath });
    expect(condition(["mod-id"])).toBe(true);
    action(["mod-id"]);
    await vi.waitFor(() => expect(util.opn).toHaveBeenCalledTimes(1), { timeout: 1000 });
    expect(util.opn).toHaveBeenCalledWith(target);
  },
);

it("falls back to the staging folder when the mod directory is missing", async () => {
  const { action } = registerOpenMod({ id: "mod-id", installationPath: "missing-folder" });
  action(["mod-id"]);
  await vi.waitFor(() => expect(util.opn).toHaveBeenCalledTimes(1), { timeout: 1000 });
  expect(util.opn).toHaveBeenCalledWith(stagingPath);
});
