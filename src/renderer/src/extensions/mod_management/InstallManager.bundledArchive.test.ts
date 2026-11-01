import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import Zip from "node-7z";
import { afterEach, expect, vi } from "vitest";

import {
  makeMod,
  makeProfile,
  makeRule,
  makeDownload,
  makeGameStored,
  makeInstallState,
  makeSession,
  makeModInstallInfo,
} from "../../test-utils/builders";
import { test, type IInstallManagerFixtures } from "../../test-utils/installManagerTest";
import { generateCollectionSessionId, modRuleId } from "../../util/collectionInstallSession";
import { ProcessCanceled, UserCanceled } from "../../util/CustomErrors";
import * as nativeFs from "../../util/fs";
import { setDownloadModInfo } from "../download_management/actions/state";
import type { IDependency } from "./types/IDependency";
for (const scenario of [
  "unrelated first",
  "selected first",
  "absolute row",
  "domain row",
  "replaced during install",
] as const)
  test(`bundled archive cache selects storage owner with ${scenario}`, async ({
    makeInstallManager,
  }) => {
    await import("./index.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-bundle-owner-"));
    const staging = path.join(root, "staging"),
      downloads = path.join(root, "downloads");
    const p = makeProfile({ id: "owner" }),
      sourceId = "bundle-collection";
    const rule = makeRule({
      type: "requires",
      reference: { tag: "bundled-member-identity", gameId: "skyrimse" },
      extra: { localPath: "bundled/bundle.7z" },
    });
    const source = makeMod({
      id: sourceId,
      type: "collection",
      installationPath: sourceId,
      rules: [rule],
    });
    const sizes: Record<string, number> = {};
    for (const game of ["skyrimse", "fallout4"]) {
      const dir = path.join(downloads, game);
      fs.mkdirSync(dir, { recursive: true });
      const payload = path.join(root, game, "payload.txt");
      fs.mkdirSync(path.dirname(payload));
      fs.writeFileSync(
        payload,
        game === "skyrimse" ? "intended Skyrim payload" : "unrelated Fallout payload",
      );
      await new Zip().add(path.join(dir, "bundle.7z"), [payload]);
      sizes[game] = fs.statSync(path.join(dir, "bundle.7z")).size;
    }
    fs.mkdirSync(path.join(staging, sourceId, "bundled"), { recursive: true });
    fs.copyFileSync(
      path.join(downloads, "skyrimse", "bundle.7z"),
      path.join(staging, sourceId, rule.extra.localPath),
    );
    const own = makeDownload({
      id: "selected",
      game: [scenario === "domain row" ? "skyrimspecialedition" : "skyrimse"],
      state: "finished",
      localPath:
        scenario === "absolute row" ? path.join(downloads, "skyrimse", "bundle.7z") : "bundle.7z",
      size: sizes.skyrimse,
    });
    const unrelated = makeDownload({
      id: "unrelated",
      game: ["fallout4"],
      state: "finished",
      localPath: "bundle.7z",
      size: sizes.fallout4,
    });
    const h = makeInstallManager({
      knownGames: [makeGameStored(), makeGameStored({ id: "fallout4" })],
      profiles: { owner: p },
      activeProfileId: p.id,
      mods: { skyrimse: { [sourceId]: source } },
      downloads:
        scenario === "selected first" ? { selected: own, unrelated } : { unrelated, selected: own },
      session: makeInstallState({
        activeSession: makeSession({
          sessionId: generateCollectionSessionId(sourceId, p.id),
          collectionId: sourceId,
          profileId: p.id,
          gameId: "skyrimse",
          totalRequired: 1,
          downloadedCount: 1,
          mods: {
            [modRuleId(rule)]: makeModInstallInfo({
              rule,
              type: "requires",
              status: "downloaded",
              phase: 0,
            }),
          },
        }),
      }),
    });
    h.setState((s) => {
      s.settings.downloads.path = downloads;
      s.settings.mods.installPath.skyrimse = staging;
      s.settings.downloads.collectionsInstallWhileDownloading = true;
    });
    h.manager["mGetInstallPath"] = () => staging;
    h.api.withPrePost =
      (_event, callback) =>
      (...args) =>
        callback(...args);
    h.api.lookupModReference = () => Bluebird.resolve([]);
    h.api.lookupModMeta = () => Bluebird.resolve([]);
    h.manager.addInstaller(
      "synthetic-copy",
      0,
      async () => ({ supported: true, requiredFiles: [] }),
      async () => ({
        instructions: [{ type: "copy", source: "payload.txt", destination: "payload.txt" }],
      }),
    );
    const installed = vi.fn();
    h.api.events.on("did-install-mod", installed);
    if (scenario === "replaced during install") {
      h.api.emitAndAwait = (async (event) => {
        if (event === "will-install-mod")
          h.api.store.dispatch(setDownloadModInfo("selected", "syntheticReplacement", true));
        return [];
      }) as typeof h.api.emitAndAwait;
    }
    let operation: PromiseLike<unknown> | undefined;
    try {
      operation = h.manager.installDependencies(h.api, p, "skyrimse", sourceId, true, false);
      if (scenario === "replaced during install") {
        await vi.waitFor(() =>
          expect(h.getState().session.collections.activeSession.mods[modRuleId(rule)].status).toBe(
            "failed",
          ),
        );
        expect(installed).not.toHaveBeenCalled();
        expect(h.getState().persistent.downloads.files.selected.modInfo.syntheticReplacement).toBe(
          true,
        );
        expect(h.manager["mDependencyRetryCount"].size).toBe(0);
        expect(fs.existsSync(path.join(staging, "bundle", "payload.txt"))).toBe(false);
        expect(h.getState().persistent.mods.skyrimse.bundle).toBeUndefined();
        return;
      }
      await vi.waitFor(() => expect(installed).toHaveBeenCalledTimes(1), { timeout: 10000 });
      const [game, id, modId] = installed.mock.calls[0];
      const bytes = fs.readFileSync(path.join(staging, modId, "payload.txt"), "utf8");
      expect(game).toBe("skyrimse");
      expect(id).toBe("selected");
      expect(bytes).toBe("intended Skyrim payload");
    } finally {
      await h.emitAndAwait("cancel-dependency-install", sourceId);
      await operation;
      await Promise.all(h.manager["mRunningInstalls"].values());
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

const cacheRoots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of cacheRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeCacheFixture(
  makeInstallManager: IInstallManagerFixtures["makeInstallManager"],
  localPath = "bundle.7z",
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nyastra-bundle-cache-"));
  cacheRoots.push(root);
  const downloads = path.join(root, "downloads");
  const target = path.join(
    downloads,
    "skyrimse",
    path.basename(localPath) + (path.extname(localPath) === ".7z" ? "" : ".7z"),
  );
  const staging = path.join(root, "staging");
  const source = makeMod({ id: "collection", installationPath: "collection" });
  const dep: IDependency = {
    download: undefined,
    reference: { tag: "synthetic-bundle" },
    extra: { localPath },
    lookupResults: [],
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const bundled = path.join(staging, source.installationPath, localPath);
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.writeFileSync(bundled, "synthetic bundled bytes");
  fs.writeFileSync(target, "cached bundled bytes");
  const h = makeInstallManager({
    knownGames: [makeGameStored()],
    downloads: {
      selected: makeDownload({
        id: "selected",
        game: ["skyrimse"],
        localPath: path.basename(target),
        state: "finished",
        size: 20,
      }),
      unrelated: makeDownload({
        id: "unrelated",
        game: ["fallout4"],
        localPath: path.basename(target),
        state: "finished",
        size: 20,
      }),
    },
  });
  h.setState((s) => {
    s.settings.downloads.path = downloads;
  });
  const run = (isCurrent?: () => boolean) =>
    h.manager["importBundledDependencyAsync"](h.api, source, "skyrimse", staging, dep, isCurrent);
  return { root, downloads, target, staging, source, dep, bundled, h, run };
}

for (const scenario of ["ordinary", "absolute row", "domain row", "legacy suffix"] as const) {
  test(`cached bundles reuse their exact storage owner: ${scenario}`, async ({
    makeInstallManager,
  }) => {
    const f = makeCacheFixture(
      makeInstallManager,
      scenario === "legacy suffix" ? "bundled/member" : "bundle.7z",
    );
    if (scenario !== "ordinary" && scenario !== "legacy suffix")
      f.h.setState((s) => {
        if (scenario === "absolute row") s.persistent.downloads.files.selected.localPath = f.target;
        else s.persistent.downloads.files.selected.game = ["skyrimspecialedition"];
      });
    const imported = vi.fn();
    f.h.api.events.on("import-downloads", imported);
    expect(await f.run()).toBe("selected");
    expect(imported).not.toHaveBeenCalled();
    expect(f.h.manager["mBundledArchives"].get(f.dep)).toEqual({
      downloadId: "selected",
      download: f.h.getState().persistent.downloads.files.selected,
      archivePath: f.target,
    });
    expect(f.h.getState().persistent.downloads.files.unrelated.modInfo).toEqual({});
    expect(fs.readFileSync(f.target, "utf8")).toBe("cached bundled bytes");
  });
}

for (const scenario of [
  "untracked",
  "unfinished",
  "missing",
  "empty import",
  "canceled import",
] as const) {
  test(`bundled import handles ${scenario} without claiming a basename match`, async ({
    makeInstallManager,
  }) => {
    const f = makeCacheFixture(makeInstallManager);
    f.h.setState((s) => {
      if (scenario === "unfinished") s.persistent.downloads.files.selected.state = "paused";
      else delete s.persistent.downloads.files.selected;
    });
    if (scenario === "missing") fs.unlinkSync(f.target);
    let current = true;
    const imported = vi.fn(
      (files: string[], callback: (ids: string[]) => void, silent: boolean) => {
        expect(files).toEqual([f.bundled]);
        expect(silent).toBe(true);
        if (scenario === "empty import") return callback([]);
        const importedPath = path.join(path.dirname(f.target), "imported.7z");
        fs.copyFileSync(f.bundled, importedPath);
        f.h.setState((s) => {
          s.persistent.downloads.files.imported = makeDownload({
            id: "imported",
            game: ["skyrimse"],
            localPath: "imported.7z",
            state: "finished",
            size: fs.statSync(importedPath).size,
          });
        });
        if (scenario === "canceled import") current = false;
        callback(["imported"]);
      },
    );
    f.h.api.events.on("import-downloads", imported);
    if (scenario === "canceled import")
      await expect(f.run(() => current)).rejects.toBeInstanceOf(UserCanceled);
    else expect(await f.run()).toBe(scenario === "empty import" ? undefined : "imported");
    expect(imported).toHaveBeenCalledTimes(1);
    expect(f.h.getState().persistent.downloads.files.unrelated.modInfo).toEqual({});
    if (scenario === "unfinished")
      expect(f.h.getState().persistent.downloads.files.selected.state).toBe("paused");
    if (scenario !== "missing")
      expect(fs.readFileSync(f.target, "utf8")).toBe("cached bundled bytes");
    if (scenario === "canceled import")
      expect(f.h.getState().persistent.downloads.files.imported.modInfo).toEqual({});
  });
}

test("multiple finished aliases of the checked bundle are ambiguous", async ({
  makeInstallManager,
}) => {
  const f = makeCacheFixture(makeInstallManager);
  f.h.setState((s) => {
    s.persistent.downloads.files.alias = makeDownload({
      id: "alias",
      game: ["fallout4"],
      localPath: f.target,
      state: "finished",
    });
  });
  const imported = vi.fn();
  f.h.api.events.on("import-downloads", imported);
  await expect(f.run()).rejects.toBeInstanceOf(ProcessCanceled);
  expect(imported).not.toHaveBeenCalled();
  expect(f.h.getState().persistent.downloads.files.selected.modInfo).toEqual({});
  expect(fs.readFileSync(f.target, "utf8")).toBe("cached bundled bytes");
});

for (const scenario of ["replaced row", "moved root", "new alias", "canceled"] as const) {
  test(`cached bundle refuses ${scenario} after its native stat completes`, async ({
    makeInstallManager,
  }) => {
    const f = makeCacheFixture(makeInstallManager);
    let entered!: () => void;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const stat = nativeFs.statAsync;
    vi.spyOn(nativeFs, "statAsync").mockImplementation((file) =>
      stat(file).then(async (result) => {
        if (file === f.target) {
          entered();
          await gate;
        }
        return result;
      }),
    );
    let current = true;
    const operation = f.run(() => current);
    try {
      await held;
      if (scenario === "canceled") current = false;
      else
        f.h.setState((s) => {
          if (scenario === "moved root")
            s.settings.downloads.path = path.join(f.root, "new-downloads");
          else if (scenario === "new alias")
            s.persistent.downloads.files.alias = makeDownload({
              id: "alias",
              localPath: f.target,
              state: "finished",
            });
          else
            s.persistent.downloads.files.selected = makeDownload({
              ...s.persistent.downloads.files.selected,
              fileMD5: "replacement",
            });
        });
      release();
      await expect(operation).rejects.toBeInstanceOf(
        scenario === "canceled" ? UserCanceled : ProcessCanceled,
      );
      expect(f.h.manager["mBundledArchives"].get(f.dep)).toBeUndefined();
      expect(f.h.getState().persistent.downloads.files.selected.modInfo).toEqual({});
      expect(fs.readFileSync(f.target, "utf8")).toBe("cached bundled bytes");
    } finally {
      release();
      await operation.catch(() => undefined);
    }
  });
}

test("a native cache permission error is reported without importing over it", async ({
  makeInstallManager,
}) => {
  const f = makeCacheFixture(makeInstallManager);
  const imported = vi.fn();
  f.h.api.events.on("import-downloads", imported);
  fs.chmodSync(path.dirname(f.target), 0);
  try {
    await expect(f.run()).rejects.toMatchObject({ code: "EACCES" });
    expect(imported).not.toHaveBeenCalled();
    expect(f.h.getState().persistent.downloads.files.selected.modInfo).toEqual({});
  } finally {
    fs.chmodSync(path.dirname(f.target), 0o755);
  }
});

for (const timing of ["before admission", "during install"] as const) {
  for (const change of ["row", "path"] as const) {
    test(`bundled archive ownership rejects a changed ${change} ${timing}`, async ({
      makeInstallManager,
    }) => {
      const f = makeCacheFixture(makeInstallManager);
      fs.unlinkSync(f.target);
      const payload = path.join(f.root, "payload.txt");
      fs.writeFileSync(payload, "owned synthetic payload");
      await new Zip().add(f.target, [payload]);
      const bytes = fs.readFileSync(f.target);
      expect(await f.run()).toBe("selected");
      const owner = f.h.manager["mBundledArchives"].get(f.dep);
      const output = path.join(f.root, "installed");
      f.h.manager["mGetInstallPath"] = () => output;
      f.h.api.lookupModMeta = () => Bluebird.resolve([]);
      const changeOwner = () =>
        f.h.setState((s) => {
          if (change === "row")
            s.persistent.downloads.files.selected = makeDownload({
              ...s.persistent.downloads.files.selected,
              fileMD5: "replacement",
            });
          else s.settings.downloads.path = path.join(f.root, "moved-downloads");
        });
      let admitted!: () => void;
      let release!: () => void;
      const held = new Promise<void>((r) => {
        admitted = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      if (timing === "during install")
        f.h.api.emitAndAwait = (async (event) => {
          if (event === "will-install-mod") {
            admitted();
            await gate;
          }
          return [];
        }) as typeof f.h.api.emitAndAwait;
      else changeOwner();
      const operation = f.h.manager["installModAsync"](
        f.dep.reference,
        f.h.api,
        "selected",
        {},
        undefined,
        "skyrimse",
        true,
        undefined,
        () => true,
        owner,
      );
      const observed = operation.then(
        () => undefined,
        (error) => error,
      );
      try {
        if (timing === "during install") {
          await held;
          changeOwner();
        }
        const replacement = f.h.getState().persistent.downloads.files.selected;
        release();
        const error = await observed;
        expect(error).toBeInstanceOf(ProcessCanceled);
        expect(f.h.getState().persistent.downloads.files.selected).toBe(replacement);
        expect(fs.readFileSync(f.target)).toEqual(bytes);
        expect(fs.existsSync(path.join(output, "bundle", "payload.txt"))).toBe(false);
        expect(f.h.getState().persistent.mods.skyrimse?.bundle).toBeUndefined();
        expect(f.h.manager.getActiveInstallations()).toEqual([]);
      } finally {
        release();
        await observed;
        await Promise.all(f.h.manager["mRunningInstalls"].values());
      }
    });
  }
}
