import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import type * as NativeFs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import SevenZip from "node-7z";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

import type { IAvailableExtension } from "../../types/extensions";
import type { IExtensionContext } from "../../types/IExtensionContext";
import type * as ErrorHandling from "../../util/errorHandling";
import type * as ExtensionIndex from "./index";
import type * as ExtensionInstall from "./installExtension";

vi.mock("../../../../shared/src/errors/base", async (importOriginal) => importOriginal());

interface StartupFixture {
  root: string;
  available: IAvailableExtension[];
  fetchError?: Error;
  fetches: number;
  retain: (original: PromiseLike<unknown>) => void;
  native: (kind: string, destination: string, operation: Promise<void>) => Promise<void>;
}

const fixture = vi.hoisted<StartupFixture>(() => ({
  root: "",
  available: [],
  fetchError: undefined,
  fetches: 0,
  retain: (_original: PromiseLike<unknown>) => {},
  native: (_kind: string, _destination: string, operation: Promise<void>) => operation,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof NativeFs>();
  const wrapped = {
    ...original,
    rm: (...args: Parameters<typeof original.rm>) =>
      fixture.native("remove", String(args[0]), original.rm(...args)),
    rename: (...args: Parameters<typeof original.rename>) =>
      fixture.native("rename", String(args[1]), original.rename(...args)),
  };
  return { ...wrapped, default: wrapped };
});
vi.mock("../../util/getVortexPath", () => ({ default: () => fixture.root }));
vi.mock("../../util/errorHandling", async (importOriginal) => ({
  ...(await importOriginal<typeof ErrorHandling>()),
  withTrackedActivity: async <T>(
    _tracer: string,
    _span: string,
    _attributes: unknown,
    run: () => Promise<T>,
  ) => run(),
}));
vi.mock("./availableExtensions", () => ({
  fetchExtensionList: async () => {
    fixture.fetches++;
    if (fixture.fetchError !== undefined) throw fixture.fetchError;
    return fixture.available;
  },
  dedupeGameExtensions: (entries: unknown) => entries,
  groupGameExtensionsByGameId: () => new Map(),
}));
vi.mock("../nexus_integration/util", () => ({ nexusGamesProm: async () => [] }));
vi.mock("./BrowseExtensions", () => ({ default: () => null }));
vi.mock("./ExtensionManager", () => ({ ExtensionManager: () => null }));

import { appReducer } from "../../reducers/app";
import {
  makeApiHarness,
  makeAvailableExtension,
  makeDownload,
  resetHarnessRegistries,
} from "../../test-utils/builders";
import sessionReducer from "./reducers";

interface Outcome {
  value?: unknown;
  error?: unknown;
}

const initialPromise = globalThis.Promise;
const nativePrototype: Promise<unknown> = Object.getPrototypeOf((async () => {})());
let directory: string;
let nativeRequire: NodeJS.Require;
let operations: Promise<Outcome>[];
let continuations: number[];
let sources: Map<string, Buffer>;
let archiveOwners: Set<Map<unknown, unknown>>;
let destinationOwners: Set<Map<unknown, unknown>>;
let resume: () => void;
let expectedError: Error | undefined;

function retain<T>(original: PromiseLike<T>) {
  const slot = continuations.length;
  continuations.push(0);
  const outcome = Promise.resolve(original).then(
    (value) => {
      continuations[slot]++;
      return { value, error: undefined };
    },
    (error: unknown) => {
      continuations[slot]++;
      return { value: undefined, error };
    },
  );
  operations.push(outcome);
  return outcome;
}

async function drain() {
  let count = -1;
  while (count !== operations.length) {
    count = operations.length;
    await Promise.all(operations);
  }
  const results = await Promise.all(operations);
  expect(
    results.filter((result) => result.error !== undefined).map((result) => result.error),
  ).toEqual(results.filter((result) => result.error !== undefined).map(() => expectedError));
  expect(continuations).toEqual(continuations.map(() => 1));
  expect([...archiveOwners].map((owner) => owner.size)).toEqual([0]);
  expect([...destinationOwners].map((owner) => owner.size)).toEqual([0]);
}

beforeEach(async () => {
  vi.resetModules();
  await import("../mod_management/index.js");
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "extension-startup-")));
  fixture.root = path.join(directory, "user-data");
  fixture.available = [];
  fixture.fetchError = undefined;
  expectedError = undefined;
  fixture.fetches = 0;
  nativeRequire = createRequire(path.join(process.cwd(), "package.json"));
  vi.stubGlobal("__non_webpack_require__", nativeRequire);
  operations = [];
  continuations = [];
  sources = new Map();
  archiveOwners = new Set();
  destinationOwners = new Set();
  resume = () => {};
  fixture.retain = (operation) => {
    void retain(operation);
  };
  fixture.native = (_kind, _destination, operation) => {
    fixture.retain(operation);
    return operation;
  };
  const originalSet = Map.prototype.set;
  const plugins = path.join(fixture.root, "plugins");
  vi.spyOn(Map.prototype, "set").mockImplementation(function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown,
  ) {
    const result = originalSet.call(this, key, value);
    if (typeof key === "string") {
      if (key.startsWith(plugins + "\0")) archiveOwners.add(this);
      else if (path.dirname(key) === plugins) destinationOwners.add(this);
    }
    return result;
  });
});

afterAll(() => {
  globalThis.Promise = initialPromise;
});

afterEach(async () => {
  resume();
  try {
    await drain();
  } finally {
    Object.keys(nativeRequire.cache)
      .filter((filename) => filename.startsWith(directory + path.sep))
      .forEach((filename) => delete nativeRequire.cache[filename]);
    fixture.native = (_kind, _destination, operation) => operation;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetHarnessRegistries();
    await rm(directory, { recursive: true, force: true });
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function archive(id: string, version: string, code = "module.exports = () => true;") {
  const source = await mkdtemp(path.join(directory, "zip-source-"));
  await writeFile(path.join(source, "index.js"), code);
  await writeFile(path.join(source, "info.json"), JSON.stringify({ id, name: id, version }));
  const filename = path.join(directory, "downloads", "site", `${id}-${version}.zip`);
  await mkdir(path.dirname(filename), { recursive: true });
  expect(
    (
      await retain(
        new SevenZip().add(
          filename,
          [path.join(source, "index.js"), path.join(source, "info.json")],
          {},
        ),
      )
    ).error,
  ).toBeUndefined();
  sources.set(filename, await readFile(filename));
  return filename;
}

// Capture the original detached startup terminal without changing its completion policy.
function start(once: () => void) {
  const chains = new Set<Promise<unknown>>();
  let terminal!: Promise<unknown>;
  const originalThen = nativePrototype.then;
  const spy = vi.spyOn(nativePrototype, "then").mockImplementation(function (
    this: Promise<unknown>,
    ...args: Parameters<typeof originalThen>
  ) {
    const result = originalThen.apply(this, args);
    chains.add(this);
    chains.add(result);
    terminal = result;
    return result;
  });
  try {
    once();
  } finally {
    spy.mockRestore();
  }
  expect(chains.size).toBeGreaterThan(0);
  chains.forEach((operation) => fixture.retain(operation));
  let settled = false;
  fixture.retain(
    terminal.then(() => {
      settled = true;
      return undefined;
    }),
  );
  return () => settled;
}

for (const mode of [
  "required",
  "simple",
  "unchanged",
  "offline",
  "invalid-catalog",
  "failed-catalog",
  "failed-update",
] as const) {
  it(`settles startup and registered installs with ${mode}`, async () => {
    expect(globalThis.Promise).toBe((await import("bluebird")).default);
    const { default: init } = await vi.importActual<typeof ExtensionIndex>("./index");
    const { default: installExtension } =
      await vi.importActual<typeof ExtensionInstall>("./installExtension");
    const { DataInvalid } = await import("../../util/CustomErrors.js");
    const h = makeApiHarness({}, [
      { path: ["app"], reducer: appReducer },
      { path: ["session", "extensions"], reducer: sessionReducer },
    ]);
    h.api.getLoadedExtensions = () => [];
    h.setState((state) => {
      state.settings.downloads.path = path.join(directory, "downloads");
      state.session.base = {
        ...state.session.base,
        networkConnected: mode !== "offline",
        extLoadFailures: {},
      };
      state.session.extensions = { available: [], optional: {}, updateTime: 0, showBundled: false };
    });
    const id = "startup-root";
    const dependencyId = "startup-dependency";
    const old = makeAvailableExtension({ name: id, modId: 500, fileId: 1, version: "1.0.0" });
    const update = makeAvailableExtension({ name: id, modId: 500, fileId: 2, version: "2.0.0" });
    const dependency = makeAvailableExtension({
      name: dependencyId,
      modId: 501,
      fileId: 3,
      version: "2.1.0",
    });
    const oldFile = await archive(id, "1.0.0");
    expect(
      (await retain(installExtension(h.api, oldFile, { catalogEntry: old }))).error,
    ).toBeUndefined();
    const updateFile = await archive(
      id,
      "2.0.0",
      mode === "required"
        ? `module.exports = context => { context.requireExtension(${JSON.stringify(dependencyId)}, "^2.0.0"); return true; };`
        : "module.exports = () => true;",
    );
    const dependencyFile = await archive(dependencyId, "2.1.0");
    fixture.available = [mode === "unchanged" ? old : update, dependency];
    if (mode === "invalid-catalog") fixture.fetchError = new DataInvalid("invalid catalog fixture");
    if (mode === "failed-catalog") fixture.fetchError = new Error("catalog delivery fixture");
    expectedError = fixture.fetchError;
    h.setState((state) => {
      state.persistent.downloads.files.update = makeDownload({
        id: "update",
        state: "finished",
        localPath: path.basename(updateFile),
        game: ["site"],
      });
      state.persistent.downloads.files.dependency = makeDownload({
        id: "dependency",
        state: "finished",
        localPath: path.basename(dependencyFile),
        game: ["site"],
      });
    });
    let once!: () => void;
    const context = {
      api: h.api,
      registerReducer: vi.fn<IExtensionContext["registerReducer"]>(),
      registerMainPage: vi.fn<IExtensionContext["registerMainPage"]>(),
      registerDialog: vi.fn<IExtensionContext["registerDialog"]>(),
      registerInstaller: vi.fn<IExtensionContext["registerInstaller"]>(),
      once: (run: () => void) => {
        once = run;
      },
    };
    const downloads: number[] = [];
    const nested: string[] = [];
    const completed = deferred();
    const dependencyEntered = deferred();
    const release = deferred();
    resume = release.resolve;
    const dismiss = h.api.dismissNotification;
    vi.spyOn(h.api, "dismissNotification").mockImplementation((notificationId) => {
      const result = dismiss(notificationId);
      if (notificationId === "extension-updates") completed.resolve();
      return result;
    });
    fixture.native = (kind, destination, original) => {
      fixture.retain(original);
      const delivered = original.then(async () => {
        if (
          mode === "required" &&
          kind === "rename" &&
          path.basename(destination) === dependencyId
        ) {
          dependencyEntered.resolve();
          await release.promise;
        }
        return undefined;
      });
      fixture.retain(delivered);
      return delivered;
    };
    h.api.emitAndAwait = (async (event: string, ...args: unknown[]) => {
      if (event === "nexus-download") {
        expect(args[0]).toBe("site");
        const modId = args[1] as number;
        downloads.push(modId);
        if (mode === "failed-update") throw new Error("download fixture");
        expect(args[2]).toBe(modId === 500 ? 2 : 3);
        return [modId === 500 ? "update" : "dependency"];
      }
      expect(event).toBe("install-extension");
      nested.push((args[0] as IAvailableExtension).name);
      const listeners = h.api.events.listeners(event) as ((
        ...args: unknown[]
      ) => Promise<boolean>)[];
      expect(listeners).toHaveLength(1);
      const outcome = await retain(listeners[0](...args));
      expect(outcome.error).toBeUndefined();
      return [outcome.value];
    }) as typeof h.api.emitAndAwait;
    expect(init(context as unknown as IExtensionContext)).toBe(true);
    const startupSettled = start(once);
    if (mode === "required") {
      try {
        await dependencyEntered.promise;
        expect(startupSettled()).toBe(false);
        expect(h.getState().session.extensions.available).toEqual(fixture.available);
        expect(downloads).toEqual([500, 501]);
        expect(nested).toEqual([dependencyId]);
        expect(h.notifications.filter((note) => note.type === "success")).toEqual([]);
        expect([...archiveOwners].some((owner) => owner.size > 0)).toBe(true);
        expect([...destinationOwners].some((owner) => owner.size > 0)).toBe(true);
      } finally {
        release.resolve();
      }
    }
    await drain();
    expect(startupSettled()).toBe(true);
    if (mode === "required" || mode === "simple" || mode === "failed-update")
      await completed.promise;
    const autoUpdated = mode === "required" || mode === "simple";
    expect(downloads).toEqual(
      autoUpdated || mode === "failed-update" ? (mode === "required" ? [500, 501] : [500]) : [],
    );
    expect(nested).toEqual(mode === "required" ? [dependencyId] : []);
    expect(
      h.notifications.filter(
        (note) => note.message === "Extensions updated, please restart to apply them",
      ),
    ).toHaveLength(autoUpdated ? 1 : 0);
    expect(h.dialogCalls).toHaveLength(mode === "failed-update" ? 1 : 0);
    const fetchFailed = mode === "invalid-catalog" || mode === "failed-catalog";
    expect(fixture.fetches).toBe(mode === "offline" ? 0 : 1);
    expect(h.errorNotifications).toHaveLength(fetchFailed ? 1 : 0);
    if (fetchFailed)
      expect(h.errorNotifications[0]).toEqual({
        title: "Failed to fetch available extensions",
        message: fixture.fetchError,
        allowReport: mode === "failed-catalog",
      });
    expect(h.getState().session.extensions.available).toEqual(
      mode === "offline" || fetchFailed ? [] : fixture.available,
    );
    expect(h.getState().session.extensions.updateTime > 0).toBe(mode !== "offline" && !fetchFailed);
    const root = Object.values(h.getState().app.extensions).find(
      (entry) => entry.infoJsonId === id,
    );
    expect(root).toMatchObject({
      version: autoUpdated ? "2.0.0" : "1.0.0",
      enabled: true,
      remove: false,
    });
    if (!autoUpdated && mode !== "failed-update") {
      // The completion path still releases explicit requests when startup fetched nothing.
      const expectedFailure = fixture.fetchError;
      fixture.fetchError = undefined;
      expect(await h.api.emitAndAwait("install-extension", dependency)).toEqual([true]);
      await drain();
      fixture.fetchError = expectedFailure;
      expect(downloads).toEqual([501]);
      expect(nested).toEqual([dependencyId]);
    }
    const entries = Object.values(h.getState().app.extensions);
    expect(entries).toHaveLength(mode === "simple" || mode === "failed-update" ? 1 : 2);
    for (const entry of entries) {
      expect(JSON.parse(await readFile(path.join(entry.path, "info.json"), "utf8"))).toMatchObject({
        id: entry.infoJsonId,
        version: entry.version,
      });
    }
    for (const [filename, bytes] of sources) expect(await readFile(filename)).toEqual(bytes);
    expect(
      (await readdir(path.join(fixture.root, "plugins"))).filter((name) =>
        name.endsWith(".installing"),
      ),
    ).toEqual([]);
  });
}
