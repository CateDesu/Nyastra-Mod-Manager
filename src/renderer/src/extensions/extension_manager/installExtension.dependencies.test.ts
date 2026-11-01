import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import PromiseBB from "bluebird";
import SevenZip from "node-7z";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({ root: "" }));
vi.mock("../../util/getVortexPath", () => ({ default: () => paths.root }));
vi.mock("../../util/errorHandling", async (importOriginal) => ({
  ...(await importOriginal<typeof ErrorHandling>()),
  withTrackedActivity: async <T>(
    _tracer: string,
    _span: string,
    _attributes: unknown,
    run: () => Promise<T>,
  ) => run(),
}));

import { removeExtension, setExtensionEnabled } from "../../actions";
import ExtensionManager from "../../ExtensionManager";
import { appReducer } from "../../reducers/app";
import { makeApiHarness, makeAvailableExtension } from "../../test-utils/builders";
import { test } from "../../test-utils/harnessTest";
import type { IApiHarness } from "../../test-utils/harnessTypes";
import type { IAvailableExtension } from "../../types/extensions";
import type { IExtensionApi } from "../../types/IExtensionContext";
import { DataInvalid } from "../../util/CustomErrors";
import type * as ErrorHandling from "../../util/errorHandling";
import installExtension from "./installExtension";

type InstallData = Parameters<typeof installExtension>[2];
let directory: string;
let nativeRequire: NodeJS.Require;
let operations: Promise<unknown>[];
let continuations: number[];
let sources: Map<string, Buffer>;
let roots: Set<string>;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "extension-dependencies-")));
  paths.root = path.join(directory, "profile");
  nativeRequire = createRequire(path.join(process.cwd(), "package.json"));
  vi.stubGlobal("__non_webpack_require__", nativeRequire);
  operations = [];
  continuations = [];
  sources = new Map();
  roots = new Set();
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
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

function makeApi() {
  const h = makeApiHarness({}, [{ path: ["app"], reducer: appReducer }]);
  h.api.getLoadedExtensions = () => [];
  h.setState((state) => {
    state.session.extensions = { available: [], optional: {}, updateTime: 0, showBundled: false };
  });
  return h;
}

async function archive(
  id: string,
  {
    version = "1.0.0",
    code = "module.exports = () => true;",
    folder = id,
    filename = "extension.zip",
    files = {},
  }: {
    version?: string;
    code?: string;
    folder?: string;
    filename?: string;
    files?: Record<string, string>;
  } = {},
) {
  const source = await mkdtemp(path.join(directory, "source-"));
  const entries = {
    "index.js": code,
    "info.json": JSON.stringify({ id, name: id, version }),
    ...files,
  };
  for (const [name, bytes] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await writeFile(path.join(source, name), bytes);
  }
  const destination = path.join(directory, folder, filename);
  await mkdir(path.dirname(destination), { recursive: true });
  await new SevenZip().add(
    destination,
    Object.keys(entries).map((name) => path.join(source, name)),
    {},
  );
  sources.set(destination, await readFile(destination));
  return destination;
}

function invoke(api: IExtensionApi, file: string, data?: InstallData) {
  roots.add(paths.root);
  const slot = continuations.length;
  continuations.push(0);
  const original = installExtension(api, file, data);
  operations.push(original);
  const outcome = original.then(
    () => {
      continuations[slot]++;
      return undefined;
    },
    (error: unknown) => {
      continuations[slot]++;
      return error;
    },
  );
  operations.push(outcome);
  return { original, outcome };
}

async function settled(count: number) {
  await drain();
  expect(continuations).toEqual(Array.from({ length: count }, () => 1));
  for (const [filename, bytes] of sources) expect(await readFile(filename)).toEqual(bytes);
  for (const root of roots) {
    const entries = await readdir(path.join(root, "plugins")).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    expect(entries, "the requested workspace must contain its plugins directory").not.toBeNull();
    expect(entries!.filter((name) => name.includes(".installing"))).toEqual([]);
  }
}

async function installedVersion(h: IApiHarness, id: string) {
  const entry = Object.values(h.getState().app.extensions).find(
    (ext) => ext.infoJsonId === id && !ext.remove,
  );
  expect(entry).toBeDefined();
  const info = JSON.parse(await readFile(path.join(entry!.path, "info.json"), "utf8"));
  return info.version;
}

function dependencyCode(
  id = "dependency",
  version: string | undefined = "^2.0.0",
  optional = false,
) {
  return `module.exports = context => { context.requireExtension(${JSON.stringify(id)}, ${JSON.stringify(version)}, ${optional}); return true; };`;
}

function catalog(
  h: IApiHarness,
  entries: IAvailableExtension[],
  files: Map<number, string>,
  mode = "install",
) {
  h.setState((state) => {
    state.session.extensions.available = entries;
  });
  const requests: IAvailableExtension[] = [];
  const emitter = async (event: string, entry: IAvailableExtension) => {
    expect(event).toBe("install-extension");
    requests.push(entry);
    if (mode === "decline") return [false];
    const filename = files.get(entry.fileId);
    expect(filename).toBeDefined();
    const error = await invoke(h.api, filename!, { catalogEntry: entry }).outcome;
    if (error !== undefined) throw error;
    return [true];
  };
  h.api.emitAndAwait = emitter as IExtensionApi["emitAndAwait"];
  return requests;
}

describe("public archive installation ownership", () => {
  test("isolates concurrent extraction workspaces", async () => {
    const h = makeApi();
    const firstFile = await archive("first", { folder: "one" });
    const secondFile = await archive("second", { folder: "two" });
    const actualExtract = SevenZip.prototype.extractFull;
    const destinations: string[] = [];
    let release: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const extraction = vi
      .spyOn(SevenZip.prototype, "extractFull")
      .mockImplementation(function (file, destination, options) {
        destinations.push(destination);
        if (destinations.length === 2) release();
        return PromiseBB.resolve(bothEntered).then(() =>
          actualExtract.call(this, file, destination, options),
        ) as ReturnType<typeof actualExtract>;
      });
    try {
      const first = invoke(h.api, firstFile);
      const second = invoke(h.api, secondFile);
      const outcomes = await Promise.all([first.outcome, second.outcome]);
      await drain();
      expect(destinations).toHaveLength(2);
      expect(new Set(destinations).size).toBe(2);
      expect(outcomes).toEqual([undefined, undefined]);
      expect(
        Object.values(h.getState().app.extensions)
          .map((entry) => entry.infoJsonId)
          .sort(),
      ).toEqual(["first", "second"]);
      expect(await installedVersion(h, "first")).toBe("1.0.0");
      expect(await installedVersion(h, "second")).toBe("1.0.0");
      await settled(2);
    } finally {
      release();
      await drain();
      extraction.mockRestore();
    }
  });

  for (const schedule of [
    "same-basename",
    "different-basename",
    "sequential",
    "exact-archive",
    "normalized-path",
    "workspace",
  ] as const) {
    test(`retains requested bytes for ${schedule}`, async () => {
      const h = makeApi();
      const other = schedule === "workspace" ? makeApi() : h;
      const firstFile = await archive("first", { folder: "one" });
      const secondFile = ["exact-archive", "normalized-path", "workspace"].includes(schedule)
        ? firstFile
        : await archive("second", {
            folder: "two",
            filename: schedule === "different-basename" ? "other.zip" : "extension.zip",
          });
      const firstRoot = paths.root;
      const first = invoke(h.api, firstFile);
      if (schedule === "sequential") await first.outcome;
      if (schedule === "workspace") paths.root = path.join(directory, "other-profile");
      const secondRoot = paths.root;
      const second = invoke(
        other.api,
        schedule === "normalized-path" ? path.relative(process.cwd(), secondFile) : secondFile,
      );
      const outcomes = await Promise.all([first.outcome, second.outcome]);
      await settled(2);
      expect(outcomes).toEqual([undefined, undefined]);
      const same = schedule === "exact-archive" || schedule === "normalized-path";
      expect(first.original === second.original).toBe(same);
      expect(
        Object.values(h.getState().app.extensions)
          .map((entry) => entry.infoJsonId)
          .sort(),
      ).toEqual(same || schedule === "workspace" ? ["first"] : ["first", "second"]);
      expect(await readFile(path.join(firstRoot, "plugins", "first", "index.js"), "utf8")).toBe(
        "module.exports = () => true;",
      );
      const secondId = same || schedule === "workspace" ? "first" : "second";
      expect(await readFile(path.join(secondRoot, "plugins", secondId, "index.js"), "utf8")).toBe(
        "module.exports = () => true;",
      );
      if (schedule === "workspace")
        expect(Object.values(other.getState().app.extensions)).toHaveLength(1);
    });
  }

  test("cleans rejected extraction work and accepts a corrected retry", async () => {
    const h = makeApi();
    const filename = await archive("..", { folder: "retry" });
    const failed = await invoke(h.api, filename).outcome;
    await settled(1);
    expect(failed).toBeInstanceOf(DataInvalid);
    await rm(filename);
    await archive("corrected", { folder: "retry" });
    const retried = await invoke(h.api, filename).outcome;
    await settled(2);
    expect(retried).toBeUndefined();
    expect(await installedVersion(h, "corrected")).toBe("1.0.0");
  });
});

describe("fresh dependency scanning", () => {
  for (const helper of [false, true])
    for (const loaded of [false, true]) {
      test(`scans replaced ${helper ? "helper modules" : "entry code"} with loaded=${loaded}`, async () => {
        const h = makeApi();
        const oldDependency = makeAvailableExtension({
          name: "old-dependency",
          modId: 101,
          fileId: 1,
        });
        const newDependency = makeAvailableExtension({
          name: "new-dependency",
          modId: 102,
          fileId: 2,
        });
        const requests = catalog(
          h,
          [oldDependency, newDependency],
          new Map([
            [1, await archive("old-dependency")],
            [2, await archive("new-dependency")],
          ]),
        );
        const entry = helper
          ? 'module.exports = context => { context.requireExtension(require("./helper").id); return true; };'
          : dependencyCode("old-dependency", "*");
        const oldFile = await archive("consumer", {
          folder: "old",
          code: entry,
          files: helper
            ? {
                "helper.js": 'module.exports = require("./requirement.json");',
                "requirement.json": '{"id":"old-dependency"}',
              }
            : {},
        });
        const newCode = helper ? entry : dependencyCode("new-dependency", "*");
        const newFile = await archive("consumer", {
          version: "2.0.0",
          folder: "new",
          code: newCode,
          files: helper
            ? {
                "helper.js": 'module.exports = require("./requirement.json");',
                "requirement.json": '{"id":"new-dependency"}',
              }
            : {},
        });
        const oldEntry = makeAvailableExtension({ name: "consumer", modId: 100, fileId: 3 });
        expect(await invoke(h.api, oldFile, { catalogEntry: oldEntry }).outcome).toBeUndefined();
        const consumerPath = path.join(paths.root, "plugins", "consumer");
        const modulePath = path.join(consumerPath, "index.js");
        const oldModule = nativeRequire.cache[modulePath];
        const running = nativeRequire(modulePath) as (context: {
          requireExtension: (id: string) => void;
        }) => void;
        const previousHelper = nativeRequire.cache[path.join(consumerPath, "helper.js")];
        const sharedPath = path.join(directory, "shared.js");
        await writeFile(sharedPath, 'module.exports = { value: "keep" };');
        const shared = nativeRequire(sharedPath);
        if (loaded)
          h.api.getLoadedExtensions = () =>
            [{ name: "consumer", path: consumerPath }] as ReturnType<
              IExtensionApi["getLoadedExtensions"]
            >;
        const result = await invoke(h.api, newFile, {
          catalogEntry: { ...oldEntry, fileId: 4, version: "2.0.0" },
        }).outcome;
        await drain();
        expect(result).toBeUndefined();
        expect(requests.map((entry) => entry.name)).toEqual(["old-dependency", "new-dependency"]);
        expect(await installedVersion(h, "consumer")).toBe("2.0.0");
        expect(await installedVersion(h, "new-dependency")).toBe("1.0.0");
        expect(await readFile(modulePath, "utf8")).toBe(newCode);
        expect(nativeRequire(sharedPath)).toBe(shared);
        const observed: string[] = [];
        if (loaded) {
          expect(nativeRequire.cache[modulePath]).toBe(oldModule);
          if (helper)
            expect(nativeRequire.cache[path.join(consumerPath, "helper.js")]).toBe(previousHelper);
          running({ requireExtension: (id) => observed.push(id) });
          expect(observed).toEqual(["old-dependency"]);
        } else {
          nativeRequire(modulePath)({ requireExtension: (id: string) => observed.push(id) });
          expect(observed).toEqual(["new-dependency"]);
        }
        await settled(4);
      });
    }
});

describe("dependency range resolution", () => {
  for (const initial of ["1.0.0", "2.0.0", undefined]) {
    test(`satisfies required range from installed=${initial}`, async () => {
      const h = makeApi();
      const entry = makeAvailableExtension({
        name: "dependency",
        modId: 200,
        fileId: 2,
        version: "2.0.0",
      });
      if (initial)
        expect(
          await invoke(
            h.api,
            await archive("dependency", { version: initial, folder: "initial" }),
            { catalogEntry: { ...entry, fileId: 1, version: initial } },
          ).outcome,
        ).toBeUndefined();
      const requests = catalog(
        h,
        [entry],
        new Map([[2, await archive("dependency", { version: "2.0.0", folder: "new" })]]),
      );
      const result = await invoke(h.api, await archive("consumer", { code: dependencyCode() }))
        .outcome;
      await settled(initial === "1.0.0" ? 3 : 2);
      expect(result).toBeUndefined();
      expect(requests.map((entry) => entry.fileId)).toEqual(initial === "2.0.0" ? [] : [2]);
      expect(await installedVersion(h, "dependency")).toBe("2.0.0");
    });
  }

  test("selects the highest compatible catalog file and intersects repeated required ranges", async () => {
    const h = makeApi();
    const entries = ["3.0.0", "invalid", "2.0.0", "2.5.0", "2.3.0"].map((version, index) =>
      makeAvailableExtension({ name: "dependency", modId: 200, fileId: index + 1, version }),
    );
    const files = new Map<number, string>();
    for (const entry of entries)
      files.set(
        entry.fileId,
        await archive("dependency", { version: entry.version, folder: String(entry.fileId) }),
      );
    const requests = catalog(h, entries, files);
    const code =
      'module.exports = context => { context.requireExtension("dependency", "^2.0.0"); context.requireExtension("dependency", "<2.4.0"); return true; };';
    const result = await invoke(h.api, await archive("consumer", { code })).outcome;
    await settled(2);
    expect(result).toBeUndefined();
    expect(requests.map((entry) => entry.fileId)).toEqual([5]);
    expect(await installedVersion(h, "dependency")).toBe("2.3.0");
  });

  for (const condition of [
    "missing",
    "unsupported",
    "invalid-range",
    "declined",
    "wrong-manifest",
    "conflicting-ranges",
  ] as const) {
    test(`reports unmet required dependency for ${condition}`, async () => {
      const h = makeApi();
      const entry = makeAvailableExtension({
        name: "dependency",
        modId: 200,
        fileId: 2,
        version: condition === "unsupported" ? "3.0.0" : "2.0.0",
      });
      const file = await archive("dependency", {
        version: condition === "wrong-manifest" ? "1.0.0" : entry.version,
      });
      const requests = catalog(
        h,
        condition === "missing" ? [] : [entry],
        new Map([[2, file]]),
        condition === "declined" ? "decline" : "install",
      );
      const code =
        condition === "conflicting-ranges"
          ? 'module.exports = context => { context.requireExtension("dependency", "^1.0.0"); context.requireExtension("dependency", "^2.0.0"); return true; };'
          : dependencyCode("dependency", condition === "invalid-range" ? "not a range" : "^2.0.0");
      const result = await invoke(h.api, await archive("consumer", { code })).outcome;
      const attempted = condition === "declined" || condition === "wrong-manifest";
      await settled(condition === "wrong-manifest" ? 2 : 1);
      expect(result).toBeInstanceOf(DataInvalid);
      expect((result as Error).message).toContain('Extension dependency "dependency" requires');
      expect(requests).toHaveLength(attempted ? 1 : 0);
    });
  }

  for (const condition of [
    "missing",
    "unsupported",
    "invalid-range",
    "declined",
    "upgrade",
  ] as const) {
    test(`preserves optional behavior for ${condition}`, async () => {
      const h = makeApi();
      const entry = makeAvailableExtension({
        name: "dependency",
        modId: 200,
        fileId: 2,
        version: condition === "unsupported" ? "3.0.0" : "2.0.0",
      });
      if (condition === "upgrade")
        expect(
          await invoke(h.api, await archive("dependency", { folder: "old" }), {
            catalogEntry: { ...entry, fileId: 1, version: "1.0.0" },
          }).outcome,
        ).toBeUndefined();
      const requests = catalog(
        h,
        condition === "missing" ? [] : [entry],
        new Map([[2, await archive("dependency", { version: entry.version, folder: "new" })]]),
        condition === "declined" ? "decline" : "install",
      );
      const result = await invoke(
        h.api,
        await archive("consumer", {
          code: dependencyCode(
            "dependency",
            condition === "invalid-range" ? "not a range" : "^2.0.0",
            true,
          ),
        }),
      ).outcome;
      await settled(condition === "upgrade" ? 3 : 1);
      expect(result).toBeUndefined();
      expect(requests).toHaveLength(condition === "upgrade" || condition === "declined" ? 1 : 0);
      if (condition === "upgrade") expect(await installedVersion(h, "dependency")).toBe("2.0.0");
    });
  }

  for (const condition of ["removed", "disabled", "missing-files"] as const) {
    test(`replaces an unusable installed dependency with ${condition}`, async () => {
      const h = makeApi();
      const entry = makeAvailableExtension({
        name: "dependency",
        modId: 200,
        fileId: 2,
        version: "2.0.0",
      });
      expect(
        await invoke(h.api, await archive("dependency", { version: "2.0.0", folder: "old" }), {
          catalogEntry: entry,
        }).outcome,
      ).toBeUndefined();
      const key = Object.keys(h.getState().app.extensions)[0];
      if (condition === "removed") h.api.store.dispatch(removeExtension(key));
      else if (condition === "disabled") h.api.store.dispatch(setExtensionEnabled(key, false));
      else await rm(path.join(paths.root, "plugins", "dependency"), { recursive: true });
      const requests = catalog(
        h,
        [entry],
        new Map([[2, await archive("dependency", { version: "2.0.0", folder: "new" })]]),
      );
      const result = await invoke(h.api, await archive("consumer", { code: dependencyCode() }))
        .outcome;
      await settled(3);
      expect(result).toBeUndefined();
      expect(requests).toHaveLength(1);
      expect(await installedVersion(h, "dependency")).toBe("2.0.0");
    });
  }
});

describe("recursive dependency installation", () => {
  for (const condition of [
    "chain",
    "compatible-cycle",
    "conflicting-cycle",
    "compatible-self",
    "conflicting-self",
  ] as const) {
    test(`settles recursive ${condition}`, async () => {
      const h = makeApi();
      const first = makeAvailableExtension({
        name: "first",
        modId: 100,
        fileId: 1,
        version: "1.0.0",
      });
      const second = makeAvailableExtension({
        name: "second",
        modId: 200,
        fileId: 2,
        version: "1.0.0",
      });
      const third = makeAvailableExtension({
        name: "third",
        modId: 300,
        fileId: 3,
        version: "1.0.0",
      });
      const self = condition.endsWith("self");
      const conflict = condition.startsWith("conflicting");
      const firstFile = await archive("first", {
        code: dependencyCode(self ? "first" : "second", self && conflict ? "^2.0.0" : "^1.0.0"),
      });
      const secondFile = await archive("second", {
        code: dependencyCode(
          condition === "chain" ? "third" : "first",
          conflict ? "^2.0.0" : "^1.0.0",
        ),
      });
      const thirdFile = await archive("third");
      const requests = catalog(
        h,
        [first, second, third, { ...first, fileId: 4, version: "2.0.0" }],
        new Map([
          [1, firstFile],
          [2, secondFile],
          [3, thirdFile],
          [4, firstFile],
        ]),
      );
      const result = await invoke(h.api, firstFile, { catalogEntry: first }).outcome;
      await settled(self ? 1 : condition === "chain" ? 3 : 2);
      if (conflict) {
        expect(result).toBeInstanceOf(DataInvalid);
        expect((result as Error).message).toContain('Extension dependency "first" requires ^2.0.0');
      } else expect(result).toBeUndefined();
      expect(requests.map((entry) => entry.name)).toEqual(
        self ? [] : condition === "chain" ? ["second", "third"] : ["second"],
      );
      expect(await installedVersion(h, "first")).toBe("1.0.0");
    });
  }

  test("awaits a shared recursive archive from both public consumers", async () => {
    const h = makeApi();
    const entry = makeAvailableExtension({
      name: "dependency",
      modId: 200,
      fileId: 2,
      version: "2.0.0",
    });
    const dependencyFile = await archive("dependency", { version: "2.0.0" });
    h.setState((state) => {
      state.session.extensions.available = [entry];
    });
    let releaseRequests: () => void;
    const bothRequested = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    const dependencies: ReturnType<typeof invoke>[] = [];
    let requests = 0;
    const emitter = async (event: string, requested: IAvailableExtension) => {
      expect(event).toBe("install-extension");
      expect(requested).toEqual(entry);
      requests++;
      if (requests === 2) releaseRequests();
      await bothRequested;
      const operation = invoke(h.api, dependencyFile, { catalogEntry: requested });
      dependencies.push(operation);
      const error = await operation.outcome;
      if (error !== undefined) throw error;
      return [true];
    };
    h.api.emitAndAwait = emitter as IExtensionApi["emitAndAwait"];
    const firstFile = await archive("first", { code: dependencyCode() });
    const secondFile = await archive("second", { code: dependencyCode() });
    const first = invoke(h.api, firstFile);
    const second = invoke(h.api, secondFile);
    const results = await Promise.all([first.outcome, second.outcome]);
    await settled(4);
    expect(results).toEqual([undefined, undefined]);
    expect(requests).toBe(2);
    expect(dependencies[0].original).toBe(dependencies[1].original);
    expect(await installedVersion(h, "dependency")).toBe("2.0.0");
    expect(
      Object.values(h.getState().app.extensions).filter((ext) => ext.infoJsonId === "dependency"),
    ).toHaveLength(1);
  });
});

function loaderFailures(h: IApiHarness) {
  // Run the real discovery and registration methods without desktop startup.
  const manager = Object.create(ExtensionManager.prototype) as ExtensionManager;
  Object.assign(manager, {
    mApi: h.api,
    mEventEmitter: h.api.events,
    mExtensions: [],
    mExtensionFormats: ["index.cjs", "index.js"],
    mOutdated: [],
    mLoadFailures: {},
  });
  for (const installed of Object.values(h.getState().app.extensions)) {
    if (installed.remove || installed.enabled === false) continue;
    const registered = manager["loadDynamicExtension"](
      installed.path,
      manager["mExtensions"],
      false,
    );
    if (registered) manager["mExtensions"].push(registered);
  }
  manager["initExtensions"]();
  return manager["mLoadFailures"];
}

describe("dependency identities agree with the production loader", () => {
  for (const firstVersion of ["1.0.0", "2.0.0"]) {
    test(`uses the first registered manifest name with version=${firstVersion}`, async () => {
      const h = makeApi();
      for (const [id, version] of [
        ["first", firstVersion],
        ["second", firstVersion === "1.0.0" ? "2.0.0" : "1.0.0"],
      ]) {
        const file = await archive(id, {
          version,
          files: { "info.json": JSON.stringify({ id, name: "Shared Name", version }) },
        });
        expect(await invoke(h.api, file).outcome).toBeUndefined();
      }
      const result = await invoke(
        h.api,
        await archive("consumer", { code: dependencyCode("Shared Name") }),
      ).outcome;
      await settled(3);
      if (firstVersion === "1.0.0") {
        expect(loaderFailures(h)).toMatchObject({ consumer: [{ id: "dependency" }] });
        expect(result).toBeInstanceOf(DataInvalid);
      } else {
        expect(loaderFailures(h)).toEqual({});
        expect(result).toBeUndefined();
      }
    });
  }

  for (const requested of ["dependency-id", "Display Dependency", "catalog-dependency"]) {
    test(`checks installed manifest identity ${requested}`, async () => {
      const h = makeApi();
      const entry = makeAvailableExtension({
        name: "catalog-dependency",
        modId: 200,
        fileId: 2,
        version: "2.0.0",
      });
      const dependency = await archive("dependency-id", {
        version: "2.0.0",
        files: {
          "info.json": JSON.stringify({
            id: "dependency-id",
            name: "Display Dependency",
            version: "2.0.0",
          }),
        },
      });
      expect(await invoke(h.api, dependency, { catalogEntry: entry }).outcome).toBeUndefined();
      const requests = catalog(h, [entry], new Map([[2, dependency]]));
      const consumer = await archive("consumer", { code: dependencyCode(requested) });
      const outcome = await invoke(h.api, consumer).outcome;
      await settled(2 + requests.length);
      const failures = loaderFailures(h);
      if (requested === "catalog-dependency") {
        expect(failures).toMatchObject({ consumer: [{ id: "dependency" }] });
        expect(outcome, "a rejected catalog alias cannot satisfy installation").toBeInstanceOf(
          DataInvalid,
        );
      } else {
        expect(failures).toEqual({});
        expect(requests).toHaveLength(0);
        expect(outcome, "an accepted manifest identity must satisfy installation").toBeUndefined();
      }
    });
  }

  for (const withId of [false, true]) {
    test(`accepts the directory name only when it is registered, withId=${withId}`, async () => {
      const h = makeApi();
      const file = await archive("dependency/id", {
        version: "2.0.0",
        files: {
          "info.json": JSON.stringify({
            ...(withId ? { id: "dependency/id" } : {}),
            name: "Display Dependency",
            version: "2.0.0",
          }),
        },
      });
      expect(await invoke(h.api, file).outcome).toBeUndefined();
      const installed = Object.values(h.getState().app.extensions)[0];
      const registeredName = path.basename(installed.path);
      expect(registeredName).not.toBe("dependency/id");
      const result = await invoke(
        h.api,
        await archive("consumer", { code: dependencyCode(registeredName) }),
      ).outcome;
      await settled(2);
      if (withId) {
        expect(loaderFailures(h)).toMatchObject({ consumer: [{ id: "dependency" }] });
        expect(result).toBeInstanceOf(DataInvalid);
      } else {
        expect(loaderFailures(h)).toEqual({});
        expect(result).toBeUndefined();
      }
    });
  }

  for (const accepts of [false, true]) {
    test(`checks the installed manifest after the catalog request, accepts=${accepts}`, async () => {
      const h = makeApi();
      const entry = makeAvailableExtension({
        name: "Required Name",
        modId: 200,
        fileId: 2,
        version: "2.0.0",
      });
      const dependency = await archive("dependency-id", {
        version: "2.0.0",
        files: {
          "info.json": JSON.stringify({
            id: "dependency-id",
            name: accepts ? "Required Name" : "Different Name",
            version: "2.0.0",
          }),
        },
      });
      const requests = catalog(h, [entry], new Map([[2, dependency]]));
      const result = await invoke(
        h.api,
        await archive("consumer", { code: dependencyCode("Required Name") }),
      ).outcome;
      await settled(2);
      expect(requests).toHaveLength(1);
      if (accepts) {
        expect(loaderFailures(h)).toEqual({});
        expect(result).toBeUndefined();
      } else {
        expect(loaderFailures(h)).toMatchObject({ consumer: [{ id: "dependency" }] });
        expect(result).toBeInstanceOf(DataInvalid);
      }
    });
  }

  for (const stale of ["identity", "version", "empty-id"] as const) {
    test(`reads current manifest bytes with stale ${stale}`, async () => {
      const h = makeApi();
      const file = await archive("dependency-id", { version: "2.0.0" });
      expect(
        await invoke(h.api, file, {
          catalogEntry: makeAvailableExtension({ name: "old-catalog-name", version: "2.0.0" }),
        }).outcome,
      ).toBeUndefined();
      const installed = Object.values(h.getState().app.extensions)[0];
      const infoFile = path.join(installed.path, "info.json");
      const cached = nativeRequire(infoFile);
      const info = {
        id: stale === "empty-id" ? "" : "new-id",
        name: "New Name",
        version: stale === "version" ? "1.0.0" : "2.0.0",
      };
      await writeFile(infoFile, JSON.stringify(info));
      const requested =
        stale === "empty-id"
          ? path.basename(installed.path)
          : stale === "identity"
            ? "dependency-id"
            : "New Name";
      const result = await invoke(
        h.api,
        await archive("consumer", { code: dependencyCode(requested) }),
      ).outcome;
      await settled(2);
      expect(nativeRequire(infoFile)).toBe(cached);
      if (stale === "empty-id") {
        expect(loaderFailures(h)).toEqual({});
        expect(result).toBeUndefined();
      } else {
        expect(loaderFailures(h)).toMatchObject({ consumer: [{ id: "dependency" }] });
        expect(result).toBeInstanceOf(DataInvalid);
      }
    });
  }

  test("rejects a conflicting recursive manifest name before requesting its active archive", async () => {
    const h = makeApi();
    const entry = makeAvailableExtension({
      name: "Catalog Name",
      modId: 200,
      fileId: 2,
      version: "2.0.0",
    });
    const file = await archive("dependency-id", {
      files: {
        "info.json": JSON.stringify({
          id: "dependency-id",
          name: "Manifest Name",
          version: "1.0.0",
        }),
      },
      code: dependencyCode("Manifest Name"),
    });
    const requests = catalog(h, [{ ...entry, name: "Manifest Name" }], new Map([[2, file]]));
    const result = await invoke(h.api, file, { catalogEntry: entry }).outcome;
    await settled(1);
    expect(requests).toHaveLength(0);
    expect(result).toBeInstanceOf(DataInvalid);
    expect(loaderFailures(h)).toMatchObject({ "dependency-id": [{ id: "dependency" }] });
  });
});

describe("dependency scanning through user-data paths", () => {
  for (const alias of [false, true])
    for (const helper of [false, true])
      for (const loaded of [false, true]) {
        test(`updates ${helper ? "helper modules" : "entry code"} through ${alias ? "symlink" : "regular"} user-data with loaded=${loaded}`, async () => {
          const h = makeApi();
          const physicalRoot = paths.root;
          await mkdir(physicalRoot, { recursive: true });
          if (alias) {
            paths.root = path.join(directory, "profile-alias");
            await symlink(physicalRoot, paths.root, "dir");
          }
          expect(await realpath(paths.root)).toBe(physicalRoot);
          const oldDependency = makeAvailableExtension({
            name: "old-dependency",
            modId: 101,
            fileId: 1,
          });
          const newDependency = makeAvailableExtension({
            name: "new-dependency",
            modId: 102,
            fileId: 2,
            version: "2.0.0",
          });
          const requests = catalog(
            h,
            [oldDependency, newDependency],
            new Map([
              [1, await archive("old-dependency")],
              [2, await archive("new-dependency", { version: "2.0.0" })],
            ]),
          );
          const entry = helper
            ? 'module.exports = context => { context.requireExtension(require("./helper").id); return true; };'
            : dependencyCode("old-dependency", "*");
          const newCode = helper ? entry : dependencyCode("new-dependency", "^2.0.0");
          const oldFile = await archive("consumer", {
            folder: "old",
            code: entry,
            files: helper
              ? {
                  "helper.js": 'module.exports = require("./requirement.json");',
                  "requirement.json": '{"id":"old-dependency"}',
                }
              : {},
          });
          const newFile = await archive("consumer", {
            folder: "new",
            version: "2.0.0",
            code: newCode,
            files: helper
              ? {
                  "helper.js": 'module.exports = require("./requirement.json");',
                  "requirement.json": '{"id":"new-dependency"}',
                }
              : {},
          });
          const extract = SevenZip.prototype.extractFull;
          const native = new Set<PromiseLike<unknown>>();
          let submitted = 0;
          let completed = 0;
          const extraction = vi
            .spyOn(SevenZip.prototype, "extractFull")
            .mockImplementation(function (this: SevenZip, ...args: Parameters<typeof extract>) {
              const original = extract.call(this, ...args);
              submitted++;
              native.add(original);
              operations.push(Promise.resolve(original));
              const result = original.finally(() => {
                native.delete(original);
                completed++;
              });
              operations.push(Promise.resolve(result));
              return result;
            });
          try {
            const oldEntry = makeAvailableExtension({ name: "consumer", modId: 100, fileId: 3 });
            expect(
              await invoke(h.api, oldFile, { catalogEntry: oldEntry }).outcome,
            ).toBeUndefined();
            const consumerPath = path.join(paths.root, "plugins", "consumer");
            const modulePath = path.join(consumerPath, "index.js");
            const moduleKey = nativeRequire.resolve(modulePath);
            expect(moduleKey).toBe(await realpath(modulePath));
            const running = nativeRequire(modulePath) as (context: {
              requireExtension: (id: string) => void;
            }) => void;
            const oldModule = nativeRequire.cache[moduleKey];
            expect(oldModule).toBeDefined();
            const cached = new Map<string, NodeJS.Module>();
            if (helper) {
              for (const filename of ["helper.js", "requirement.json"]) {
                const key = nativeRequire.resolve(path.join(consumerPath, filename));
                expect(key).toBe(await realpath(path.join(consumerPath, filename)));
                expect(nativeRequire.cache[key]).toBeDefined();
                cached.set(key, nativeRequire.cache[key]!);
              }
            }
            const sharedPath = path.join(directory, "shared.js");
            await writeFile(sharedPath, 'module.exports = { value: "keep" };');
            const shared = nativeRequire(sharedPath);
            const sharedModule = nativeRequire.cache[nativeRequire.resolve(sharedPath)];
            if (loaded)
              h.api.getLoadedExtensions = () =>
                [
                  { name: "consumer", path: path.join(physicalRoot, "plugins", "consumer") },
                ] as ReturnType<IExtensionApi["getLoadedExtensions"]>;
            const outcome = await invoke(h.api, newFile, {
              catalogEntry: { ...oldEntry, fileId: 4, version: "2.0.0" },
            }).outcome;
            await settled(2 + requests.length);
            expect(native.size).toBe(0);
            expect(completed).toBe(submitted);
            expect(submitted).toBe(2 + requests.length);
            expect(outcome).toBeUndefined();
            expect(
              requests.map((request) => request.name),
              "the update must install its new required dependency",
            ).toEqual(["old-dependency", "new-dependency"]);
            expect(await installedVersion(h, "consumer")).toBe("2.0.0");
            expect(await installedVersion(h, "new-dependency")).toBe("2.0.0");
            expect(await readFile(modulePath, "utf8")).toBe(newCode);
            expect(
              await readFile(
                path.join(paths.root, "plugins", "new-dependency", "index.js"),
                "utf8",
              ),
            ).toBe("module.exports = () => true;");
            expect(nativeRequire(sharedPath)).toBe(shared);
            expect(nativeRequire.cache[nativeRequire.resolve(sharedPath)]).toBe(sharedModule);
            const observed: string[] = [];
            if (loaded) {
              expect(
                nativeRequire.cache[moduleKey],
                "running extension module identity must survive scanning",
              ).toBe(oldModule);
              expect(nativeRequire(modulePath)).toBe(running);
              for (const [key, original] of cached) expect(nativeRequire.cache[key]).toBe(original);
              running({ requireExtension: (id) => observed.push(id) });
              expect(observed).toEqual(["old-dependency"]);
            } else {
              expect(nativeRequire.cache[moduleKey]).not.toBe(oldModule);
              for (const [key, original] of cached)
                expect(nativeRequire.cache[key]).not.toBe(original);
              nativeRequire(modulePath)({ requireExtension: (id: string) => observed.push(id) });
              expect(observed).toEqual(["new-dependency"]);
            }
            if (helper)
              expect(await readFile(path.join(consumerPath, "requirement.json"), "utf8")).toBe(
                '{"id":"new-dependency"}',
              );
          } finally {
            await drain();
            extraction.mockRestore();
          }
        });
      }
});

describe("explicit replacement destination ownership", () => {
  for (const source of ["manual", "catalog"] as const) {
    for (const prior of ["enabled", "disabled", "removed"] as const) {
      it(`retires the ${prior} owner after a ${source} replacement commits`, async () => {
        const h = makeApi();
        const id = "explicit-replacement";
        const oldFile = await archive(id, { folder: "old" });
        const newFile = await archive(id, { folder: "new", version: "2.0.0" });
        const distinctFile = await archive("distinct-directory");
        const entry = makeAvailableExtension({ name: id, modId: 808, fileId: 1 });
        const old: unknown = await invoke(h.api, oldFile, { catalogEntry: entry }).outcome;
        const oldKey = Object.keys(h.getState().app.extensions)[0];
        if (prior === "disabled") h.api.store.dispatch(setExtensionEnabled(oldKey, false));
        if (prior === "removed") h.api.store.dispatch(removeExtension(oldKey));
        const distinct: unknown = await invoke(h.api, distinctFile, {
          analytics: { source: "manual" },
        }).outcome;
        const distinctPath = path.join(paths.root, "plugins", "distinct-directory");
        const distinctKey = Object.keys(h.getState().app.extensions).find(
          (key) => h.getState().app.extensions[key].path === distinctPath,
        );
        expect(distinctKey).toBeDefined();
        h.api.store.dispatch(removeExtension(distinctKey));
        const distinctState = h.getState().app.extensions[distinctKey];
        const distinctBytes = await readFile(path.join(distinctPath, "info.json"));
        const outcome: unknown = await invoke(
          h.api,
          newFile,
          source === "catalog"
            ? { catalogEntry: { ...entry, fileId: 2, version: "2.0.0" } }
            : { analytics: { source: "manual" } },
        ).outcome;
        await settled(3);
        expect([old, distinct, outcome]).toEqual([undefined, undefined, undefined]);
        const destination = path.join(paths.root, "plugins", id);
        const extensions = h.getState().app.extensions;
        const owners = Object.values(extensions).filter((row) => row.path === destination);
        expect(owners).toHaveLength(1);
        expect(owners[0]).toMatchObject({ enabled: true, remove: false, version: "2.0.0" });
        expect(extensions[oldKey]).toBeUndefined();
        expect(extensions[distinctKey]).toEqual(distinctState);
        expect(extensions[distinctKey].remove).toBe(true);
        expect(await readFile(path.join(distinctPath, "info.json"))).toEqual(distinctBytes);
        expect(
          JSON.parse(await readFile(path.join(destination, "info.json"), "utf8")),
        ).toMatchObject({ id, version: "2.0.0" });
      });
    }

    it(`preserves the old removal owner when a ${source} archive is invalid`, async () => {
      const h = makeApi();
      const id = "failed-replacement";
      const oldFile = await archive(id, { folder: "old" });
      const invalid = await archive(id, { folder: "invalid", files: { "info.json": "{" } });
      const entry = makeAvailableExtension({ name: id, modId: 808, fileId: 1 });
      const old: unknown = await invoke(h.api, oldFile, { catalogEntry: entry }).outcome;
      const key = Object.keys(h.getState().app.extensions)[0];
      h.api.store.dispatch(removeExtension(key));
      const before = h.getState().app.extensions;
      const manifest = path.join(paths.root, "plugins", id, "info.json");
      const bytes = await readFile(manifest);
      const outcome: unknown = await invoke(
        h.api,
        invalid,
        source === "catalog"
          ? { catalogEntry: { ...entry, fileId: 2, version: "2.0.0" } }
          : { analytics: { source: "manual" } },
      ).outcome;
      await settled(2);
      expect(old).toBeUndefined();
      expect(outcome).toBeInstanceOf(SyntaxError);
      expect(h.getState().app.extensions).toEqual(before);
      expect(await readFile(manifest)).toEqual(bytes);
    });
  }
});
