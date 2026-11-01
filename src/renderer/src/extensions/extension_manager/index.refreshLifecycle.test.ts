import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type * as NativeFs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import SevenZip from "node-7z";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IAvailableExtension } from "../../types/extensions";
import type { IExtensionContext } from "../../types/IExtensionContext";
import type * as ErrorHandling from "../../util/errorHandling";
import type * as ExtensionUtil from "./util";

const fixture = vi.hoisted(() => ({
  root: "",
  available: [] as IAvailableExtension[],
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
    _attrs: unknown,
    run: () => Promise<T>,
  ) => run(),
}));
vi.mock("./availableExtensions", () => ({
  fetchExtensionList: async () => fixture.available,
  dedupeGameExtensions: (entries: unknown) => entries,
  groupGameExtensionsByGameId: () => new Map(),
}));
vi.mock("../nexus_integration/util", () => ({ nexusGamesProm: async () => [] }));
vi.mock("./BrowseExtensions", () => ({ default: () => null }));
vi.mock("./ExtensionManager", () => ({ ExtensionManager: () => null }));
vi.mock("./util", async (importOriginal) => {
  const original = await importOriginal<typeof ExtensionUtil>();
  return {
    ...original,
    fetchAvailableExtensions: (...args: Parameters<typeof original.fetchAvailableExtensions>) => {
      const operation = original.fetchAvailableExtensions(...args);
      fixture.retain(operation);
      return operation;
    },
    downloadAndInstallExtension: (
      ...args: Parameters<typeof original.downloadAndInstallExtension>
    ) => {
      const operation = original.downloadAndInstallExtension(...args);
      fixture.retain(operation);
      return operation;
    },
  };
});

import { removeExtension, setExtensionEnabled } from "../../actions";
import ExtensionManager from "../../ExtensionManager";
import { appReducer } from "../../reducers/app";
import {
  makeApiHarness,
  makeAvailableExtension,
  makeDownload,
  resetHarnessRegistries,
} from "../../test-utils/builders";
import type { IExtensionManagerProps } from "./ExtensionManager";
import init from "./index";
import installExtension from "./installExtension";
import sessionReducer from "./reducers";

let directory: string;
let nativeRequire: NodeJS.Require;
let operations: Promise<unknown>[];
let continuations: number[];
let sources: Map<string, Buffer>;

function retain<T>(original: PromiseLike<T>) {
  const slot = continuations.length;
  continuations.push(0);
  const operation = Promise.resolve(original);
  operations.push(operation);
  const outcome = operation.then(
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

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "extension-refresh-"));
  fixture.root = path.join(directory, "user-data");
  fixture.available = [];
  nativeRequire = createRequire(path.join(process.cwd(), "package.json"));
  vi.stubGlobal("__non_webpack_require__", nativeRequire);
  operations = [];
  continuations = [];
  sources = new Map();
  fixture.retain = (operation) => {
    void retain(operation);
  };
});

async function drain() {
  let count = -1;
  while (count !== operations.length) {
    count = operations.length;
    await Promise.allSettled(operations);
  }
}

afterEach(async () => {
  await drain();
  Object.keys(nativeRequire.cache)
    .filter((filename) => filename.startsWith(directory + path.sep))
    .forEach((filename) => delete nativeRequire.cache[filename]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetHarnessRegistries();
  fixture.native = (_kind, _destination, operation) => operation;
  await rm(directory, { recursive: true, force: true });
});

function setup() {
  const h = makeApiHarness({}, [
    { path: ["app"], reducer: appReducer },
    { path: ["session", "extensions"], reducer: sessionReducer },
  ]);
  h.api.getLoadedExtensions = () => [];
  h.setState((state) => {
    state.settings.downloads.path = path.join(directory, "downloads");
    state.session.base = { ...state.session.base, networkConnected: true };
    state.session.extensions = { available: [], optional: {}, updateTime: 0, showBundled: false };
  });
  return h;
}

async function archive(id: string, version: string) {
  const source = await mkdtemp(path.join(directory, "zip-source-"));
  await writeFile(path.join(source, "index.js"), "module.exports = () => true;");
  await writeFile(
    path.join(source, "info.json"),
    JSON.stringify({ id, name: id, version, author: "Fixture" }),
  );
  const filename = path.join(directory, "downloads", "site", `extension-${version}.zip`);
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

function discovered(h: ReturnType<typeof setup>) {
  const manager = Object.create(ExtensionManager.prototype) as ExtensionManager;
  Object.assign(manager, {
    mExtensionState: h.getState().app.extensions,
    mExtensionFormats: ["index.cjs", "index.js"],
    mOutdated: [],
    mLoadFailures: {},
    mPendingAdds: [],
  });
  return manager["loadDynamicExtensions"](
    { path: path.join(fixture.root, "plugins"), bundled: false },
    new Set(),
    [],
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("refresh choices across native replacement", () => {
  for (const boundary of ["download", "extract", "remove", "rename"] as const) {
    for (const mode of ["enabled", "disabled", "removed"] as const) {
      it(`preserves ${mode} when the public refresh is held at ${boundary}`, async () => {
        const h = setup();
        const id = "fixture-extension";
        const old = makeAvailableExtension({ name: id, modId: 500, fileId: 1, version: "1.0.0" });
        const update = makeAvailableExtension({
          name: id,
          modId: 500,
          fileId: 2,
          version: "2.0.0",
        });
        const oldArchive = await archive(id, "1.0.0");
        const updateArchive = await archive(id, "2.0.0");
        expect(
          (await retain(installExtension(h.api, oldArchive, { catalogEntry: old }))).error,
        ).toBeUndefined();
        const key = Object.keys(h.getState().app.extensions)[0];
        expect(discovered(h)).toHaveLength(1);
        fixture.available = [update];
        h.setState((state) => {
          state.persistent.downloads.files.update = makeDownload({
            id: "update",
            state: "finished",
            localPath: path.basename(updateArchive),
            game: ["site"],
          });
        });
        const entered = deferred();
        const release = deferred();
        const completed = deferred();
        let holds = 0;
        let armed = true;
        const hold = async (kind: string) => {
          if (!armed || kind !== boundary) return;
          holds++;
          entered.resolve();
          await release.promise;
        };
        const nativeCalls: string[] = [];
        const nativeActive = new Set<object>();
        let nativeSubmitted = 0;
        let nativeSettled = 0;
        fixture.native = (kind, destination, original) => {
          const request = {};
          nativeSubmitted++;
          nativeActive.add(request);
          const native = retain(original);
          const operation = native
            .then(async (result) => {
              if (result.error) throw result.error;
              if (destination === path.join(fixture.root, "plugins", id)) {
                nativeCalls.push(kind);
                await hold(kind);
              }
            })
            .finally(() => {
              nativeActive.delete(request);
              nativeSettled++;
            });
          fixture.retain(operation);
          return operation;
        };
        const extract = SevenZip.prototype.extractFull;
        let extractions = 0;
        vi.spyOn(SevenZip.prototype, "extractFull").mockImplementation(function (
          this: SevenZip,
          ...args: Parameters<typeof extract>
        ) {
          const original = extract.call(this, ...args);
          void retain(original);
          const operation = original.then(async (value) => {
            extractions++;
            await hold("extract");
            return value;
          });
          fixture.retain(operation);
          return operation;
        });
        const requests: unknown[][] = [];
        h.api.emitAndAwait = (async (...args: unknown[]) => {
          requests.push(args);
          expect(args.slice(0, 4)).toEqual(["nexus-download", "site", 500, 2]);
          await hold("download");
          return ["update"];
        }) as typeof h.api.emitAndAwait;
        const dismiss = h.api.dismissNotification;
        const terminal: string[] = [];
        vi.spyOn(h.api, "dismissNotification").mockImplementation((notificationId) => {
          const result = dismiss(notificationId);
          terminal.push(notificationId);
          completed.resolve();
          return result;
        });
        let props!: () => Partial<IExtensionManagerProps>;
        const context = {
          api: h.api,
          registerReducer: vi.fn(),
          registerMainPage: (
            _id: string,
            _title: string,
            _component: unknown,
            options: { props: typeof props },
          ) => {
            props = options.props;
          },
          registerDialog: vi.fn(),
          registerInstaller: vi.fn(),
          once: vi.fn(),
        };
        expect(init(context as unknown as IExtensionContext)).toBe(true);
        props().onRefresh!();
        try {
          await entered.promise;
          if (mode === "disabled") h.api.store.dispatch(setExtensionEnabled(key, false));
          if (mode === "removed") h.api.store.dispatch(removeExtension(key));
          expect(h.getState().app.extensions[key]).toMatchObject({
            enabled: mode !== "disabled",
            remove: mode === "removed",
          });
        } finally {
          armed = false;
          release.resolve();
        }
        await completed.promise;
        await drain();
        expect(holds).toBe(1);
        expect(requests).toHaveLength(1);
        expect(terminal).toEqual(["extension-updates"]);
        const entries = Object.values(h.getState().app.extensions);
        const active = entries.filter((entry) => !entry.remove);
        const manifest = JSON.parse(
          await readFile(path.join(fixture.root, "plugins", id, "info.json"), "utf8"),
        );
        const replaced = mode === "enabled" || boundary === "remove" || boundary === "rename";
        const expectedExtractions = boundary === "download" && mode !== "enabled" ? 0 : 1;
        expect(continuations).toEqual(
          Array.from({ length: expectedExtractions === 0 ? 5 : replaced ? 13 : 9 }, () => 1),
        );
        expect(nativeSubmitted).toBe(expectedExtractions === 0 ? 0 : replaced ? 3 : 1);
        expect(nativeSettled).toBe(nativeSubmitted);
        expect(nativeActive.size).toBe(0);
        expect(manifest.version).toBe(replaced ? "2.0.0" : "1.0.0");
        expect(extractions).toBe(expectedExtractions);
        expect(nativeCalls).toEqual(replaced ? ["remove", "rename"] : []);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          enabled: mode !== "disabled",
          remove: mode === "removed",
          version: manifest.version,
        });
        if (mode === "removed") expect(active).toEqual([]);
        if (mode !== "removed") expect(discovered(h)).toHaveLength(mode === "enabled" ? 1 : 0);
        expect(
          h.notifications.filter(
            (note) => note.id === "extension-updates" && note.type === "success",
          ),
        ).toHaveLength(replaced ? 1 : 0);
        expect(h.errorNotifications).toEqual([]);
        for (const [filename, contents] of sources)
          expect(await readFile(filename)).toEqual(contents);
        expect(
          (await readdir(path.join(fixture.root, "plugins"))).filter((name) =>
            name.endsWith(".installing"),
          ),
        ).toEqual([]);
      });
    }
  }
});
