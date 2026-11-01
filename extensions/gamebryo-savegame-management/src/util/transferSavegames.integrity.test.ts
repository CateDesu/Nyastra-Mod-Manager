import * as nodeFs from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

interface TransferFixture {
  documents: string;
  work: PromiseLike<unknown>[];
  requests: Array<{
    kind: string;
    source: string;
    destination?: string;
    flags?: number;
    error?: NodeJS.ErrnoException;
  }>;
  active: Set<object>;
  settled: number;
  beforeTransfer?: (source: string, destination: string) => Promise<void>;
  directoryReady?: () => void;
}

const fixture = vi.hoisted<TransferFixture>(() => ({
  documents: "",
  work: [],
  requests: [],
  active: new Set<object>(),
  settled: 0,
  beforeTransfer: undefined,
  directoryReady: undefined,
}));

beforeEach(() => {
  if (typeof window === "undefined") {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
  }
  const native = {
    copyFile: nodeFs.promises.copyFile.bind(nodeFs.promises),
    lstat: nodeFs.promises.lstat.bind(nodeFs.promises),
    unlink: nodeFs.promises.unlink.bind(nodeFs.promises),
    link: nodeFs.promises.link.bind(nodeFs.promises),
  };
  const track = <T>(record: TransferFixture["requests"][number], operation: () => Promise<T>) => {
    fixture.requests.push(record);
    fixture.active.add(record);
    const work = operation()
      .catch((error: NodeJS.ErrnoException) => {
        record.error = error;
        throw error;
      })
      .finally(() => {
        fixture.active.delete(record);
        fixture.settled++;
      });
    fixture.work.push(work);
    work.catch(() => undefined);
    return work;
  };
  vi.spyOn(nodeFs.promises, "copyFile").mockImplementation((source, destination, flags) =>
    track(
      { kind: "copy", source: source.toString(), destination: destination.toString(), flags },
      async () => {
        await fixture.beforeTransfer?.(source.toString(), destination.toString());
        return native.copyFile(source, destination, flags);
      },
    ),
  );
  vi.spyOn(nodeFs.promises, "link").mockImplementation((source, destination) =>
    track(
      { kind: "link", source: source.toString(), destination: destination.toString() },
      async () => {
        if (
          path.dirname(destination.toString()) !== path.dirname(path.dirname(source.toString()))
        ) {
          await fixture.beforeTransfer?.(source.toString(), destination.toString());
        }
        return native.link(source, destination);
      },
    ),
  );
  function lstat(
    source: nodeFs.PathLike,
    options?: nodeFs.StatOptions & { bigint?: false },
  ): Promise<nodeFs.Stats>;
  function lstat(
    source: nodeFs.PathLike,
    options: nodeFs.StatOptions & { bigint: true },
  ): Promise<nodeFs.BigIntStats>;
  function lstat(
    source: nodeFs.PathLike,
    options?: nodeFs.StatOptions,
  ): Promise<nodeFs.Stats | nodeFs.BigIntStats>;
  function lstat(source: nodeFs.PathLike, options?: nodeFs.StatOptions) {
    return track({ kind: "stat", source: source.toString() }, () => native.lstat(source, options));
  }
  vi.spyOn(nodeFs.promises, "lstat").mockImplementation(lstat);
  vi.spyOn(nodeFs.promises, "unlink").mockImplementation((source) =>
    track({ kind: "unlink", source: source.toString() }, () => native.unlink(source)),
  );
});

vi.mock("../views/SavegameList", () => ({ default: () => null }));
vi.mock("@nexusmods/vortex-api", async () => {
  const nodeModule = await import("node:module");
  const nodePath = await import("node:path");
  const rendererRequire = nodeModule.createRequire(
    nodePath.resolve(import.meta.dirname, "../../../../src/renderer/package.json"),
  );
  const temporal = await vi.importActual<{ install: () => void }>(
    rendererRequire.resolve("temporal-polyfill/shim"),
  );
  temporal.install();
  const native = rendererRequire("fs-extra");
  const { default: PromiseBB } = await import("bluebird");
  const filesystem = {
    copyAsync: (source: string, destination: string, options?: any) =>
      PromiseBB.resolve(native.copy(source, destination, options)),
    renameAsync: (source: string, destination: string) =>
      PromiseBB.resolve(native.rename(source, destination)),
    moveAsync: (source: string, destination: string, options?: any) =>
      PromiseBB.resolve(native.move(source, destination, options)),
    ensureDirAsync: (directory: string) => PromiseBB.resolve(native.ensureDir(directory)),
  };
  const { makeOverlayableDictionary } = await vi.importActual<any>(
    "../../../../src/renderer/src/util/util",
  );
  const store = await vi.importActual<any>("../../../../src/renderer/src/util/storeHelper");
  const { default: Debouncer } = await vi.importActual<any>(
    "../../../../src/renderer/src/util/Debouncer",
  );
  const errors = await vi.importActual<any>("../../../../src/shared/src/api/errors");
  const retain =
    <Args extends unknown[], T>(operation: (...args: Args) => PromiseLike<T>) =>
    (...args: Args) => {
      const work = PromiseBB.resolve(operation(...args));
      fixture.work.push(work);
      work.catch(() => undefined);
      return work;
    };
  const wrapped = {
    ...filesystem,
    copyAsync: retain(filesystem.copyAsync),
    renameAsync: retain(filesystem.renameAsync),
    moveAsync: retain(filesystem.moveAsync),
  };
  wrapped.ensureDirAsync = (directory: string) => {
    const operation = filesystem.ensureDirAsync(directory).then(() => fixture.directoryReady?.());
    fixture.work.push(operation);
    operation.catch(() => undefined);
    return operation;
  };
  return {
    fs: wrapped,
    actions: {},
    log: vi.fn<(...args: unknown[]) => void>(),
    selectors: {
      discoveryByGame: (state: any, game: string) => state.settings.gameMode.discovered[game],
      activeProfile: (state: any) =>
        state.persistent.profiles[state.settings.profiles.activeProfileId],
      activeGameId: (state: any) =>
        state.persistent.profiles[state.settings.profiles.activeProfileId]?.gameId,
    },
    util: {
      ...store,
      makeOverlayableDictionary,
      Debouncer,
      getVortexPath: () => fixture.documents,
      UserCanceled: errors.UserCanceled,
      ProcessCanceled: errors.ProcessCanceled,
    },
  };
});

import init from "../index";

const roots: string[] = [];
const permissions: Array<{ file: string; mode: number }> = [];

async function drain() {
  let count = -1;
  while (count !== fixture.work.length) {
    count = fixture.work.length;
    await Promise.allSettled(fixture.work);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

afterEach(async () => {
  await drain();
  for (const entry of permissions.splice(0)) await chmod(entry.file, entry.mode);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  fixture.work = [];
  fixture.requests = [];
  fixture.active.clear();
  fixture.settled = 0;
  fixture.beforeTransfer = undefined;
  fixture.directoryReady = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "nyastra-save-integrity-"));
  roots.push(root);
  fixture.documents = path.join(root, "documents");
  const game = path.join(fixture.documents, "My Games", "Skyrim Special Edition");
  const directories = {
    source: path.join(game, "Saves", "source"),
    target: path.join(game, "Saves", "target"),
    other: path.join(game, "Saves", "other"),
  };
  await Promise.all(
    Object.values(directories).map((directory) => mkdir(directory, { recursive: true })),
  );
  const profiles = Object.fromEntries(
    Object.keys(directories).map((id) => [
      id,
      { id, gameId: "skyrimse", features: { local_saves: true } },
    ]),
  );
  const state = {
    settings: {
      profiles: { activeProfileId: "target" },
      gameMode: { discovered: { skyrimse: { store: "steam" } } },
    },
    persistent: { profiles },
  };
  let props: () => {
    onTransferSavegames: (
      profile: string,
      files: string[],
      keep: boolean,
    ) => PromiseLike<{ errors: string[]; allowReport: boolean }>;
  };
  const context = {
    api: {
      store: { getState: () => state, dispatch: vi.fn<(...args: unknown[]) => void>() },
      getState: () => state,
      translate: (text: string) => text,
      showDialog: vi.fn<(...args: unknown[]) => void>(),
      showErrorNotification: vi.fn<(...args: unknown[]) => void>(),
    },
    registerMainPage: (_icon: unknown, _label: unknown, _component: unknown, options: any) => {
      props = options.props;
    },
    registerReducer: vi.fn<(...args: unknown[]) => void>(),
    registerAction: vi.fn<(...args: unknown[]) => void>(),
    registerProfileFeature: vi.fn<(...args: unknown[]) => void>(),
    once: vi.fn<(...args: unknown[]) => void>(),
  };
  expect(init(context as unknown as Parameters<typeof init>[0])).toBe(true);
  const callback = vi.fn<ReturnType<typeof props>["onTransferSavegames"]>(
    props().onTransferSavegames,
  );
  const invoke = (profile: string, files: string[], keep: boolean) => {
    const operation = callback(profile, files, keep);
    fixture.work.push(operation);
    return operation;
  };
  const finish = async (calls = 1) => {
    await drain();
    expect(callback).toHaveBeenCalledTimes(calls);
    expect(context.api.showDialog).not.toHaveBeenCalled();
    expect(context.api.showErrorNotification).not.toHaveBeenCalled();
    expect(fixture.active.size).toBe(0);
    expect(fixture.settled).toBe(fixture.requests.length);
  };
  return { ...directories, invoke, finish };
}

const files = ["autosave1.ess", "autosave1.skse"];
async function seed(directory: string, prefix: string, names = files) {
  for (const file of names) await writeFile(path.join(directory, file), prefix + file);
}
async function contents(directory: string, file: string) {
  return readFile(path.join(directory, file), "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

it.each([true, false])(
  "transfers saves and optional companions with keepSource=%s",
  async (keep) => {
    const { source, target, invoke, finish } = await setup();
    await seed(source, "source ");
    const result = await invoke("source", [files[0]], keep);
    await finish();
    expect(result).toEqual({ errors: [], allowReport: true });
    for (const file of files) {
      expect(await contents(target, file)).toBe("source " + file);
      expect(await contents(source, file)).toBe(keep ? "source " + file : null);
    }
  },
);

it.each([true, false])("accepts a missing companion with keepSource=%s", async (keep) => {
  const { source, target, invoke, finish } = await setup();
  await seed(source, "source ", [files[0]]);
  const result = await invoke("source", [files[0]], keep);
  await finish();
  expect(result.errors).toEqual([]);
  expect(await contents(target, files[0])).toBe("source " + files[0]);
  expect(await contents(target, files[1])).toBeNull();
  expect(await contents(source, files[0])).toBe(keep ? "source " + files[0] : null);
});

it.each(
  [true, false].flatMap((keep) =>
    ["main", "companion", "batch", "symlink"].map((collision) => ({ keep, collision })),
  ),
)(
  "preflights the whole batch for $collision with keepSource=$keep",
  async ({ keep, collision }) => {
    const { source, target, invoke, finish } = await setup();
    const names = collision === "batch" ? [...files, "second.ess", "second.skse"] : files;
    await seed(source, "source ", names);
    const conflict =
      collision === "companion" ? files[1] : collision === "batch" ? "second.skse" : files[0];
    if (collision === "symlink") await symlink("absent-target", path.join(target, conflict));
    else await seed(target, "destination ", [conflict]);
    const result = await invoke(
      "source",
      collision === "batch" ? [files[0], "second.ess"] : [files[0]],
      keep,
    );
    await finish();
    expect.soft(result.errors).toHaveLength(1);
    expect.soft(result.errors.join("\n")).toContain(conflict);
    for (const file of names) {
      expect.soft(await contents(source, file)).toBe("source " + file);
      expect
        .soft(await contents(target, file))
        .toBe(file === conflict && collision !== "symlink" ? "destination " + file : null);
    }
    expect(
      fixture.requests.filter((request) => request.kind === "copy" || request.kind === "unlink"),
    ).toEqual([]);
    await rm(path.join(target, conflict));
    const retry = await invoke(
      "source",
      collision === "batch" ? [files[0], "second.ess"] : [files[0]],
      keep,
    );
    await finish(2);
    expect(retry.errors).toEqual([]);
    for (const file of names) expect(await contents(target, file)).toBe("source " + file);
  },
);

it.each([true, false].flatMap((keep) => files.map((collision) => ({ keep, collision }))))(
  "rejects a collision admitted after preflight at $collision with keepSource=$keep",
  async ({ keep, collision }) => {
    const { source, target, invoke, finish } = await setup();
    await seed(source, "source ");
    fixture.beforeTransfer = async (_source, destination) => {
      if (path.basename(destination) === collision)
        await writeFile(destination, "late " + collision);
    };
    const result = await invoke("source", [files[0]], keep);
    await finish();
    expect.soft(result.errors).toHaveLength(1);
    expect.soft(result.errors.join("\n")).toContain(collision);
    expect.soft(fixture.requests.some((request) => request.error?.code === "EEXIST")).toBe(true);
    for (const file of files) {
      expect.soft(await contents(source, file)).toBe("source " + file);
      expect
        .soft(await contents(target, file))
        .toBe(file === collision ? "late " + file : "source " + file);
    }
  },
);

it.each(["destination", "source", "unlink"])(
  "returns native %s permission failures",
  async (denied) => {
    const { source, target, invoke, finish } = await setup();
    await seed(source, "source ");
    const directory = denied === "destination" ? target : source;
    await chmod(directory, denied === "source" ? 0o000 : 0o555);
    permissions.push({ file: directory, mode: 0o755 });
    const result = await invoke("source", [files[0]], false);
    await finish();
    expect(result.errors.length).toBeGreaterThan(0);
    for (const entry of permissions.splice(0)) await chmod(entry.file, entry.mode);
    for (const file of files) {
      expect.soft(await contents(source, file)).toBe("source " + file);
      expect(await contents(target, file)).toBeNull();
    }
  },
);

it("retains every move source when a later companion cannot be transferred", async () => {
  const { source, target, invoke, finish } = await setup();
  await seed(source, "source ");
  fixture.beforeTransfer = async (file) => {
    if (path.basename(file) === files[1]) {
      await symlink("absent-target", path.join(target, files[1]));
    }
  };
  const result = await invoke("source", [files[0]], false);
  await finish();
  expect(result.errors).toHaveLength(1);
  expect(fixture.requests.some((request) => request.error?.code === "EEXIST")).toBe(true);
  for (const entry of permissions.splice(0)) await chmod(entry.file, entry.mode);
  for (const file of files) expect(await contents(source, file)).toBe("source " + file);
  expect(await contents(target, files[0])).toBe("source " + files[0]);
  expect(await contents(target, files[1])).toBeNull();
});

it("reports a vanished destination parent while preserving existing move sources", async () => {
  const { source, target, invoke, finish } = await setup();
  await seed(source, "source ");
  fixture.beforeTransfer = async () => {
    await rm(target, { recursive: true, force: true });
  };
  const result = await invoke("source", [files[0]], false);
  await finish();
  expect(result.errors).toHaveLength(2);
  expect(
    fixture.requests.filter(
      (request) => request.error?.code === "ENOENT" && request.kind === "link",
    ),
  ).toHaveLength(2);
  for (const file of files) expect(await contents(source, file)).toBe("source " + file);
});

it("tolerates an optional companion removed after preflight", async () => {
  const { source, target, invoke, finish } = await setup();
  await seed(source, "source ");
  const rename = nodeFs.promises.rename.bind(nodeFs.promises);
  vi.spyOn(nodeFs.promises, "rename").mockImplementation(async (from, to) => {
    if (from === path.join(source, files[1])) await rm(from);
    return rename(from, to);
  });
  const result = await invoke("source", [files[0]], false);
  await finish();
  expect(result.errors).toEqual([]);
  expect(await contents(target, files[0])).toBe("source " + files[0]);
  expect(await contents(target, files[1])).toBeNull();
  for (const file of files) expect(await contents(source, file)).toBeNull();
});

it("serializes locally overlapping public transfers to the same destination", async () => {
  const { source, other, target, invoke, finish } = await setup();
  await seed(source, "first ");
  await seed(other, "second ");
  let release!: () => void;
  let entered!: () => void;
  let admitted!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const secondAdmission = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  fixture.beforeTransfer = async (file) => {
    if (file.startsWith(source) && path.basename(file) === files[0]) {
      entered();
      await hold;
    }
  };
  const first = invoke("source", [files[0]], false);
  await started;
  fixture.directoryReady = admitted;
  const second = invoke("other", [files[0]], false);
  let competingWork: typeof fixture.requests;
  try {
    await secondAdmission;
    await new Promise<void>((resolve) => setImmediate(resolve));
    competingWork = fixture.requests.filter((request) => request.source.startsWith(other));
  } finally {
    release();
  }
  const results = await Promise.all([first, second]);
  await finish(2);
  expect.soft(competingWork).toEqual([]);
  expect.soft(results[0].errors).toEqual([]);
  expect.soft(results[1].errors).toHaveLength(2);
  for (const file of files) {
    expect.soft(await contents(source, file)).toBeNull();
    expect.soft(await contents(other, file)).toBe("second " + file);
    expect.soft(await contents(target, file)).toBe("first " + file);
  }
});

it.each(["before claim", "after claim"])("preserves atomic replacement %s", async (timing) => {
  const { source, target, invoke, finish } = await setup();
  await seed(source, "earlier ");
  const replace = async () => {
    const next = path.join(source, "next.tmp");
    await writeFile(next, "newer save");
    await nodeFs.promises.rename(next, path.join(source, files[0]));
  };
  if (timing === "before claim") {
    const rename = nodeFs.promises.rename.bind(nodeFs.promises);
    vi.spyOn(nodeFs.promises, "rename").mockImplementation(async (from, to) => {
      if (from === path.join(source, files[0])) {
        const next = path.join(source, "next.tmp");
        await writeFile(next, "newer save");
        await rename(next, from);
      }
      return rename(from, to);
    });
  } else {
    fixture.beforeTransfer = async (file) => {
      if (path.basename(file) === files[0]) await replace();
    };
  }
  expect((await invoke("source", [files[0]], false)).errors).toEqual([]);
  await finish();
  expect(await contents(target, files[0])).toBe(
    timing === "before claim" ? "newer save" : "earlier " + files[0],
  );
  expect(await contents(source, files[0])).toBe(timing === "before claim" ? null : "newer save");
});

it("keeps an open writer attached to a moved save", async () => {
  const { source, target, invoke, finish } = await setup();
  await seed(source, "earlier ");
  const writer = await nodeFs.promises.open(path.join(source, files[0]), "r+");
  const unlink = vi.mocked(nodeFs.promises.unlink).getMockImplementation()!;
  vi.spyOn(nodeFs.promises, "unlink").mockImplementation(async (file) => {
    if (path.basename(file.toString()) === files[0]) {
      await writer.truncate(0);
      await writer.writeFile("writer's newer bytes");
    }
    return unlink(file);
  });
  try {
    expect((await invoke("source", [files[0]], false)).errors).toEqual([]);
    await finish();
    expect(await contents(target, files[0])).toBe("writer's newer bytes");
    expect(await contents(source, files[0])).toBeNull();
  } finally {
    await writer.close();
  }
});

it.each([false, true])(
  "retains all move sources after cross-device copy with failure=%s",
  async (fail) => {
    const { source, target, invoke, finish } = await setup();
    await seed(source, "earlier ");
    const link = vi.mocked(nodeFs.promises.link).getMockImplementation()!;
    vi.spyOn(nodeFs.promises, "link").mockImplementation((from, to) =>
      path.dirname(to.toString()) === target
        ? Promise.reject(Object.assign(new Error("cross-device link"), { code: "EXDEV" }))
        : link(from, to),
    );
    const copy = vi.mocked(nodeFs.promises.copyFile).getMockImplementation()!;
    const writer = await nodeFs.promises.open(path.join(source, files[0]), "r+");
    vi.spyOn(nodeFs.promises, "copyFile").mockImplementation(async (from, to, flags) => {
      if (fail && path.basename(from.toString()) === files[1]) {
        throw Object.assign(new Error("copy denied"), { code: "EACCES" });
      }
      await copy(from, to, flags);
      if (path.basename(from.toString()) === files[0]) {
        await writer.truncate(0);
        await writer.writeFile("open writer after copy");
      }
    });
    try {
      const result = await invoke("source", [files[0]], false);
      await finish();
      expect(result.errors.join("\n")).toContain("source retained");
      if (fail) expect(result.errors.join("\n")).toContain("copy denied");
      expect(await contents(target, files[0])).toBe("earlier " + files[0]);
      expect(await contents(source, files[0])).toBe("open writer after copy");
      expect(await contents(source, files[1])).toBe("earlier " + files[1]);
    } finally {
      await writer.close();
    }
  },
);

it("preserves private recovery bytes without overwriting a recreated source after batch failure", async () => {
  const { source, target, invoke, finish } = await setup();
  await seed(source, "earlier ");
  fixture.beforeTransfer = async (file, destination) => {
    if (path.basename(file) === files[1]) {
      await writeFile(path.join(source, files[0]), "recreated save");
      await writeFile(destination, "late collision");
    }
  };
  const result = await invoke("source", [files[0]], false);
  await finish();
  expect(result.errors.join("\n")).toContain("Source preserved at");
  expect(await contents(source, files[0])).toBe("recreated save");
  expect(await contents(source, files[1])).toBe("earlier " + files[1]);
  const recovery = (await nodeFs.promises.readdir(source)).find((name) =>
    name.startsWith(".nyastra-save-move-"),
  );
  expect(recovery).toBeDefined();
  expect(await contents(path.join(source, recovery!), files[0])).toBe("earlier " + files[0]);
});

it.skipIf(!nodeFs.existsSync("/dev/shm"))(
  "preserves sources on a native cross-volume move",
  async () => {
    const { source, target, invoke, finish } = await setup();
    const secondVolume = await mkdtemp("/dev/shm/nyastra-save-transfer-");
    roots.push(secondVolume);
    if ((await nodeFs.promises.stat(source)).dev === (await nodeFs.promises.stat(secondVolume)).dev)
      return;
    await rm(target, { recursive: true });
    await symlink(secondVolume, target);
    await seed(source, "native ");
    const result = await invoke("source", [files[0]], false);
    await finish();
    expect(result.errors.join("\n")).toContain("source retained");
    for (const file of files) {
      expect(await contents(source, file)).toBe("native " + file);
      expect(await contents(target, file)).toBe("native " + file);
    }
  },
);

it("restores a dangling source link without following or deleting its target", async () => {
  const { source, target, invoke, finish } = await setup();
  await symlink("absent-target", path.join(source, files[0]));
  const result = await invoke("source", [files[0]], false);
  await finish();
  expect(result.errors.join("\n")).toContain("non-regular");
  expect(await nodeFs.promises.readlink(path.join(source, files[0]))).toBe("absent-target");
  expect(await contents(target, files[0])).toBeNull();
});

it.each([true, false])(
  "preserves a source replacement after destination publication with keepSource=%s",
  async (keep) => {
    const { source, target, invoke, finish } = await setup();
    await seed(source, "earlier ");
    const publish = async () => {
      const next = path.join(source, "next.tmp");
      await writeFile(next, "newer save");
      await nodeFs.promises.rename(next, path.join(source, files[0]));
    };
    if (keep) {
      const copy = vi.mocked(nodeFs.promises.copyFile).getMockImplementation()!;
      vi.spyOn(nodeFs.promises, "copyFile").mockImplementation(async (from, to, flags) => {
        await copy(from, to, flags);
        if (to === path.join(target, files[0])) await publish();
      });
    } else {
      const link = vi.mocked(nodeFs.promises.link).getMockImplementation()!;
      vi.spyOn(nodeFs.promises, "link").mockImplementation(async (from, to) => {
        await link(from, to);
        if (to === path.join(target, files[0])) await publish();
      });
    }
    expect((await invoke("source", [files[0]], keep)).errors).toEqual([]);
    await finish();
    expect(await contents(target, files[0])).toBe("earlier " + files[0]);
    expect(await contents(source, files[0])).toBe("newer save");
  },
);
