import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";

import Bluebird from "bluebird";
import { afterAll, afterEach, beforeAll, describe, expect, vi } from "vitest";

import { makeProfile } from "../../test-utils/builders";
import type { IProfileSwitchHarness } from "../../test-utils/harnessTypes";
import { test } from "../../test-utils/profileSwitchTest";
import type { IExtensionApi, IExtensionContext } from "../../types/IExtensionContext";
import { UserCanceled } from "../../util/CustomErrors";
import { wrapExtCBSync } from "../../util/util";

const runtime = vi.hoisted(() => ({
  paths: {} as Record<string, string>,
  mergerLookups: 0,
  fs: undefined as { copyAsync: (source: string, destination: string) => Bluebird<void> },
}));

vi.mock("@nexusmods/vortex-api", async (importOriginal) => {
  const base = await importOriginal<{ util: object }>();
  const React = await import("react");
  const selectors = await import("../../util/selectors.js");
  const errors = await import("../../util/CustomErrors.js");
  const filesystem = {
    statAsync: (file: string) => Bluebird.resolve(stat(file)),
    readdirAsync: (file: string) => Bluebird.resolve(readdir(file)),
    readFileAsync: (file: string, options: { encoding: "utf8" }) =>
      Bluebird.resolve(readFile(file, options)),
    writeFileAsync: (file: string, data: string) => Bluebird.resolve(writeFile(file, data)),
    ensureDirWritableAsync: (file: string) => Bluebird.resolve(mkdir(file, { recursive: true })),
    copyAsync: (source: string, destination: string) =>
      Bluebird.resolve(copyFile(source, destination)),
    removeAsync: (file: string) => Bluebird.resolve(rm(file, { recursive: true, force: true })),
  };
  runtime.fs = filesystem;
  return {
    ...base,
    ComponentEx: React.Component,
    actions: {},
    selectors,
    fs: filesystem,
    util: {
      ...base.util,
      ...errors,
      getVortexPath: (name: string) => {
        if (!runtime.paths[name]) throw new Error(`Unexpected path: ${name}`);
        return runtime.paths[name];
      },
      getSafe: (value: unknown, keys: string[], fallback: unknown) =>
        keys.reduce((entry, key) => entry?.[key], value) ?? fallback,
    },
  };
});

vi.mock("../../../../../extensions/games/game-witcher3/src/scriptmerger", () => ({
  getMergedModName: async () => {
    runtime.mergerLookups++;
    return "mod0000_MergedFiles";
  },
  downloadScriptMerger: async () => undefined,
}));
vi.mock("../../../../../extensions/games/game-witcher3/src/menumod", () => ({}));

const requireForTest = createRequire(path.join(__dirname, "witcherProfileSwitch.test.ts"));
const parserPath = requireForTest.resolve("vortex-parse-ini");
const originalParser = requireForTest.cache[parserPath];
let initWitcher: (context: IExtensionContext) => boolean;
let mergeBackup: Record<
  "storeToProfile" | "restoreFromProfile",
  (api: IExtensionApi, profileId: string) => Promise<void>
>;
async function witcherModule(name: string) {
  return import(`../../../../../extensions/games/game-witcher3/src/${name}.ts`);
}
beforeAll(async () => {
  requireForTest.cache[parserPath] = { exports: await import("vortex-parse-ini") } as NodeJS.Module;
  // Load the extension through Vite without adding it to the renderer compiler scope.
  const module = await witcherModule("index");
  initWitcher = module.default.default ?? module.default;
  mergeBackup = await witcherModule("mergeBackup");
});
afterAll(() => {
  if (originalParser) requireForTest.cache[parserPath] = originalParser;
  else delete requireForTest.cache[parserPath];
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const outgoingBytes = "[modOutgoing]\nEnabled=1\nPriority=73\n";
const incomingBytes = "[modIncoming]\nEnabled=1\nPriority=91\n";
type Enqueue = (run: () => PromiseLike<unknown>) => void;
type Handler = (id: string, enqueue?: Enqueue) => PromiseLike<unknown>;

function observedBytes(file: string) {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "<missing>";
    throw err;
  }
}

async function fixture(h: IProfileSwitchHarness, proton = true) {
  const root = await mkdtemp(path.join(tmpdir(), "nyastra-witcher-switch-"));
  roots.push(root);
  runtime.paths = { userData: path.join(root, "user-data"), documents: path.join(root, "host") };
  runtime.mergerLookups = 0;
  const prefix = path.join(root, "prefix");
  const documents = path.join(
    proton
      ? path.join(prefix, "drive_c", "users", "steamuser", "Documents")
      : runtime.paths.documents,
    "The Witcher 3",
  );
  const merger = path.join(root, "merger");
  const live = path.join(documents, "mods.settings");
  const outgoing = path.join(merger, "outgoing", "mods.settings");
  const incoming = path.join(merger, "incoming", "mods.settings");
  const backup = path.join(
    runtime.paths.userData,
    "witcher3",
    "profiles",
    "outgoing",
    "backup",
    "mods.settings",
  );
  for (const file of [live, outgoing, incoming])
    await mkdir(path.dirname(file), { recursive: true });
  await writeFile(live, outgoingBytes);
  await writeFile(outgoing, "old saved outgoing order 13");
  await writeFile(incoming, incomingBytes);
  h.setState((state) => {
    Object.assign(state.settings, { witcher3: { autoSortLoadOrder: false } });
    state.session.healthCheck = { results: {}, runningChecks: [] };
    state.settings.gameMode.discovered.witcher3 = {
      path: path.join(root, "game"),
      ...(proton ? { protonPrefix: prefix } : {}),
      tools: {
        W3ScriptMerger: {
          id: "W3ScriptMerger",
          name: "Script Merger",
          executable: undefined,
          requiredFiles: [],
          hidden: false,
          custom: false,
          path: path.join(merger, "WitcherScriptMerger.exe"),
        },
      },
    };
  });

  const work: PromiseLike<unknown>[] = [];
  for (const name of ["storeToProfile", "restoreFromProfile"] as const) {
    const run = mergeBackup[name];
    vi.spyOn(mergeBackup, name).mockImplementation((api, id) => {
      const result = run(api, id);
      work.push(result);
      return result;
    });
  }
  const on = h.api.events.on.bind(h.api.events);
  let handler: Handler;
  vi.spyOn(h.api.events, "on").mockImplementation((name, listener) => {
    if (name !== "profile-will-change") return on(name, listener);
    handler = wrapExtCBSync(listener) as Handler;
    return on(name, (id: string, enqueue: Enqueue) => {
      // Observe the supplied queue without adding work the listener did not enqueue.
      const returned = handler(id, (run) =>
        enqueue(() => {
          const result = run();
          work.push(result);
          return result;
        }),
      );
      work.push(returned);
      return returned;
    });
  });
  const context = new Proxy(
    { api: h.api, optional: {}, once: (run: () => void) => run() },
    {
      get: (target, key: string) => (key in target ? target[key] : () => undefined),
    },
  );
  context.optional = new Proxy({}, { get: () => () => undefined });
  initWitcher(context as unknown as IExtensionContext);
  const fs = runtime.fs;
  const copies: Array<[string, string]> = [];
  const copy = fs.copyAsync;
  const recordedCopy = (source: string, destination: string) => {
    const result = copy(source, destination).then(() => {
      if (path.basename(source) === "mods.settings") copies.push([source, destination]);
      return undefined;
    });
    work.push(result);
    return result;
  };
  vi.spyOn(fs, "copyAsync").mockImplementation(recordedCopy);
  const confirmed: Array<{ id: string; bytes: string; saved: string }> = [];
  h.api.events.on("profile-did-change", () =>
    confirmed.push({
      id: h.getState().settings.profiles.activeProfileId,
      bytes: observedBytes(live),
      saved: observedBytes(outgoing),
    }),
  );
  const drain = (...other: PromiseLike<unknown>[]) =>
    Bluebird.resolve(
      (async () => {
        await Promise.allSettled(other);
        let count = -1;
        while (count !== work.length) {
          count = work.length;
          await Promise.allSettled(work);
          await setImmediate();
        }
      })(),
    ).timeout(2000);
  return {
    h,
    fs,
    live,
    outgoing,
    incoming,
    backup,
    copies,
    confirmed,
    handler,
    drain,
    copy: recordedCopy,
  };
}

function profiles() {
  return [
    makeProfile({ id: "outgoing", gameId: "witcher3", features: { local_merges: true } }),
    makeProfile({ id: "incoming", gameId: "witcher3", features: { local_merges: true } }),
    makeProfile({ id: "other", gameId: "skyrimse" }),
  ];
}

const options = () => ({
  profiles: profiles(),
  lastActive: { witcher3: "outgoing", skyrimse: "other" },
  activeProfileId: "outgoing",
});

describe("registered Witcher profile files at the core switch boundary", () => {
  test("waits for native save and restore before confirming incoming bytes", async ({
    makeProfileSwitch,
  }) => {
    const f = await fixture(await makeProfileSwitch(options()));
    const saveEntered = Bluebird.defer<void>();
    const restoreEntered = Bluebird.defer<void>();
    const saveGate = Bluebird.defer<void>();
    const restoreGate = Bluebird.defer<void>();
    const copy = f.copy;
    vi.spyOn(f.fs, "copyAsync").mockImplementation((source, destination) => {
      if (source === f.live && destination === f.backup) {
        saveEntered.resolve();
        return saveGate.promise.then(() => copy(source, destination));
      }
      if (source === f.incoming && destination === f.live) {
        restoreEntered.resolve();
        return restoreGate.promise.then(() => copy(source, destination));
      }
      return copy(source, destination);
    });
    const pending: Array<{ settled: boolean; confirmations: number; active: string }> = [];
    let settled = false;
    const switched = f.h.switchTo("incoming").then(() => {
      settled = true;
      return undefined;
    });
    try {
      await saveEntered.promise.timeout(1000);
      await setImmediate();
      pending.push({
        settled,
        confirmations: f.confirmed.length,
        active: f.h.getState().settings.profiles.activeProfileId,
      });
      expect(await readFile(f.live, "utf8")).toBe(outgoingBytes);
      saveGate.resolve();
      await restoreEntered.promise.timeout(1000);
      await setImmediate();
      pending.push({
        settled,
        confirmations: f.confirmed.length,
        active: f.h.getState().settings.profiles.activeProfileId,
      });
      expect(await readFile(f.outgoing, "utf8")).toBe(outgoingBytes);
      expect(await readFile(f.backup, "utf8")).toBe(outgoingBytes);
      restoreGate.resolve();
      await Bluebird.resolve(switched).timeout(2000);
      expect(f.confirmed).toEqual([{ id: "incoming", bytes: incomingBytes, saved: outgoingBytes }]);
      expect(pending).toEqual([
        { settled: false, confirmations: 0, active: "outgoing" },
        { settled: false, confirmations: 0, active: "outgoing" },
      ]);
      expect(f.copies).toEqual([
        [f.live, f.backup],
        [f.live, f.outgoing],
        [f.incoming, f.live],
      ]);
      expect(f.h.errorNotifications).toEqual([]);
    } finally {
      saveGate.resolve();
      restoreGate.resolve();
      await f.drain(switched);
    }
    expect(await readFile(f.live, "utf8")).toBe(incomingBytes);
  });

  test("starts only when the supplied queue owns the work and retains notification IDs", async ({
    makeProfileSwitch,
  }) => {
    const f = await fixture(await makeProfileSwitch(options()));
    let run: () => PromiseLike<unknown>;
    try {
      await f.handler("incoming", (callback) => {
        run = callback;
      });
      await setImmediate();
      expect(f.copies).toEqual([]);
      expect(runtime.mergerLookups).toBe(0);
      f.h.setState((state) => {
        state.settings.profiles.lastActiveProfile.witcher3 = "incoming";
      });
      await Bluebird.resolve(run()).timeout(2000);
      expect(await readFile(f.outgoing, "utf8")).toBe(outgoingBytes);
      expect(await readFile(f.live, "utf8")).toBe(incomingBytes);
      expect(f.copies).toEqual([
        [f.live, f.backup],
        [f.live, f.outgoing],
        [f.incoming, f.live],
      ]);
    } finally {
      await f.drain();
    }
  });

  test.for([false, true])(
    "direct callback remains awaitable with Proton=%s",
    async (proton, { makeProfileSwitch }) => {
      const f = await fixture(await makeProfileSwitch(options()), proton);
      try {
        await Bluebird.resolve(f.handler("incoming")).timeout(2000);
        expect(await readFile(f.live, "utf8")).toBe(incomingBytes);
        expect(await readFile(f.outgoing, "utf8")).toBe(outgoingBytes);
        expect(f.confirmed).toEqual([]);
        expect(f.h.errorNotifications).toEqual([]);
      } finally {
        await f.drain();
      }
    },
  );

  test("leaves Witcher files alone when switching to another game", async ({
    makeProfileSwitch,
  }) => {
    const f = await fixture(await makeProfileSwitch(options()));
    const switched = f.h.switchTo("other");
    try {
      await Bluebird.resolve(switched).timeout(2000);
      expect(f.copies).toEqual([]);
      expect(f.confirmed).toEqual([
        { id: "other", bytes: outgoingBytes, saved: "old saved outgoing order 13" },
      ]);
      expect(f.h.errorNotifications).toEqual([]);
    } finally {
      await f.drain(switched);
    }
  });

  test.for([undefined, "missing"])(
    "ignores an absent incoming profile %s",
    async (id, { makeProfileSwitch }) => {
      const f = await fixture(await makeProfileSwitch(options()));
      const enqueue = vi.fn<Enqueue>();
      try {
        await f.handler(id, enqueue);
        expect(enqueue).not.toHaveBeenCalled();
        expect(f.copies).toEqual([]);
        expect(await readFile(f.live, "utf8")).toBe(outgoingBytes);
      } finally {
        await f.drain();
      }
    },
  );

  test.for(["cancel", "failure"])(
    "settles %s before confirmation with the existing error policy",
    async (kind, { makeProfileSwitch }) => {
      const f = await fixture(await makeProfileSwitch(options()));
      const error =
        kind === "cancel"
          ? new UserCanceled()
          : Object.assign(new Error("copy failed 47"), { code: "EACCES" });
      const entered = Bluebird.defer<void>();
      const gate = Bluebird.defer<void>();
      const copy = f.copy;
      vi.spyOn(f.fs, "copyAsync").mockImplementation((source, destination) => {
        if (source !== f.live || destination !== f.backup) return copy(source, destination);
        entered.resolve();
        return gate.promise.then(() => {
          throw error;
        });
      });
      const switched = f.h.switchTo("incoming");
      try {
        await entered.promise.timeout(1000);
        await setImmediate();
        expect(f.confirmed).toEqual([]);
        gate.resolve();
        await Bluebird.resolve(switched).timeout(2000);
        expect(f.confirmed).toEqual([
          { id: "incoming", bytes: outgoingBytes, saved: "old saved outgoing order 13" },
        ]);
        expect(f.copies).toEqual([]);
        expect(f.h.errorNotifications).toEqual(
          kind === "cancel"
            ? []
            : [
                {
                  title: "Failed to store profile specific merged items",
                  message: error,
                  allowReport: undefined,
                },
              ],
        );
      } finally {
        gate.resolve();
        await f.drain(switched);
      }
      expect(await readFile(f.incoming, "utf8")).toBe(incomingBytes);
    },
  );
});
