import fs from "node:fs/promises";
import { createRequire, Module } from "node:module";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import { expect, test, vi } from "vitest";

import {
  makeApiHarness,
  makeProfile,
  registerHarnessGame,
  resetHarnessRegistries,
} from "../../test-utils/builders";
import * as errors from "../../util/CustomErrors";
import * as selectors from "../../util/selectors";
import { getSafe } from "../../util/storeHelper";
import { makeOverlayableDictionary } from "../../util/util";
import { setProfile } from "../profile_management/actions/profiles";
import { setNextProfile } from "../profile_management/actions/settings";
import initProfiles from "../profile_management/index";
import { profilesReducer } from "../profile_management/reducers/profiles";
import { settingsReducer } from "../profile_management/reducers/settings";

test.each([
  "active-private",
  "active-global",
  "inactive-private",
  "stable-global",
  "active-private-queued",
  "active-private-proton",
  "failed-disable-leave",
  "failed-disable-retry",
  "failed-disable-repeated",
  "failed-enable-leave",
  "failed-enable-retry",
  "failed-disable-same-game",
  "failed-enable-same-game",
  "failed-disable-live",
  "failed-enable-live",
  "failed-disable-queued",
  "failed-enable-queued",
  "failed-profile-switch",
])("preserves installed INI ownership through feature edits: %s", async (mode) => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nyastra-settings-toggle-"));
  let drain = async () => {};
  try {
    const repo = path.resolve(__dirname, "../../../../..");
    const require = createRequire(path.join(repo, "src/renderer/package.json"));
    const ts = createRequire(path.join(repo, "package.json"))("typescript");
    const documents = path.join(root, "documents"),
      data = path.join(root, "data");
    const prefix = path.join(root, "proton");
    const proton = mode.endsWith("-proton");
    const game = path.join(
      proton ? path.join(prefix, "drive_c", "users", "steamuser", "Documents") : documents,
      "My Games",
      "Skyrim Special Edition",
    );
    const saved = path.join(data, "skyrimse", "profiles", "p");
    const otherSaved = path.join(data, "skyrimse", "profiles", "q");
    const files = ["Skyrim.ini", "SkyrimPrefs.ini", "SkyrimCustom.ini"];
    await Promise.all([game, saved, otherSaved].map((dir) => fs.mkdir(dir, { recursive: true })));
    const failure = mode.startsWith("failed-");
    const privateSwitch = mode === "failed-profile-switch";
    const wasPrivate =
      mode.startsWith("active-private") ||
      mode === "inactive-private" ||
      mode.startsWith("failed-disable") ||
      privateSwitch;
    for (const file of files) {
      for (const suffix of ["", ".base", ".baked"])
        await fs.writeFile(
          path.join(game, file + suffix),
          wasPrivate ? "latest private" : "global",
        );
      await fs.writeFile(path.join(saved, file), "old private");
      await fs.writeFile(path.join(otherSaved, file), "other private");
      await fs.writeFile(path.join(data, "skyrimse", file), "global");
    }
    registerHarnessGame("skyrimse");
    registerHarnessGame("other");
    const profiles = Object.fromEntries(
      [
        makeProfile({ id: "p", gameId: "skyrimse", features: { local_game_settings: wasPrivate } }),
        makeProfile({ id: "g", gameId: "skyrimse", features: { local_game_settings: false } }),
        makeProfile({ id: "q", gameId: "skyrimse", features: { local_game_settings: true } }),
        makeProfile({ id: "other", gameId: "other" }),
      ].map((profile) => [profile.id, profile]),
    );
    const active = mode === "inactive-private" ? "other" : "p";
    const h = makeApiHarness(
      { profiles, activeProfileId: active, lastActiveProfile: { skyrimse: "p", other: "other" } },
      [
        { path: ["persistent", "profiles"], reducer: profilesReducer },
        { path: ["settings", "profiles"], reducer: settingsReducer },
      ],
    );
    h.setState((state) => {
      state.settings.profiles.nextProfileId = active;
      if (proton) state.settings.gameMode.discovered.skyrimse.protonPrefix = prefix;
      state.settings.gameMode.discovered.other = { path: path.join(root, "other-game") } as never;
      state.session.base = { commandLine: {}, toolsRunning: {}, activity: {} } as never;
    });
    const work: PromiseLike<unknown>[] = [];
    const watch = h.api.onStateChange.bind(h.api);
    h.api.onStateChange = (keys, callback) =>
      watch(keys, (previous, current) => {
        const operation = (callback as any)(previous, current);
        if (operation && typeof operation.then === "function") work.push(operation);
        return operation;
      });
    drain = async () => {
      let count = -1;
      while (count !== work.length) {
        count = work.length;
        await Promise.all(work);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    const callbacks: Array<() => void> = [];
    const context = new Proxy(
      { api: h.api, once: (callback: () => void) => callbacks.push(callback) },
      {
        get: (target, key) => (key in target ? target[key] : () => undefined),
      },
    ) as any;
    initProfiles(context);
    h.api.events.on("deploy-mods", (callback) => callback(null));
    const bakes = vi.fn();
    h.api.events.on("bake-settings", (...args) => {
      const options = args[3];
      if (options?.recoverOnly) {
        expect(options).toMatchObject({ reportResult: true, settingsLocked: true });
        expect(args[1]).toEqual([]);
        return;
      }
      return bakes(...args);
    });
    h.api.emitAndAwait = (async (event: string, ...args: unknown[]) => {
      await h.emitAndAwait(event, ...args);
      return [{ settingsBaked: true }];
    }) as typeof h.api.emitAndAwait;
    callbacks.splice(0).forEach((callback) => callback());
    await drain();
    const native = require("fs-extra");
    const vortex = {
      fs: {
        openAsync: (file, flags) => Bluebird.resolve(require("node:fs/promises").open(file, flags)),
        fsyncAsync: (handle) => Bluebird.resolve(handle.sync()),
        closeAsync: (handle) => Bluebird.resolve(handle.close()),
        copyAsync: (source, destination, options) =>
          Bluebird.resolve(native.copy(source, destination, options)),
        statAsync: (file) => Bluebird.resolve(native.stat(file)),
        unlinkAsync: (file) => Bluebird.resolve(native.unlink(file)),
      },
      log: () => {},
      selectors,
      util: {
        ...errors,
        getSafe,
        makeOverlayableDictionary,
        unique: (values, key) =>
          values.filter(
            (value, index) => values.findIndex((other) => key(value) === key(other)) === index,
          ),
        getVortexPath: (key) => (key === "documents" ? documents : data),
        sortMods: async (_game, mods) => mods,
        showError: vi.fn(),
      },
    };
    const load = (relative: string): any => {
      const filename = path.join(repo, "extensions/local-gamesettings/src", relative + ".ts");
      const module = new Module(filename);
      module.filename = filename;
      module.paths = require.resolve.paths("bluebird")!;
      module.require = (id) =>
        id === "@nexusmods/vortex-api"
          ? vortex
          : id === "./util/gameSupport"
            ? load("util/gameSupport")
            : require(id);
      const source = require("node:fs").readFileSync(filename, "utf8");
      (module as any)._compile(
        ts.transpileModule(source, {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
          },
        }).outputText,
        filename,
      );
      return module.exports;
    };
    load("index").default({
      ...context,
      api: h.api,
      once: (callback) => callback(),
      registerProfileFeature: () => {},
      registerTest: () => {},
    });
    const toggle = (enabled: boolean) =>
      h.api.store.dispatch(
        setProfile({
          ...h.getState().persistent.profiles.p,
          features: { local_game_settings: enabled },
        }),
      );
    const switchTo = async (id: string) => {
      h.api.store.dispatch(setNextProfile(id));
      await drain();
      expect(h.getState().settings.profiles.activeProfileId).toBe(id);
    };
    const obstruction = privateSwitch
      ? path.join(otherSaved, "SkyrimPrefs.ini")
      : path.join(game, "SkyrimPrefs.ini" + (mode.endsWith("-live") ? "" : ".baked"));
    if (failure) {
      if (privateSwitch) await fs.chmod(obstruction, 0o000);
      else {
        await fs.unlink(obstruction);
        await fs.mkdir(obstruction);
      }
    }
    if (privateSwitch) await switchTo("q");
    else if (mode !== "stable-global") toggle(!wasPrivate);
    if (failure && mode.endsWith("-queued")) await switchTo("other");
    else if (!mode.endsWith("-queued")) await drain();
    if (failure) {
      expect(bakes).toHaveBeenCalledTimes(1);
      expect(vortex.util.showError).toHaveBeenCalledWith(
        expect.anything(),
        "An error occurred applying game settings",
        expect.objectContaining({ error: expect.any(Error) }),
      );
      expect(await fs.readFile(path.join(game, "Skyrim.ini.base"), "utf8")).toBe(
        privateSwitch ? "other private" : wasPrivate ? "global" : "old private",
      );
      for (const file of files) {
        expect(await fs.readFile(path.join(saved, file), "utf8")).toBe(
          wasPrivate ? "latest private" : "old private",
        );
        expect(await fs.readFile(path.join(data, "skyrimse", file), "utf8")).toBe("global");
      }
      if (mode.endsWith("-repeated")) {
        await switchTo("other");
        expect(bakes).toHaveBeenCalledTimes(1);
        for (const file of files)
          expect(await fs.readFile(path.join(saved, file), "utf8")).toBe("latest private");
      }
      if (privateSwitch) await fs.chmod(obstruction, 0o644);
      else await fs.rmdir(obstruction);
      if (mode.endsWith("-retry")) {
        toggle(wasPrivate);
        await drain();
        toggle(!wasPrivate);
        await drain();
      }
      vortex.util.showError.mockClear();
      if (mode.endsWith("-same-game")) await switchTo("g");
    }
    await switchTo("other");
    await switchTo("g");
    for (const file of files)
      for (const suffix of ["", ".base", ".baked"])
        expect(await fs.readFile(path.join(game, file + suffix), "utf8")).toBe("global");
    toggle(true);
    await drain();
    await switchTo("p");
    const expected = wasPrivate ? "latest private" : "old private";
    for (const file of files) {
      expect(await fs.readFile(path.join(saved, file), "utf8")).toBe(expected);
      expect(await fs.readFile(path.join(otherSaved, file), "utf8")).toBe("other private");
      for (const suffix of ["", ".base", ".baked"])
        expect(await fs.readFile(path.join(game, file + suffix), "utf8")).toBe(expected);
      expect(await fs.readFile(path.join(data, "skyrimse", file), "utf8")).toBe("global");
    }
    expect(vortex.util.showError).not.toHaveBeenCalled();
  } finally {
    await drain();
    await fs.rm(root, { recursive: true, force: true });
    resetHarnessRegistries();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
