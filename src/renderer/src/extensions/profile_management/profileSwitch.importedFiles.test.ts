import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, vi, afterEach } from "vitest";

import { makeProfile, makeProfileSwitchHarness } from "../../test-utils/builders";
import { test } from "../../test-utils/harnessTest";
import * as atomic from "../../util/fsAtomic";
import * as paths from "../../util/getVortexPath";
import init from "./index";
// Load the importer and main finalizer through their runtime boundaries.
async function importModules() {
  const script = path.resolve(__dirname, "../../../../../scripts/import-linux-profile.mjs");
  const main = path.resolve(__dirname, "../../../../main/src/profileImport.ts");
  const importer = (await import(script)) as {
    importLinuxProfile(source: string, config: string): { profile: string; rollback(): void };
  };
  const finalizer = (await import(main)) as {
    finishProfileImport(
      persistor: ReturnType<typeof database>["persistor"],
      userData: string,
    ): Promise<void>;
  };
  return { ...importer, ...finalizer };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function database(seed: Record<string, unknown>) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
  let saved: Map<string, string>;
  const persistor = {
    getAllKVs: vi.fn(async () =>
      [...values].map(([key, value]) => ({ key: key.split("###"), value })),
    ),
    removeItem: vi.fn(async (key: string[]) => {
      const prefix = key.join("###");
      for (const k of values.keys())
        if (k === prefix || k.startsWith(prefix + "###")) values.delete(k);
    }),
    setItem: vi.fn(async (key: string[], value: string) => {
      values.set(key.join("###"), value);
    }),
    beginTransaction: vi.fn(async () => {
      saved = new Map(values);
    }),
    commitTransaction: vi.fn(async () => {}),
    rollbackTransaction: vi.fn(async () => {
      values.clear();
      for (const [k, v] of saved) values.set(k, v);
    }),
  };
  return { values, persistor };
}
for (const imported of [true, false]) {
  for (const edited of [true, false]) {
    test(`Linux profile file import survives actual profile switches, imported=${imported}, edited=${edited}`, async () => {
      const { importLinuxProfile, finishProfileImport } = await importModules();
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-profile-file-import-"));
      const config = path.join(root, "config");
      const source = path.join(config, "Vortex");
      const game = imported
        ? edited
          ? "skyrimse"
          : "another-imported-game"
        : edited
          ? "control-game"
          : "another-control-game";
      const profiles = [
        makeProfile({ id: "first", gameId: game }),
        makeProfile({ id: "second", gameId: game }),
      ];
      const records = {
        "persistent###profiles": Object.fromEntries(profiles.map((p) => [p.id, p])),
        "persistent###mods": { [game]: {} },
        "app###instanceId": "source-instance",
        "settings###downloads": { path: "{USERDATA}/downloads" },
        "settings###mods": { installPath: { [game]: "{USERDATA}/{GAME}/mods" } },
        "settings###profiles": {
          activeProfileId: "first",
          nextProfileId: "first",
          lastActiveProfile: { [game]: "first" },
        },
      };
      for (const [rel, bytes] of Object.entries({
        "state.v2/CURRENT": "MANIFEST-000001\n",
        "state.v2/LOCK": "",
        "state.v2/MANIFEST-000001": JSON.stringify(records),
        [`${game}/profiles/first/settings.ini`]: "first saved config",
        [`${game}/profiles/second/settings.ini`]: "second saved config",
        [`${game}/profiles/second/saves/manual.sav`]: "retained savegame fixture",
      })) {
        const file = path.join(source, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
      }
      let userData: string;
      let rollback: () => void;
      let h: Awaited<ReturnType<typeof makeProfileSwitchHarness>>;
      const work: PromiseLike<unknown>[] = [];
      const deployments = vi.fn();
      const copies: Array<[string, string]> = [];
      const tracked = <T extends PromiseLike<unknown>>(p: T): T => {
        work.push(p);
        return p;
      };
      const drain = async () => {
        let count = -1;
        while (count !== work.length) {
          count = work.length;
          await Promise.all(
            work.map((p) =>
              Promise.resolve(p).then(
                () => undefined,
                (error) => ({ error }),
              ),
            ),
          );
          await tick();
        }
      };
      try {
        if (imported) {
          const result = importLinuxProfile(source, config);
          userData = result.profile;
          rollback = result.rollback;
        } else {
          userData = path.join(config, "DirectControl");
          fs.cpSync(source, userData, { recursive: true });
        }
        const stateFile = path.join(userData, "state.v2/MANIFEST-000001");
        const db = database(JSON.parse(fs.readFileSync(stateFile, "utf8")));
        if (imported) {
          await finishProfileImport(db.persistor, userData);
          expect(JSON.parse(db.values.get("settings###downloads###path")!)).toBe(
            path.join(source, "downloads"),
          );
          expect(JSON.parse(db.values.get(`settings###mods###installPath###${game}`)!)).toBe(
            path.join(source, "{GAME}/mods"),
          );
          expect(db.persistor.beginTransaction).toHaveBeenCalledTimes(1);
          expect(db.persistor.commitTransaction).toHaveBeenCalledTimes(1);
          expect(db.persistor.rollbackTransaction).toHaveBeenCalledTimes(0);
          expect(
            JSON.parse(fs.readFileSync(path.join(userData, "nyastra-import-complete.json"), "utf8"))
              .version,
          ).toBe(2);
        }
        const expectedProfiles = JSON.parse(db.values.get("persistent###profiles")!);
        expect(expectedProfiles).toEqual(Object.fromEntries(profiles.map((p) => [p.id, p])));
        const originalPath = paths.default;
        vi.spyOn(paths, "default").mockImplementation((id) =>
          id === "userData" ? userData : originalPath(id),
        );
        const copy = atomic.copyFileAtomic;
        vi.spyOn(atomic, "copyFileAtomic").mockImplementation((from, to) => {
          copies.push([from, to]);
          return tracked(copy(from, to));
        });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        h = await makeProfileSwitchHarness(
          (context) => {
            const observe = context.api.onStateChange.bind(context.api);
            context.api.onStateChange = (statePath, cb) =>
              observe(statePath, (prev, current) => {
                const p: unknown = cb(prev, current);
                if (typeof (p as PromiseLike<unknown>)?.then === "function")
                  tracked(p as PromiseLike<unknown>);
                return p;
              });
            context.api.events.removeAllListeners("deploy-mods");
            context.api.events.on(
              "deploy-mods",
              (callback: (e: null) => void, profileId: string) => {
                deployments(profileId);
                callback(null);
              },
            );
            return init(context);
          },
          {
            profiles: Object.values(expectedProfiles),
            activeProfileId: "first",
            lastActive: { [game]: "first" },
            gameSettings: { [game]: "first live config" },
          },
        );
        const didChange = vi.fn();
        h.api.events.on("profile-did-change", didChange);
        await h.switchTo("second");
        await drain();
        await vi.runAllTimersAsync();
        await drain();
        const afterSecond = await h.gameSettings(game);
        const savedPath = path.join(userData, game, "profiles/second/settings.ini");
        const afterImport = fs.existsSync(savedPath) ? fs.readFileSync(savedPath, "utf8") : null;
        const savedGame = path.join(userData, game, "profiles/second/saves/manual.sav");
        expect
          .soft(afterSecond, "activation must restore the imported inactive config")
          .toBe("second saved config");
        expect
          .soft(fs.existsSync(savedGame), "import must include profile-owned save files")
          .toBe(true);
        if (edited) await h.setGameSettings(game, "later second profile edit");
        await h.switchTo("first");
        await drain();
        await vi.runAllTimersAsync();
        await drain();
        const savedAfterRoundtrip = fs.existsSync(savedPath)
          ? fs.readFileSync(savedPath, "utf8")
          : null;
        console.log(
          "PROFILE_IMPORT_FILES",
          JSON.stringify({
            imported,
            afterSecond,
            afterImport,
            savedAfterRoundtrip,
            savegameCopied: fs.existsSync(savedGame),
            copies,
            active: h.getState().settings.profiles.activeProfileId,
          }),
        );
        expect
          .soft(
            savedAfterRoundtrip,
            "the first switch away must not replace the imported config with another profile",
          )
          .toBe(edited ? "later second profile edit" : "second saved config");
        if (imported) {
          expect(() => importLinuxProfile(source, config)).toThrow(/profile already exists/);
          await finishProfileImport(db.persistor, userData);
          expect(JSON.parse(db.values.get("settings###downloads###path")!)).toBe(
            path.join(source, "downloads"),
          );
          expect(JSON.parse(db.values.get(`settings###mods###installPath###${game}`)!)).toBe(
            path.join(source, "{GAME}/mods"),
          );
          expect(db.persistor.beginTransaction).toHaveBeenCalledTimes(1);
          expect(fs.readFileSync(savedPath, "utf8")).toBe(
            edited ? "later second profile edit" : "second saved config",
          );
        }
        expect(h.getState().settings.profiles.activeProfileId).toBe("first");
        expect(didChange).toHaveBeenCalledTimes(2);
        expect(await h.gameSettings(game)).toBe("first live config");
        expect(h.errorNotifications).toEqual([]);
        expect(
          fs.readFileSync(path.join(source, game, "profiles/second/settings.ini"), "utf8"),
        ).toBe("second saved config");
        expect(
          fs.readFileSync(path.join(source, game, "profiles/second/saves/manual.sav"), "utf8"),
        ).toBe("retained savegame fixture");
        expect(
          await Promise.all(
            work.map((p) =>
              Promise.resolve(p).then(
                () => undefined,
                (error) => ({ error }),
              ),
            ),
          ),
        ).toEqual(work.map(() => undefined));
        expect(copies).toHaveLength(5);
        expect(deployments.mock.calls).toEqual([["second"], ["first"]]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await vi.runAllTimersAsync();
        await drain();
        vi.useRealTimers();
        await h?.cleanup();
        rollback?.();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
