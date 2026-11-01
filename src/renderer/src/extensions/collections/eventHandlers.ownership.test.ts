import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import SevenZip from "node-7z";
import { afterEach, expect, vi } from "vitest";

import { makeApiHarness, makeMod, makeProfile, makeDownload } from "../../test-utils/builders";
import { test } from "../../test-utils/harnessTest";
import { downloadPathForGame } from "../../util/selectors";
import { onRemoveMods } from "../mod_management/eventHandlers";
import { setCurrentProfile, setNextProfile } from "../profile_management/actions/settings";
import { profilesReducer } from "../profile_management/reducers/profiles";
import { settingsReducer as profileSettings } from "../profile_management/reducers/settings";
import { onCollectionUpdate } from "./eventHandlers";
import InstallDriver from "./util/InstallDriver";

afterEach(() => vi.restoreAllMocks());
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { resolve, promise };
};

for (const timing of ["unchanged", "metadata", "queued", "profile", "domain"] as const) {
  test(`collection update retains its original game across metadata await: ${timing}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-collection-game-"));
    const a = "skyrimse",
      b = "fallout4",
      id = "collection-rev1";
    const stagingA = path.join(root, "staging-a"),
      stagingB = path.join(root, "staging-b");
    const fileA = path.join(stagingA, id, "settings.ini"),
      fileB = path.join(stagingB, id, "settings.ini");
    for (const [file, bytes] of [
      [fileA, "original A settings"],
      [fileB, "unrelated B settings"],
    ]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    const pa = makeProfile({ id: "pa", gameId: a }),
      pb = makeProfile({ id: "pb", gameId: b }),
      pa2 = makeProfile({ id: "pa2", gameId: a });
    const h = makeApiHarness(
      {
        profiles: { pa, pb, pa2 },
        activeProfileId: "pa",
        installPath: { [a]: stagingA, [b]: stagingB },
        mods: {
          [a]: {
            [id]: makeMod({
              id,
              type: "collection",
              installationPath: id,
              rules: [],
              attributes: { collectionSlug: "collection-a" },
            }),
          },
          [b]: {
            [id]: makeMod({
              id,
              type: "collection",
              installationPath: id,
              rules: [],
              attributes: { collectionSlug: "unrelated-b" },
            }),
          },
        },
      },
      [
        { path: ["settings", "profiles"], reducer: profileSettings },
        { path: ["persistent", "profiles"], reducer: profilesReducer },
      ],
    );
    h.setState((d) => {
      d.settings.downloads.path = path.join(root, "downloads");
    });
    const dlPath = downloadPathForGame(h.getState(), a);
    fs.mkdirSync(dlPath, { recursive: true });
    const archive = path.join(dlPath, "revision.zip");
    const manifest = {
      info: {
        author: "Curator",
        authorUrl: "https://example.invalid/curator",
        name: "Collection A",
        description: "A collection",
        installInstructions: "",
        domainName: "skyrimspecialedition",
      },
      mods: [],
      modRules: [],
    };
    const manifestFile = path.join(root, "collection.json");
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    await new SevenZip().add(archive, [manifestFile]);
    const archiveBefore = fs.readFileSync(archive);
    h.setState((d) => {
      d.persistent.downloads.files.revision = makeDownload({
        id: "revision",
        state: "finished",
        size: archiveBefore.length,
        game: [a],
        localPath: "revision.zip",
      });
    });
    const metadataEntered = deferred(),
      metadataRelease = deferred(),
      removedDone = deferred();
    const removeCalls: Array<{ game: string; ids: string[] }> = [],
      installCalls: Array<{ dlId: string; options: unknown }> = [];
    let operation: Bluebird<void> | undefined;
    const driver = new InstallDriver(h.api);
    const queueGate = deferred();
    await driver.prepare(() => Bluebird.resolve(queueGate.promise));
    const prepare = driver.prepare.bind(driver);
    vi.spyOn(driver, "prepare").mockImplementation((fn) =>
      prepare(() => {
        operation = fn();
        return operation;
      }),
    );
    const latest = {
      id: 2,
      revisionNumber: 2,
      downloadLink: "https://example.invalid/revision",
      collection: { id: 42, slug: "collection-a", name: "Collection A" },
    };
    h.api.emitAndAwait = (async (event) => {
      if (event === "get-nexus-collection-revision") {
        metadataEntered.resolve();
        await metadataRelease.promise;
        return [latest];
      }
      if (event === "resolve-collection-url")
        return [[{ URI: "https://example.invalid/revision.zip" }]];
      if (event === "did-remove-mods") removedDone.resolve();
      return [];
    }) as typeof h.api.emitAndAwait;
    h.api.events.on("start-download", (_urls, _info, _name, cb) => cb(null, "revision"));
    h.api.events.on("remove-mods", (game, ids, cb, options) => {
      removeCalls.push({ game, ids });
      onRemoveMods(
        h.api,
        [],
        { markRecentRemoval: () => {} } as unknown as Parameters<typeof onRemoveMods>[2],
        game,
        ids,
        cb,
        options,
      );
    });
    h.api.events.on("start-install-download", (dlId, options, cb) => {
      installCalls.push({ dlId, options });
      cb(null, "new-collection");
    });
    const callback = vi.fn();
    try {
      onCollectionUpdate(h.api, driver)(
        timing === "domain" ? "skyrimspecialedition" : a,
        "collection-a",
        2,
        "nexus",
        id,
        callback,
      );
      const switchProfile = () => {
        const profile = timing === "profile" ? pa2 : pb;
        h.api.store.dispatch(setCurrentProfile(undefined, profile.id));
        h.api.store.dispatch(setNextProfile(profile.id));
      };
      if (timing === "queued" || timing === "domain") switchProfile();
      queueGate.resolve();
      await metadataEntered.promise;
      if (timing === "metadata" || timing === "profile") switchProfile();
      metadataRelease.resolve();
      await operation;
      if (removeCalls.length > 0) await removedDone.promise;
      expect(callback).toHaveBeenCalledExactlyOnceWith(null);
      expect(h.errorNotifications).toEqual([]);
      expect(fs.readFileSync(archive)).toEqual(archiveBefore);
      expect(installCalls).toHaveLength(1);
      expect.soft(fs.existsSync(fileB)).toBe(true);
      expect.soft(h.getState().persistent.mods[b][id]).toBeDefined();
      expect(removeCalls).toEqual([{ game: a, ids: [id] }]);
      expect(fs.readFileSync(fileB, "utf8")).toBe("unrelated B settings");
      expect(h.getState().persistent.mods[b][id]).toBeDefined();
      expect(fs.existsSync(fileA)).toBe(false);
      if (timing === "profile") {
        expect(installCalls).toEqual([{ dlId: "revision", options: { profileId: "pa" } }]);
      }
    } finally {
      queueGate.resolve();
      metadataRelease.resolve();
      await operation;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
