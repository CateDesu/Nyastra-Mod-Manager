import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import SevenZip from "node-7z";
import { afterEach, expect, vi } from "vitest";

import {
  makeApiHarness,
  makeMod,
  makeProfile,
  makeDownload,
  makeGameStored,
} from "../../test-utils/builders";
import { test } from "../../test-utils/harnessTest";
import { downloadPathForGame } from "../../util/selectors";
import { addMod, removeMod } from "../mod_management/actions/mods";
import { onRemoveMods } from "../mod_management/eventHandlers";
import { removeProfile, setProfile } from "../profile_management/actions/profiles";
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

const cases = [
  ...["base", "domain", "vr"].flatMap((input) =>
    ["unchanged", "cached"].flatMap((timing) => [
      { base: "skyrimse", owner: "skyrimvr", domain: "skyrimspecialedition", input, timing },
      { base: "fallout4", owner: "fallout4vr", domain: "fallout4", input, timing },
    ]),
  ),
  ...[
    "metadata",
    "queued",
    "profile",
    "profile-removed",
    "profile-replaced",
    "collection-removed",
    "collection-replaced",
    "row-replaced",
    "root-moved",
    "incompatible",
  ].map((timing) => ({
    base: "skyrimse",
    owner: "skyrimvr",
    domain: "skyrimspecialedition",
    input: "base",
    timing,
  })),
];
for (const { base, owner, domain, input, timing } of cases) {
  test(`collection update retains its original game across ${owner} ${input} ${timing}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-collection-game-"));
    const a = owner,
      b = base,
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
        knownGames: [
          makeGameStored({ id: base, details: { nexusPageId: domain } }),
          makeGameStored({
            id: owner,
            details: { nexusPageId: domain, compatibleDownloads: [base] },
          }),
          makeGameStored({ id: "witcher3" }),
        ],
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
              attributes: { collectionSlug: "collection-a" },
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
    const dlPath = downloadPathForGame(h.getState(), timing === "incompatible" ? "witcher3" : base);
    fs.mkdirSync(dlPath, { recursive: true });
    const archive = path.join(dlPath, "revision.zip");
    const manifest = {
      info: {
        author: "Curator",
        authorUrl: "https://example.invalid/curator",
        name: "Collection A",
        description: "A collection",
        installInstructions: "",
        domainName: domain,
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
        game: [timing === "incompatible" ? "witcher3" : base, owner],
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
    h.api.events.on("start-download", (_urls, _info, _name, cb) => {
      if (timing === "cached")
        cb(
          Object.assign(new Error("cached"), {
            name: "AlreadyDownloaded",
            fileName: "revision.zip",
          }),
        );
      else cb(null, "revision");
    });
    const extract = SevenZip.prototype.extractFull;
    vi.spyOn(SevenZip.prototype, "extractFull").mockImplementation(function (...args) {
      return extract.apply(this, args).then((result) => {
        if (timing === "row-replaced")
          h.setState((s) => {
            s.persistent.downloads.files.revision = makeDownload({
              id: "revision",
              game: [base],
              state: "finished",
              localPath: "revision.zip",
              fileMD5: "replacement",
            });
          });
        if (timing === "root-moved")
          h.setState((s) => {
            s.settings.downloads.path = path.join(root, "moved");
          });
        return result;
      });
    });
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
        input === "domain" ? domain : input === "vr" ? owner : base,
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
      if (timing === "queued") switchProfile();
      queueGate.resolve();
      await metadataEntered.promise;
      if (timing === "profile-removed") h.api.store.dispatch(removeProfile("pa"));
      if (timing === "profile-replaced")
        h.api.store.dispatch(
          setProfile(makeProfile({ id: "pa", gameId: owner, name: "Replacement" })),
        );
      if (timing === "collection-removed") h.api.store.dispatch(removeMod(owner, id));
      if (timing === "collection-replaced")
        h.api.store.dispatch(
          addMod(
            owner,
            makeMod({ id, type: "collection", attributes: { collectionSlug: "collection-a" } }),
          ),
        );
      if (timing === "metadata" || timing === "profile") switchProfile();
      metadataRelease.resolve();
      await operation;
      if (removeCalls.length > 0) await removedDone.promise;
      expect(callback).toHaveBeenCalledExactlyOnceWith(null);
      const accepted = ["unchanged", "metadata", "queued", "profile", "cached"].includes(timing);
      if (accepted) {
        expect(h.errorNotifications).toEqual([]);
        expect(removeCalls).toEqual([{ game: a, ids: [id] }]);
        expect(installCalls).toEqual([{ dlId: "revision", options: { profileId: "pa" } }]);
        expect(fs.existsSync(fileA)).toBe(false);
      } else {
        expect(h.errorNotifications).toHaveLength(1);
        expect(removeCalls).toEqual([]);
        expect(installCalls).toEqual([]);
        expect(fs.readFileSync(fileA, "utf8")).toBe("original A settings");
      }
      expect(fs.readFileSync(fileB, "utf8")).toBe("unrelated B settings");
      expect(h.getState().persistent.mods[b][id]).toBeDefined();
      expect(fs.readFileSync(archive)).toEqual(archiveBefore);
    } finally {
      queueGate.resolve();
      metadataRelease.resolve();
      await operation;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const incoming of ["skyrimse", "fallout4"]) {
  test(`rejects undeclared compatibility without selecting a colliding base collection: ${incoming}`, async ({
    makeApi,
  }) => {
    const id = "colliding-id";
    const collection = () =>
      makeMod({ id, type: "collection", attributes: { collectionSlug: "same-slug" } });
    const h = makeApi({
      knownGames: [
        makeGameStored({ id: "skyrimse", details: { nexusPageId: "skyrimspecialedition" } }),
        makeGameStored({
          id: "skyrimvr",
          details: { nexusPageId: "skyrimspecialedition", compatibleDownloads: [] },
        }),
        makeGameStored({ id: "fallout4" }),
      ],
      profiles: { owner: makeProfile({ id: "owner", gameId: "skyrimvr" }) },
      activeProfileId: "owner",
      mods: {
        skyrimvr: { [id]: collection() },
        skyrimse: { [id]: collection() },
        fallout4: { [id]: collection() },
      },
    });
    const metadata = vi.spyOn(h.api, "emitAndAwait");
    const removed = vi.fn();
    const installed = vi.fn();
    h.api.events.on("remove-mods", removed);
    h.api.events.on("start-install-download", installed);
    const driver = new InstallDriver(h.api);
    let operation: Bluebird<void> | undefined;
    const prepare = driver.prepare.bind(driver);
    vi.spyOn(driver, "prepare").mockImplementation((fn) =>
      prepare(() => {
        operation = fn();
        return operation;
      }),
    );
    const callback = vi.fn();
    onCollectionUpdate(h.api, driver)(incoming, "same-slug", 2, "nexus", id, callback);
    await driver.prepare(() => Bluebird.resolve());
    await operation;
    expect(metadata).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    expect(installed).not.toHaveBeenCalled();
    expect(h.errorNotifications[0].message).toMatchObject({
      message: "Collection update archive is not compatible with this game",
    });
    expect(callback).toHaveBeenCalledExactlyOnceWith(null);
    for (const game of ["skyrimvr", "skyrimse", "fallout4"])
      expect(h.getState().persistent.mods[game][id]).toBeDefined();
  });
}
