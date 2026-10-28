import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { types } from "@nexusmods/vortex-api";
import { afterEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({ documents: "", userData: "" }));

vi.mock("@nexusmods/vortex-api", async () => {
  const filesystem = await import("node:fs/promises");
  const { default: PromiseBB } = await import("bluebird");
  return {
    fs: {
      copyAsync: (source: string, destination: string) =>
        PromiseBB.resolve(filesystem.copyFile(source, destination)),
      statAsync: (file: string) => PromiseBB.resolve(filesystem.stat(file)),
    },
    log: vi.fn<(...args: unknown[]) => void>(),
    selectors: {
      discoveryByGame: (state: any, gameId: string) => state.settings.gameMode.discovered[gameId],
      activeGameId: (state: any) =>
        state.persistent.profiles[state.settings.profiles.activeProfileId]?.gameId,
      activeProfile: (state: any) =>
        state.persistent.profiles[state.settings.profiles.activeProfileId],
      lastActiveProfileForGame: () => undefined,
    },
    util: {
      getVortexPath: (key: keyof typeof paths) => paths[key],
      getSafe: (state: any, keys: string[], fallback: unknown) =>
        keys.reduce((value, key) => value?.[key], state) ?? fallback,
      unique: (values: any[], key: (value: any) => string) =>
        values.filter(
          (value, index) => values.findIndex((other) => key(other) === key(value)) === index,
        ),
      sortMods: async (_game: string, mods: unknown[]) => mods,
      showError: vi.fn<(...args: unknown[]) => void>(),
      UserCanceled: class extends Error {},
      CycleError: class extends Error {},
      makeOverlayableDictionary: (base: any, layers: any, deduce: (game: string) => string) => ({
        has: (game: string) => base[game] !== undefined,
        get: (game: string, key: string) =>
          layers[deduce(game)]?.[game]?.[key] ?? base[game]?.[key],
      }),
    },
  };
});

import init from "./index";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("profile game settings on Linux", () => {
  it.each([
    { proton: true, store: "steam", directory: "Skyrim Special Edition" },
    { proton: true, store: "gog", directory: "Skyrim Special Edition GOG" },
    { proton: false, store: "steam", directory: "Skyrim Special Edition" },
  ])(
    "swaps the discovered game's files with $store and proton=$proton",
    async ({ proton, store, directory }) => {
      const root = await mkdtemp(path.join(tmpdir(), "nyastra-settings-"));
      roots.push(root);
      paths.documents = path.join(root, "host-documents");
      paths.userData = path.join(root, "user-data");
      const prefix = path.join(root, "proton-prefix");
      const host = path.join(paths.documents, "My Games", directory);
      const game = proton
        ? path.join(prefix, "drive_c", "users", "steamuser", "Documents", "My Games", directory)
        : host;
      const profileDirectory = path.join(paths.userData, "skyrimse", "profiles", "profile");
      await Promise.all(
        [host, game, profileDirectory].map((dir) => mkdir(dir, { recursive: true })),
      );
      const files = ["Skyrim.ini", "SkyrimPrefs.ini"];
      for (const file of files) {
        if (proton) {
          await writeFile(path.join(host, file), `host-unrelated-${file}`);
          await writeFile(path.join(host, file + ".base"), `host-unrelated-base-${file}`);
        }
        await writeFile(path.join(game, file), `global-${file}`);
        await writeFile(path.join(game, file + ".base"), `global-base-${file}`);
        await writeFile(path.join(profileDirectory, file), `profile-${file}`);
      }
      const state = {
        settings: {
          profiles: { activeProfileId: undefined as string | undefined },
          gameMode: {
            discovered: { skyrimse: { store, protonPrefix: proton ? prefix : undefined } },
          },
        },
        persistent: {
          profiles: {
            profile: { id: "profile", gameId: "skyrimse", features: { local_game_settings: true } },
          },
          mods: { skyrimse: {} },
        },
      };
      const events = new Map<string, (...args: any[]) => void>();
      const showErrorNotification = vi.fn<(...args: unknown[]) => void>();
      const context = {
        api: {
          store: { getState: () => state, dispatch: vi.fn<(...args: unknown[]) => void>() },
          getState: () => state,
          events: {
            on: (name: string, callback: (...args: any[]) => void) => events.set(name, callback),
          },
          emitAndAwait: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
          showErrorNotification,
        },
        registerProfileFeature: vi.fn<(...args: unknown[]) => void>(),
        registerTest: vi.fn<(...args: unknown[]) => void>(),
        once: (callback: () => void) => callback(),
      };
      expect(init(context as unknown as types.IExtensionContext)).toBe(true);
      const queue: Array<() => PromiseLike<void>> = [];
      const switchProfile = events.get("profile-will-change");
      expect(switchProfile).toBeTypeOf("function");
      switchProfile("profile", (callback: () => PromiseLike<void>) => queue.push(callback));
      expect(queue).toHaveLength(1);
      await queue[0]();
      expect(showErrorNotification).not.toHaveBeenCalled();
      for (const file of files) {
        expect(await readFile(path.join(game, file + ".base"), "utf8")).toBe(`profile-${file}`);
        expect(await readFile(path.join(game, file), "utf8")).toBe(`profile-${file}`);
        expect(await readFile(path.join(game, file + ".baked"), "utf8")).toBe(`profile-${file}`);
        expect(await readFile(path.join(paths.userData, "skyrimse", file), "utf8")).toBe(
          `global-base-${file}`,
        );
        expect(await readFile(path.join(host, file), "utf8")).toBe(
          proton ? `host-unrelated-${file}` : `profile-${file}`,
        );
        expect(await readFile(path.join(host, file + ".base"), "utf8")).toBe(
          proton ? `host-unrelated-base-${file}` : `profile-${file}`,
        );
      }
    },
  );
});
