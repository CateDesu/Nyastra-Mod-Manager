import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { types } from "@nexusmods/vortex-api";
import { fs } from "@nexusmods/vortex-api";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@nexusmods/vortex-api", async () => {
  const filesystem = await import("node:fs/promises");
  return {
    fs: {
      copyAsync: (source: string, destination: string) => filesystem.copyFile(source, destination),
      statAsync: filesystem.stat,
      removeAsync: (file: string) => filesystem.rm(file, { recursive: true, force: true }),
      rmdirAsync: filesystem.rmdir,
    },
    actions: {
      setModAttribute: (gameId: string, modId: string, key: string, value: unknown) => ({
        gameId,
        modId,
        key,
        value,
      }),
    },
    selectors: {
      profileById: (state: any, id: string) => state.persistent.profiles[id],
      installPathForGame: (state: any) => state.installPath,
    },
    util: {
      getSafe: (state: any, keys: string[], fallback: unknown) =>
        keys.reduce((value, key) => value?.[key], state) ?? fallback,
    },
    log: vi.fn<(...args: unknown[]) => void>(),
  };
});

import { GAME_ID, MOD_TYPE_CONFIG } from "../common";
import { onWillEnableMods } from "./index";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(relative = "Selected") {
  const root = await mkdtemp(path.join(tmpdir(), "nyastra-sdv-restore-"));
  roots.push(root);
  const installPath = path.join(root, "staging");
  const configRoot = path.join(installPath, "config-staging");
  const modRoot = path.join(installPath, "selected-staging");
  const selected = path.join(configRoot, relative, "config.json");
  const destination = path.join(modRoot, relative, "config.json");
  const other = path.join(configRoot, relative, "Child", "config.json");
  await mkdir(path.dirname(selected), { recursive: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(path.dirname(other), { recursive: true });
  await writeFile(selected, '{"owner":"selected","value":37}');
  await writeFile(other, '{"owner":"other","value":91}');
  await writeFile(path.join(modRoot, relative, "manifest.json"), '{"Name":"Selected"}');
  const configMod = {
    id: "config",
    installationPath: "config-staging",
    type: MOD_TYPE_CONFIG,
    attributes: { configMod: ["selected", "other"] },
  };
  const state = {
    installPath,
    settings: { SDV: { mergeConfigs: { profile: true } } },
    persistent: {
      profiles: { profile: { id: "profile", gameId: GAME_ID } },
      mods: {
        [GAME_ID]: {
          config: configMod,
          selected: { id: "selected", installationPath: "selected-staging" },
        },
      },
    },
  };
  const emitAndAwait = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
  const showErrorNotification = vi.fn<(...args: unknown[]) => void>();
  const api = {
    getState: () => state,
    store: {
      getState: () => state,
      dispatch: (action: { modId: string; key: string; value: string[] }) => {
        if (action.modId === "config" && action.key === "configMod")
          configMod.attributes.configMod = action.value;
      },
    },
    emitAndAwait,
    showErrorNotification,
  } as unknown as types.IExtensionApi;
  return {
    root,
    configRoot,
    selected,
    destination,
    other,
    configMod,
    api,
    emitAndAwait,
    showErrorNotification,
  };
}

describe("Stardew config restoration", () => {
  it.each(["Selected", "."])(
    "restores %s without removing another mod's configuration",
    async (relative) => {
      const context = await fixture(relative);
      await onWillEnableMods(context.api, "profile", ["selected"], false);
      expect(context.showErrorNotification).not.toHaveBeenCalled();
      expect(await readFile(context.destination, "utf8")).toBe('{"owner":"selected","value":37}');
      expect(await readFile(context.other, "utf8")).toBe('{"owner":"other","value":91}');
      await expect(readFile(context.selected)).rejects.toMatchObject({ code: "ENOENT" });
      expect(context.configMod.attributes.configMod).toEqual(["other"]);
      expect(context.emitAndAwait.mock.calls).toEqual([
        ["deploy-single-mod", GAME_ID, "config", false],
        ["deploy-single-mod", GAME_ID, "config", true],
      ]);
    },
  );

  it("preserves source bytes and tracking after an actual copy failure, then retries", async () => {
    const context = await fixture();
    await mkdir(context.destination);
    await expect(
      onWillEnableMods(context.api, "profile", ["selected"], false),
    ).rejects.toMatchObject({ code: "EISDIR" });
    expect(await readFile(context.selected, "utf8")).toBe('{"owner":"selected","value":37}');
    expect(await readFile(context.other, "utf8")).toBe('{"owner":"other","value":91}');
    expect(context.configMod.attributes.configMod).toEqual(["selected", "other"]);
    expect(context.showErrorNotification).toHaveBeenCalledOnce();
    expect(context.showErrorNotification.mock.calls[0]?.[1]).toMatchObject({ code: "EISDIR" });
    expect(context.emitAndAwait).not.toHaveBeenCalled();
    await rm(context.destination, { recursive: true });
    await onWillEnableMods(context.api, "profile", ["selected"], false);
    expect(await readFile(context.destination, "utf8")).toBe('{"owner":"selected","value":37}');
    expect(context.configMod.attributes.configMod).toEqual(["other"]);
  });

  it("retains tracking and redeploys after a config edit fails", async () => {
    const context = await fixture();
    const failure = Object.assign(new Error("config is not writable"), { code: "EACCES" });
    vi.spyOn(fs, "removeAsync").mockRejectedValueOnce(failure);
    await expect(onWillEnableMods(context.api, "profile", ["selected"], false)).rejects.toBe(
      failure,
    );
    expect(context.configMod.attributes.configMod).toEqual(["selected", "other"]);
    expect(await readFile(context.selected, "utf8")).toBe('{"owner":"selected","value":37}');
    expect(context.showErrorNotification).toHaveBeenCalledWith(
      "Failed to write mod config",
      failure,
    );
    expect(context.emitAndAwait.mock.calls).toEqual([
      ["deploy-single-mod", GAME_ID, "config", false],
      ["deploy-single-mod", GAME_ID, "config", true],
    ]);
  });

  it("leaves configuration untouched when the mod will be replaced", async () => {
    const context = await fixture();
    await onWillEnableMods(context.api, "profile", ["selected"], false, { willBeReplaced: true });
    expect(await readFile(context.selected, "utf8")).toBe('{"owner":"selected","value":37}');
    expect(await readFile(context.other, "utf8")).toBe('{"owner":"other","value":91}');
    expect(context.configMod.attributes.configMod).toEqual(["selected", "other"]);
    expect(context.emitAndAwait).not.toHaveBeenCalled();
  });

  it("restores every manifest in a bundled mod and tolerates a missing optional config", async () => {
    const context = await fixture();
    const staging = path.join(context.root, "staging", "selected-staging");
    const second = path.join(context.configRoot, "Second", "config.json");
    await mkdir(path.dirname(second));
    await mkdir(path.join(staging, "Second"));
    await mkdir(path.join(staging, "NoConfig"));
    await writeFile(second, '{"owner":"second","value":58}');
    await writeFile(path.join(staging, "Second", "manifest.json"), '{"Name":"Second"}');
    await writeFile(path.join(staging, "NoConfig", "manifest.json"), '{"Name":"NoConfig"}');
    await onWillEnableMods(context.api, "profile", ["selected"], false);
    expect(await readFile(context.destination, "utf8")).toBe('{"owner":"selected","value":37}');
    expect(await readFile(path.join(staging, "Second", "config.json"), "utf8")).toBe(
      '{"owner":"second","value":58}',
    );
    expect(await readFile(context.other, "utf8")).toBe('{"owner":"other","value":91}');
    await expect(readFile(second)).rejects.toMatchObject({ code: "ENOENT" });
    expect(context.configMod.attributes.configMod).toEqual(["other"]);
  });

  it("keeps ownership for a missing mod and for a mod without a manifest", async () => {
    const context = await fixture();
    await rm(path.join(path.dirname(context.destination), "manifest.json"));
    await onWillEnableMods(context.api, "profile", ["selected", "other"], false);
    expect(await readFile(context.selected, "utf8")).toBe('{"owner":"selected","value":37}');
    expect(context.configMod.attributes.configMod).toEqual(["selected", "other"]);
    expect(context.emitAndAwait).not.toHaveBeenCalled();
  });

  it("keeps completed copies and retries the remaining files after a partial failure", async () => {
    const context = await fixture();
    const staging = path.join(context.root, "staging", "selected-staging");
    const second = path.join(context.configRoot, "Second", "config.json");
    const secondDestination = path.join(staging, "Second", "config.json");
    await mkdir(path.dirname(second));
    await mkdir(path.dirname(secondDestination));
    await writeFile(second, '{"owner":"second","value":58}');
    await writeFile(path.join(staging, "Second", "manifest.json"), '{"Name":"Second"}');
    const copy = fs.copyAsync;
    let attempts = 0;
    let completedDestination: string;
    vi.spyOn(fs, "copyAsync").mockImplementation((source, destination, options) => {
      attempts += 1;
      if (attempts === 2) return copy(source, path.join(destination, "missing"), options);
      completedDestination = destination;
      return copy(source, destination, options);
    });
    await expect(
      onWillEnableMods(context.api, "profile", ["selected"], false),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(attempts).toBe(2);
    expect(await readFile(completedDestination!, "utf8")).toMatch(/"owner":"(selected|second)"/);
    expect(context.configMod.attributes.configMod).toEqual(["selected", "other"]);
    vi.restoreAllMocks();
    await onWillEnableMods(context.api, "profile", ["selected"], false);
    expect(await readFile(secondDestination, "utf8")).toBe('{"owner":"second","value":58}');
    expect(await readFile(context.destination, "utf8")).toBe('{"owner":"selected","value":37}');
    expect(await readFile(context.other, "utf8")).toBe('{"owner":"other","value":91}');
    expect(context.configMod.attributes.configMod).toEqual(["other"]);
  });

  it("keeps the source when the destination disappears after the manifest scan", async () => {
    const context = await fixture();
    const copy = fs.copyAsync;
    vi.spyOn(fs, "copyAsync").mockImplementationOnce((source, destination) =>
      fs.removeAsync(path.dirname(destination)).then(() => copy(source, destination)),
    );
    await expect(
      onWillEnableMods(context.api, "profile", ["selected"], false),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(context.selected, "utf8")).toBe('{"owner":"selected","value":37}');
    expect(context.configMod.attributes.configMod).toEqual(["selected", "other"]);
    expect(context.emitAndAwait).not.toHaveBeenCalled();
  });
});
