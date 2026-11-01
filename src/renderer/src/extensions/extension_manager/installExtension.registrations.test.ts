import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import SevenZip from "node-7z";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const paths = vi.hoisted(() => ({ root: "", bundled: "" }));
vi.mock("../../util/getVortexPath", () => ({
  default: (key: string) => (key === "bundledPlugins" ? paths.bundled : paths.root),
}));
vi.mock("../../util/errorHandling", async (importOriginal) => ({
  ...(await importOriginal<typeof ErrorHandling>()),
  withTrackedActivity: (_tracer: string, _span: string, _attributes: unknown, run: () => unknown) =>
    run(),
}));

import { addExtension, removeExtension, setExtensionEnabled } from "../../actions";
import ExtensionManager from "../../ExtensionManager";
import { appReducer } from "../../reducers/app";
import { makeApiHarness } from "../../test-utils/builders";
import type { ExtensionInfo, IRegisteredExtension } from "../../types/extensions";
import { DataInvalid } from "../../util/CustomErrors";
import type * as ErrorHandling from "../../util/errorHandling";
import installExtension from "./installExtension";

let root: string;
let nativeRequire: NodeJS.Require;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "extension-registrations-"));
  paths.root = path.join(root, "user-data");
  paths.bundled = path.join(root, "bundled");
  await mkdir(paths.bundled);
  await mkdir(path.join(paths.root, "plugins"), { recursive: true });
  nativeRequire = createRequire(path.join(process.cwd(), "package.json"));
  vi.stubGlobal("__non_webpack_require__", nativeRequire);
});

afterEach(async () => {
  Object.keys(nativeRequire.cache)
    .filter((filename) => filename.startsWith(root + path.sep))
    .forEach((filename) => delete nativeRequire.cache[filename]);
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

function harness() {
  const h = makeApiHarness({}, [{ path: ["app"], reducer: appReducer }]);
  h.setState((state) => {
    state.session.extensions.available = [];
  });
  h.api.getLoadedExtensions = () => [];
  return h;
}

async function extension(
  directory: string,
  info: Partial<ExtensionInfo>,
  code = "module.exports = () => true;",
) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "index.js"), code);
  await writeFile(
    path.join(directory, "info.json"),
    JSON.stringify({ name: "Dependency", version: "2.0.0", ...info }),
  );
}

function scan(h: ReturnType<typeof harness>, staticExtensions: IRegisteredExtension[] = []) {
  const manager = Object.create(ExtensionManager.prototype) as ExtensionManager;
  Object.assign(manager, {
    mApi: h.api,
    mEventEmitter: h.api.events,
    mExtensions: [],
    mExtensionState: h.getState().app.extensions,
    mExtensionFormats: ["index.cjs", "index.js"],
    mOutdated: [],
    mLoadFailures: {},
    mPendingAdds: [],
    mPendingRemoves: [],
  });
  const users = manager["loadUserExtensions"](new Set(), []);
  const bundled = manager["loadDynamicExtensions"](
    { path: paths.bundled, bundled: true },
    new Set(),
    users,
  );
  manager["mExtensions"] = [...staticExtensions, ...users, ...bundled];
  manager["initExtensions"]();
  h.api.getLoadedExtensions = () => manager.extensions;
  return manager;
}

async function archive(id: string, code: string, version = "1.0.0") {
  const source = await mkdtemp(path.join(root, "source-"));
  await extension(source, { id, name: id, version }, code);
  const file = path.join(source, "extension.zip");
  await new SevenZip().add(
    file,
    [path.join(source, "index.js"), path.join(source, "info.json")],
    {},
  );
  return file;
}

async function consumer(
  h: ReturnType<typeof harness>,
  id: string,
  version?: string,
  optional = false,
) {
  const code = `module.exports = context => { context.requireExtension(${JSON.stringify(id)}, ${JSON.stringify(version)}, ${optional}); return true; };`;
  return installExtension(h.api, await archive("consumer", code));
}

async function trackUser(
  h: ReturnType<typeof harness>,
  info: Partial<ExtensionInfo>,
  folder = "user-dependency",
) {
  const directory = path.join(paths.root, "plugins", folder);
  await extension(directory, info);
  h.api.store.dispatch(
    addExtension({
      name: "Catalog alias",
      path: directory,
      version: info.version ?? "2.0.0",
      infoJsonId: info.id,
      enabled: true,
      remove: false,
      endorsed: "Undecided",
      author: "Fixture",
      description: "Fixture",
    }),
  );
  return directory;
}

describe("effective extension registrations during installation", () => {
  test.each(["modtype-umm", "Dependency", "bundle-folder"])(
    "uses bundled loader identity %s with an empty catalog",
    async (id) => {
      const h = harness();
      await extension(path.join(paths.bundled, "bundle-folder"), { id: "modtype-umm" });
      const manager = scan(h);
      expect(manager.extensions).toHaveLength(1);
      expect(manager["mPendingAdds"]).toEqual([]);
      expect(h.getState().app.extensions).toEqual({});
      if (id === "bundle-folder") {
        await expect(consumer(h, id)).rejects.toBeInstanceOf(DataInvalid);
        return;
      }
      await expect(consumer(h, id, "^2.0.0")).resolves.toBeUndefined();
      expect(scan(h)["mLoadFailures"]).toEqual({});
    },
  );

  test("uses a bundle folder name when the manifest has no ID", async () => {
    const h = harness();
    await extension(path.join(paths.bundled, "bundle-folder"), {});
    scan(h);
    await expect(consumer(h, "bundle-folder", "^2.0.0")).resolves.toBeUndefined();
    expect(scan(h)["mLoadFailures"]).toEqual({});
  });

  test.each(["^1.0.0", "invalid range"])(
    "retains required version rejection for %s",
    async (version) => {
      const h = harness();
      await extension(path.join(paths.bundled, "dependency"), { id: "dependency" });
      scan(h);
      await expect(consumer(h, "dependency", version)).rejects.toBeInstanceOf(DataInvalid);
    },
  );

  test.each(["disabled", "removed", "pathless-disabled", "pathless-removed"])(
    "does not count a %s bundled registration",
    async (policy) => {
      const h = harness();
      const directory = path.join(paths.bundled, "dependency");
      await extension(directory, { id: "dependency" });
      scan(h);
      h.setState((state) => {
        state.app.extensions.dependency = {
          name: "dependency",
          version: "2.0.0",
          bundled: true,
          path: policy.startsWith("pathless") ? undefined : directory,
          enabled: !policy.endsWith("disabled"),
          remove: policy.endsWith("removed"),
        } as never;
      });
      await expect(consumer(h, "dependency")).rejects.toBeInstanceOf(DataInvalid);
    },
  );

  test.each([undefined, "*"])("checks the usable static version for range %s", async (range) => {
    const h = harness();
    const registered: IRegisteredExtension = {
      name: "static-dependency",
      namespace: "static-dependency",
      path: path.join(root, "static"),
      dynamic: false,
      initFunc: () => () => true,
    };
    scan(h, [registered]);
    if (range === undefined)
      await expect(consumer(h, registered.name, range)).resolves.toBeUndefined();
    else await expect(consumer(h, registered.name, range)).rejects.toBeInstanceOf(DataInvalid);
  });

  test.each(["^1.0.0", "^2.0.0"])(
    "prefers fresh user bytes over a stale loaded version for %s",
    async (range) => {
      const h = harness();
      const directory = await trackUser(h, { id: "dependency", version: "1.0.0" });
      const manager = scan(h);
      expect(manager.extensions[0].info?.version).toBe("1.0.0");
      await writeFile(
        path.join(directory, "info.json"),
        JSON.stringify({ id: "dependency", name: "New dependency", version: "2.0.0" }),
      );
      if (range === "^2.0.0")
        await expect(consumer(h, "dependency", range)).resolves.toBeUndefined();
      else await expect(consumer(h, "dependency", range)).rejects.toBeInstanceOf(DataInvalid);
      expect(manager.extensions[0].info?.version).toBe("1.0.0");
    },
  );

  test.each(["disabled", "removed", "missing", "invalid", "identity"])(
    "does not fall back to a stale loaded user after %s",
    async (change) => {
      const h = harness();
      const directory = await trackUser(h, { id: "dependency" });
      scan(h);
      const key = Object.keys(h.getState().app.extensions)[0];
      if (change === "disabled") h.api.store.dispatch(setExtensionEnabled(key, false));
      if (change === "removed") h.api.store.dispatch(removeExtension(key));
      if (change === "missing") await rm(directory, { recursive: true });
      if (change === "invalid") await writeFile(path.join(directory, "info.json"), "{");
      if (change === "identity")
        await writeFile(
          path.join(directory, "info.json"),
          JSON.stringify({ id: "replacement", name: "New name", version: "2.0.0" }),
        );
      await expect(consumer(h, "dependency", "^2.0.0")).rejects.toBeInstanceOf(DataInvalid);
    },
  );

  test.each(["dependency", "Bundled alias", "User alias", "Catalog alias"])(
    "applies user shadowing before resolving %s",
    async (id) => {
      const h = harness();
      await extension(path.join(paths.bundled, "dependency"), {
        id: "dependency",
        name: "Bundled alias",
        version: "2.0.0",
      });
      const manager = scan(h);
      await trackUser(h, { id: "dependency", name: "User alias", version: "1.0.0" });
      expect(manager.extensions[0].info?.bundled).toBe(true);
      if (id === "User alias") {
        await expect(consumer(h, id, "^1.0.0")).resolves.toBeUndefined();
        expect(scan(h)["mLoadFailures"]).toEqual({});
      } else await expect(consumer(h, id, "^2.0.0")).rejects.toBeInstanceOf(DataInvalid);
    },
  );

  test("uses a newly committed user update before restart", async () => {
    const h = harness();
    await trackUser(h, { id: "dependency", version: "1.0.0" }, "dependency");
    const manager = scan(h);
    await installExtension(
      h.api,
      await archive("dependency", "module.exports = () => true;", "2.0.0"),
    );
    expect(manager.extensions[0].info?.version).toBe("1.0.0");
    await expect(consumer(h, "dependency", "^2.0.0")).resolves.toBeUndefined();
    const entry = Object.values(h.getState().app.extensions).find(
      (ext) => ext.infoJsonId === "dependency" && path.basename(ext.path) === "dependency",
    );
    expect(JSON.parse(await readFile(path.join(entry!.path, "info.json"), "utf8")).version).toBe(
      "2.0.0",
    );
  });

  test.each([undefined, "^1.0.0"])(
    "keeps unavailable optional requirements optional for %s",
    async (range) => {
      const h = harness();
      scan(h);
      await expect(consumer(h, "unavailable", range, true)).resolves.toBeUndefined();
      expect(scan(h)["mLoadFailures"]).toEqual({});
    },
  );
});
