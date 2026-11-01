import fs from "node:fs";
import { createRequire, Module } from "node:module";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import { expect, test, vi } from "vitest";

import { makeApiHarness, makeProfile, registerHarnessGame } from "../../test-utils/builders";
import type { IExtensionContext } from "../../types/IExtensionContext";
import * as errors from "../../util/CustomErrors";
import * as selectors from "../../util/selectors";
import { getSafe } from "../../util/storeHelper";
import { makeOverlayableDictionary } from "../../util/util";
import { setNextProfile } from "../profile_management/actions/settings";
import initProfiles from "../profile_management/index";
import { profilesReducer } from "../profile_management/reducers/profiles";
import { settingsReducer } from "../profile_management/reducers/settings";
const repo = path.resolve(__dirname, "../../../../..");
const rr = createRequire(path.join(repo, "src/renderer/package.json"));
const ts = createRequire(path.join(repo, "package.json"))("typescript");
const deferred = () => {
  let resolve!: () => void;
  const promise = new Bluebird<void>((r) => (resolve = r));
  return { promise, resolve };
};
test("a failed profile switch drains every INI chain before the core advances", async () => {
  await import("./index.js");
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nyastra-late-settings-"));
  const docs = path.join(root, "documents"),
    data = path.join(root, "data");
  const game = path.join(docs, "My Games", "Skyrim Special Edition");
  const prof = (id: string) => path.join(data, "skyrimse", "profiles", id);
  const required = ["Skyrim.ini", "SkyrimPrefs.ini"],
    optional = "SkyrimCustom.ini";
  for (const d of [game, prof("b"), prof("c")]) await fs.promises.mkdir(d, { recursive: true });
  for (const name of [...required, optional]) {
    await fs.promises.writeFile(path.join(game, name), "global " + name);
    await fs.promises.writeFile(path.join(game, name + ".base"), "global " + name);
    await fs.promises.writeFile(path.join(prof("c"), name), "C " + name);
    if (name !== optional) await fs.promises.writeFile(path.join(prof("b"), name), "B " + name);
  }
  await fs.promises.chmod(path.join(prof("b"), required[0]), 0);
  registerHarnessGame("skyrimse");
  const profiles = Object.fromEntries(
    ["a", "b", "c"].map((id) => [
      id,
      makeProfile({ id, gameId: "skyrimse", features: { local_game_settings: id !== "a" } }),
    ]),
  );
  const h = makeApiHarness(
    { profiles, activeProfileId: "a", lastActiveProfile: { skyrimse: "a" } },
    [
      { path: ["persistent", "profiles"], reducer: profilesReducer },
      { path: ["settings", "profiles"], reducer: settingsReducer },
    ],
  );
  h.setState((s) => {
    s.settings.profiles.nextProfileId = "a";
    s.session.base = { commandLine: {}, toolsRunning: {}, activity: {} } as never;
  });
  const work: PromiseLike<unknown>[] = [];
  const register = h.api.onStateChange.bind(h.api);
  h.api.onStateChange = (keys, callback) =>
    register(keys, (p, c) => {
      const r = (callback as (...args: unknown[]) => any)(p, c);
      if (r && typeof r.then === "function") work.push(r);
      return r;
    });
  const drain = async () => {
    let seen = -1;
    while (seen !== work.length) {
      seen = work.length;
      await Promise.all(work);
      await new Promise<void>((r) => setImmediate(r));
    }
  };
  const callbacks: Array<() => void> = [];
  const ctx = new Proxy(
    { api: h.api, once: (cb: () => void) => callbacks.push(cb) },
    { get: (o, k) => (k in o ? o[k] : () => undefined) },
  ) as unknown as IExtensionContext;
  initProfiles(ctx);
  h.api.events.on("deploy-mods", (cb) => cb(null));
  callbacks.splice(0).forEach((cb) => cb());
  await drain();
  const held = deferred(),
    release = deferred();
  const native = rr("fs-extra");
  const nativeErrors: NodeJS.ErrnoException[] = [];
  const pending: PromiseLike<unknown>[] = [];
  let first = true;
  const api = { ...h.api, store: h.api.store, getState: h.getState };
  const vortex = {
    fs: {
      copyAsync: (src: string, dst: string, opts: any) =>
        Bluebird.resolve(native.copy(src, dst, opts)).catch((e) => {
          nativeErrors.push(e);
          return src === path.join(prof("b"), required[0])
            ? held.promise.then(() => {
                throw e;
              })
            : Bluebird.reject(e);
        }),
      statAsync: (file: string) =>
        Bluebird.resolve(native.stat(file)).catch((e) => {
          if (first && file === path.join(prof("b"), optional)) {
            first = false;
            held.resolve();
            const p = release.promise.then(() => {
              throw e;
            });
            pending.push(p);
            return p;
          }
          throw e;
        }),
      unlinkAsync: (file: string) => Bluebird.resolve(native.unlink(file)),
    },
    log: () => undefined,
    selectors,
    util: {
      makeOverlayableDictionary,
      getSafe,
      unique: (a: any[], f: any) => a.filter((x, i) => a.findIndex((y) => f(x) === f(y)) === i),
      getVortexPath: (key: string) => (key === "documents" ? docs : data),
      sortMods: async (_g: string, m: any) => m,
      showError: vi.fn(),
      ...errors,
    },
  };
  const load = (relative: string): any => {
    const filename = path.join(repo, "extensions/local-gamesettings/src", relative + ".ts");
    const m = new Module(filename);
    m.filename = filename;
    m.paths = rr.resolve.paths("bluebird")!;
    m.require = (id: string) =>
      id === "@nexusmods/vortex-api"
        ? vortex
        : id === "./util/gameSupport"
          ? load("util/gameSupport")
          : rr(id);
    (m as unknown as { _compile(code: string, filename: string): void })._compile(
      ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText,
      filename,
    );
    return m.exports;
  };
  load("index").default({
    ...ctx,
    api,
    once: (cb: () => void) => cb(),
    registerProfileFeature: () => undefined,
    registerTest: () => undefined,
  });
  try {
    h.api.store.dispatch(setNextProfile("b"));
    await held.promise;
    await vi.waitFor(() =>
      expect(nativeErrors.some((value) => value.code === "EACCES")).toBe(true),
    );
    await vi.waitFor(async () =>
      expect(await fs.promises.readFile(path.join(game, required[1] + ".baked"), "utf8")).toBe(
        "B " + required[1],
      ),
    );
    expect(h.getState().settings.profiles.activeProfileId).not.toBe("b");
    expect(vortex.util.showError).not.toHaveBeenCalled();
    release.resolve();
    await drain();
    await Promise.allSettled(pending);
    expect(h.getState().settings.profiles.activeProfileId).toBe("b");
    expect(vortex.util.showError).toHaveBeenCalledTimes(1);
    const firstError = nativeErrors.find((value) => value.code === "EACCES");
    expect(vortex.util.showError.mock.calls[0][2].error).toBe(firstError);
    await fs.promises.chmod(path.join(prof("b"), required[0]), 0o644);
    await fs.promises.copyFile(
      path.join(data, "skyrimse", required[0]),
      path.join(game, required[0] + ".base"),
    );
    h.api.store.dispatch(setNextProfile("c"));
    await drain();
    expect(h.getState().settings.profiles.activeProfileId).toBe("c");
    for (const suffix of ["", ".base", ".baked"]) {
      expect(await fs.promises.readFile(path.join(game, optional + suffix), "utf8")).toBe(
        "C " + optional,
      );
    }
    h.api.store.dispatch(setNextProfile("a"));
    await drain();
    const savedC = await fs.promises
      .readFile(path.join(prof("c"), optional), "utf8")
      .catch((e: NodeJS.ErrnoException) => e.code);
    expect(savedC).toBe("C " + optional);
    expect(vortex.util.showError).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    await drain();
    await Promise.allSettled(pending);
    await fs.promises.chmod(path.join(prof("b"), required[0]), 0o644);
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}, 20000);
