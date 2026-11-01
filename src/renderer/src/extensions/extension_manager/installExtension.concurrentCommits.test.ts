import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type * as NativeFS from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import SevenZip from "node-7z";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  root: "",
  removing: (_destination: string) => {},
  rename: (_destination: string, original: Promise<void>) => original,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NativeFS>();
  const wrapped = {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>) => {
      hooks.removing(String(args[0]));
      return actual.rm(...args);
    },
    rename: (...args: Parameters<typeof actual.rename>) =>
      hooks.rename(String(args[1]), actual.rename(...args)),
  };
  return { ...wrapped, default: wrapped };
});
vi.mock("../../util/getVortexPath", () => ({ default: () => hooks.root }));
vi.mock("../../util/errorHandling", async (importOriginal) => ({
  ...(await importOriginal<typeof ErrorHandling>()),
  withTrackedActivity: async <T>(
    _tracer: string,
    _span: string,
    _attributes: unknown,
    run: () => Promise<T>,
  ) => run(),
}));

import { appReducer } from "../../reducers/app";
import { makeApiHarness } from "../../test-utils/builders";
import type { IExtensionApi } from "../../types/IExtensionContext";
import type * as ErrorHandling from "../../util/errorHandling";
import installExtension from "./installExtension";

interface Outcome {
  error?: unknown;
}

let directory: string;
let nativeRequire: NodeJS.Require;
let pending: Promise<Outcome>[];
let nativeRenames: Promise<Outcome>[];
let completions: number[];
let sources: Map<string, Buffer>;
let releases: (() => void)[];
let archiveOwners: Set<Map<unknown, unknown>>;
let destinationOwners: Set<Map<unknown, unknown>>;
let queuedCommits: number;
let competingCommit: ReturnType<typeof signal>;
let restoreMaps: () => void;

function observe<T>(original: PromiseLike<T>): Promise<Outcome> {
  const outcome = Promise.resolve(original).then(
    () => ({}),
    (error: unknown) => ({ error }),
  );
  pending.push(outcome);
  return outcome;
}

function signal() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { reached, release };
}

function observeCommitQueues() {
  const original = Map.prototype.set;
  const plugins = path.join(directory, "profile", "plugins");
  const aliasPlugins = path.join(directory, "profile-alias", "plugins");
  const spy = vi.spyOn(Map.prototype, "set").mockImplementation(function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown,
  ) {
    const result = original.call(this, key, value);
    if (typeof key === "string") {
      if (key.startsWith(plugins + "\0") || key.startsWith(aliasPlugins + "\0")) {
        archiveOwners.add(this);
      } else if (path.dirname(key) === plugins) {
        destinationOwners.add(this);
        // Advance after the commit continuation already scheduled by this enqueue.
        pending.push(
          Promise.resolve().then(() => {
            queuedCommits++;
            if (queuedCommits === 2) competingCommit.release();
            return {};
          }),
        );
      }
    }
    return result;
  });
  restoreMaps = () => spy.mockRestore();
}

function expectEmptyOwners() {
  expect([...archiveOwners].map((owner) => owner.size)).toEqual([0]);
  expect([...destinationOwners].map((owner) => owner.size)).toEqual([0]);
}

async function drain() {
  let count = -1;
  while (count !== pending.length) {
    count = pending.length;
    await Promise.all(pending);
  }
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "extension-commits-")));
  hooks.root = path.join(directory, "profile");
  pending = [];
  nativeRenames = [];
  completions = [];
  sources = new Map();
  releases = [];
  archiveOwners = new Set();
  destinationOwners = new Set();
  queuedCommits = 0;
  competingCommit = signal();
  observeCommitQueues();
  nativeRequire = createRequire(path.join(process.cwd(), "package.json"));
  vi.stubGlobal("__non_webpack_require__", nativeRequire);
  hooks.removing = () => {};
  hooks.rename = (_destination, original) => {
    nativeRenames.push(observe(original));
    return original;
  };
});

afterEach(async () => {
  releases.forEach((release) => release());
  await drain();
  restoreMaps();
  hooks.removing = () => {};
  hooks.rename = (_destination, original) => original;
  Object.keys(nativeRequire.cache)
    .filter((filename) => filename.startsWith(directory + path.sep))
    .forEach((filename) => delete nativeRequire.cache[filename]);
  vi.unstubAllGlobals();
  try {
    expectEmptyOwners();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function makeApi() {
  const h = makeApiHarness({}, [{ path: ["app"], reducer: appReducer }]);
  h.api.getLoadedExtensions = () => [];
  return h;
}

async function archive(id: string, version: string) {
  const source = await mkdtemp(path.join(directory, "source-"));
  await writeFile(
    path.join(source, "witness.json"),
    JSON.stringify(path.join(directory, "scanned.jsonl")),
  );
  await writeFile(path.join(source, "info.json"), JSON.stringify({ id, name: id, version }));
  await writeFile(
    path.join(source, "index.js"),
    `module.exports = () => { require('node:fs').appendFileSync(require('./witness.json'), JSON.stringify(require('./info.json')) + '\\n'); return true; };`,
  );
  const filename = path.join(directory, `${id}-${version}.zip`);
  const original = new SevenZip().add(
    filename,
    [
      path.join(source, "index.js"),
      path.join(source, "info.json"),
      path.join(source, "witness.json"),
    ],
    {},
  );
  const observed = observe(original);
  await original;
  await observed;
  sources.set(filename, await readFile(filename));
  return filename;
}

function invoke(api: IExtensionApi, filename: string) {
  const slot = completions.length;
  completions.push(0);
  const original = installExtension(api, filename);
  const outcome = observe(original).then((result) => {
    completions[slot]++;
    return result;
  });
  pending.push(outcome);
  return { original, outcome };
}

function holdFirstRename(failure?: Error) {
  const entered = signal();
  const resume = signal();
  hooks.rename = async (_destination, original) => {
    const first = nativeRenames.length === 0;
    nativeRenames.push(observe(original));
    await original;
    if (first) {
      entered.release();
      await resume.reached;
      if (failure !== undefined) throw failure;
    }
  };
  return { entered: entered.reached, release: resume.release };
}

function observeReplacement(id: string) {
  const removals: string[] = [];
  hooks.removing = (destination) => {
    if (path.basename(destination) === id) removals.push(destination);
  };
  return { removals };
}

async function settled(count: number) {
  await drain();
  expectEmptyOwners();
  expect(completions).toEqual(Array.from({ length: count }, () => 1));
  expect(await Promise.all(nativeRenames)).toEqual(nativeRenames.map(() => ({})));
  for (const [filename, bytes] of sources) expect(await readFile(filename)).toEqual(bytes);
  expect(
    (await readdir(path.join(directory, "profile", "plugins"))).filter((entry) =>
      entry.endsWith(".installing"),
    ),
  ).toEqual([]);
}

async function scans() {
  return (await readFile(path.join(directory, "scanned.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

for (const schedule of ["sequential", "overlap", "alias-overlap"] as const) {
  test(`commits each archive and scans its own bytes with ${schedule}`, async () => {
    const h = makeApi();
    const firstFile = await archive("same-id", "1.0.0");
    const secondFile = await archive("same-id", "2.0.0");
    const replacement = observeReplacement("same-id");
    const gate = holdFirstRename();
    const first = invoke(h.api, firstFile);
    await gate.entered;
    if (schedule === "sequential") {
      gate.release();
      await first.outcome;
    }
    if (schedule === "alias-overlap") {
      const alias = path.join(directory, "profile-alias");
      await symlink(hooks.root, alias, "dir");
      hooks.root = alias;
    }
    const second = invoke(h.api, secondFile);
    await competingCommit.reached;
    expect(queuedCommits).toBe(2);
    expect(Array.from(destinationOwners, (owner) => Array.from(owner.keys()))).toEqual([
      [path.join(directory, "profile", "plugins", "same-id")],
    ]);
    const overlapped = schedule !== "sequential" && replacement.removals.length > 1;
    // An unsafe implementation can finish the second commit while the first is paused.
    if (overlapped) await second.outcome;
    gate.release();
    const results = await Promise.all([first.outcome, second.outcome]);
    await settled(2);
    const entries = Object.values(h.getState().app.extensions);
    const manifest = JSON.parse(
      await readFile(path.join(directory, "profile", "plugins", "same-id", "info.json"), "utf8"),
    );
    expect.soft(results).toEqual([{}, {}]);
    expect.soft(entries).toHaveLength(1);
    expect.soft(manifest.version).toBe("2.0.0");
    expect
      .soft(entries[0].version, "registered version must match the committed manifest")
      .toBe(manifest.version);
    expect.soft((await scans()).map((info) => info.version)).toEqual(["1.0.0", "2.0.0"]);
    expect.soft(overlapped, "replacement must wait for the prior commit").toBe(false);
    expect(nativeRenames).toHaveLength(2);
  });
}

test("releases a failed predecessor and accepts another install of the same archive", async () => {
  const h = makeApi();
  const firstFile = await archive("same-id", "1.0.0");
  const secondFile = await archive("same-id", "2.0.0");
  const failure = new Error("first rename continuation failed");
  const gate = holdFirstRename(failure);
  observeReplacement("same-id");
  const first = invoke(h.api, firstFile);
  await gate.entered;
  const second = invoke(h.api, secondFile);
  await competingCommit.reached;
  expect(queuedCommits).toBe(2);
  gate.release();
  const results = await Promise.all([first.outcome, second.outcome]);
  const repeated = await invoke(h.api, secondFile).outcome;
  await settled(3);
  expect(results).toEqual([{ error: failure }, {}]);
  expect(repeated).toEqual({});
  expect(Object.values(h.getState().app.extensions)).toMatchObject([{ version: "2.0.0" }]);
  expect((await scans()).map((info) => info.version)).toEqual(["2.0.0", "2.0.0"]);
  expect(nativeRenames).toHaveLength(3);
});

test("allows a distinct destination to commit while another is paused", async () => {
  const h = makeApi();
  const firstFile = await archive("first-id", "1.0.0");
  const secondFile = await archive("second-id", "2.0.0");
  const gate = holdFirstRename();
  const first = invoke(h.api, firstFile);
  await gate.entered;
  const second = invoke(h.api, secondFile);
  const secondResult = await second.outcome;
  const completedBeforeRelease = completions.slice();
  gate.release();
  const firstResult = await first.outcome;
  await settled(2);
  expect([firstResult, secondResult]).toEqual([{}, {}]);
  expect(completedBeforeRelease).toEqual([0, 1]);
  expect(
    Object.values(h.getState().app.extensions)
      .map((entry) => entry.infoJsonId)
      .toSorted(),
  ).toEqual(["first-id", "second-id"]);
  expect((await scans()).map((info) => info.id)).toEqual(["second-id", "first-id"]);
});

test("deduplicates the exact archive and releases it after settlement", async () => {
  const h = makeApi();
  const filename = await archive("same-id", "1.0.0");
  const gate = holdFirstRename();
  const first = invoke(h.api, filename);
  await gate.entered;
  const second = invoke(h.api, filename);
  const shared = first.original === second.original;
  gate.release();
  const results = await Promise.all([first.outcome, second.outcome]);
  const repeated = await invoke(h.api, filename).outcome;
  await settled(3);
  expect(results).toEqual([{}, {}]);
  expect(repeated).toEqual({});
  expect(shared).toBe(true);
  expect(nativeRenames).toHaveLength(2);
  expect((await scans()).map((info) => info.version)).toEqual(["1.0.0", "1.0.0"]);
});
