import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
}));
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
import * as queries from "./queries";
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

describe("extension page refresh policy", () => {
  for (const mode of ["enabled", "disabled", "removed"] as const) {
    it(`preserves the ${mode} choice through the registered refresh action`, async () => {
      const h = setup();
      const id = "fixture-extension";
      const old = makeAvailableExtension({ name: id, modId: 500, fileId: 1, version: "1.0.0" });
      const update = makeAvailableExtension({ name: id, modId: 500, fileId: 2, version: "2.0.0" });
      const oldArchive = await archive(id, "1.0.0");
      const updateArchive = await archive(id, "2.0.0");
      expect(
        (await retain(installExtension(h.api, oldArchive, { catalogEntry: old }))).error,
      ).toBeUndefined();
      const key = Object.keys(h.getState().app.extensions)[0];
      if (mode === "disabled") h.api.store.dispatch(setExtensionEnabled(key, false));
      if (mode === "removed") h.api.store.dispatch(removeExtension(key));
      if (mode !== "removed") expect(discovered(h)).toHaveLength(mode === "disabled" ? 0 : 1);
      fixture.available = [update];
      h.setState((state) => {
        state.persistent.downloads.files.update = makeDownload({
          id: "update",
          state: "finished",
          localPath: path.basename(updateArchive),
          game: ["site"],
        });
      });
      const requests: unknown[][] = [];
      h.api.emitAndAwait = (async (...args: unknown[]) => {
        requests.push(args);
        expect(args.slice(0, 4)).toEqual(["nexus-download", "site", 500, 2]);
        return ["update"];
      }) as typeof h.api.emitAndAwait;
      const find = queries.findUpdatableExtensions;
      let selectionDone!: () => void;
      const selection = new Promise<void>((resolve) => {
        selectionDone = resolve;
      });
      vi.spyOn(queries, "findUpdatableExtensions").mockImplementation((...args) => {
        const result = find(...args);
        selectionDone();
        return result;
      });
      const sendNotification = h.api.sendNotification;
      let refreshDone!: () => void;
      const refreshed = new Promise<void>((resolve) => {
        refreshDone = resolve;
      });
      vi.spyOn(h.api, "sendNotification").mockImplementation((notification) => {
        const result = sendNotification(notification);
        if (notification.id === "extension-updates" && notification.type === "success")
          refreshDone();
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
      await selection;
      if (mode === "enabled") await refreshed;
      await drain();
      expect(queries.findUpdatableExtensions).toHaveBeenCalledTimes(1);
      for (const [filename, contents] of sources)
        expect(await readFile(filename)).toEqual(contents);
      expect(
        (await readdir(path.join(fixture.root, "plugins"))).filter((name) =>
          name.endsWith(".installing"),
        ),
      ).toEqual([]);
      const entries = Object.values(h.getState().app.extensions);
      const manifest = JSON.parse(
        await readFile(path.join(fixture.root, "plugins", id, "info.json"), "utf8"),
      );
      if (mode === "enabled") {
        expect(requests).toHaveLength(1);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ enabled: true, remove: false, version: "2.0.0" });
        expect(manifest.version).toBe("2.0.0");
        expect(discovered(h)).toHaveLength(1);
        expect(
          h.notifications.filter(
            (note) => note.id === "extension-updates" && note.type === "success",
          ),
        ).toHaveLength(1);
      } else {
        expect(requests).toEqual([]);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          enabled: mode !== "disabled",
          remove: mode === "removed",
          version: "1.0.0",
        });
        expect(manifest.version).toBe("1.0.0");
        if (mode === "disabled") expect(discovered(h)).toEqual([]);
      }
      expect(continuations).toEqual(Array.from({ length: mode === "enabled" ? 5 : 4 }, () => 1));
      expect(h.errorNotifications).toEqual([]);
    });
  }
});
