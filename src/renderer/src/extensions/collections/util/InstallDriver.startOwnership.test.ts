import Bluebird from "bluebird";
import { afterEach, describe, expect, vi } from "vitest";

import {
  makeApiHarness,
  makeDownload,
  makeMod,
  makeProfile,
  registerHarnessGame,
} from "../../../test-utils/builders";
import { test } from "../../../test-utils/driverTest";
import type { IExtensionApi } from "../../../types/IExtensionContext";
import { getGame } from "../../gamemode_management/util/getGame";
import { CACHE_EXPIRE_MS, MOD_TYPE } from "../constants";
import persistentReducer from "../reducers/persistent";
import InstallDriver from "./InstallDriver";

const gameId = "skyrimse";
const profile = makeProfile({ id: "start-profile", gameId });
const collection = makeMod({ id: "starting-collection", type: MOD_TYPE, archiveId: "archive" });
const download = makeDownload({
  id: "archive",
  game: [gameId],
  state: "finished",
  modInfo: {
    nexus: {
      ids: {
        collectionId: 123,
        collectionSlug: "start-fixture",
        revisionId: 456,
        revisionNumber: 2,
      },
    },
  },
});

afterEach(() => vi.restoreAllMocks());

describe("collection start ownership", () => {
  for (const operation of ["query", "continue", "replacement-query"] as const) {
    test(`a delayed ${operation} cannot change a replacement collection`, async () => {
      registerHarnessGame(gameId);
      const replacement = makeMod({
        id: "replacement",
        type: MOD_TYPE,
        archiveId: "replacement-archive",
      });
      const replacementInfo = { id: 987, slug: "replacement", name: "Replacement collection" };
      const replacementDownload = makeDownload({
        id: "replacement-archive",
        game: [gameId],
        state: "finished",
        modInfo: { nexus: { collectionInfo: replacementInfo } },
      });
      const harness = makeApiHarness(
        {
          mods: { [gameId]: { [collection.id]: collection, [replacement.id]: replacement } },
          profiles: { [profile.id]: profile },
          downloads: { [download.id]: download, [replacementDownload.id]: replacementDownload },
        },
        [{ path: ["persistent", "collections"], reducer: persistentReducer }],
      );
      const driver = new InstallDriver(harness.api);
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      let release: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const requests = vi.fn();
      let waiting = operation === "query";
      harness.api.emitAndAwait = (async (event: string) => {
        if (event === "get-nexus-collection-revision" && operation === "replacement-query") {
          return [
            {
              id: 456,
              collection: { id: 123, slug: "start-fixture" },
              modFiles: [],
              gameVersions: [{ reference: "different-version" }],
            },
          ];
        }
        if (event === "get-nexus-collection") {
          if (waiting) {
            requests();
            await gate;
          }
          return [{ id: 123, slug: "start-fixture", name: "Abandoned collection" }];
        }
        return [];
      }) as IExtensionApi["emitAndAwait"];
      const installs = vi.fn();
      harness.api.events.on("install-dependencies", installs);
      if (operation === "replacement-query") {
        harness.api.showDialog = () => Bluebird.resolve({ action: "Cancel", input: {} });
        await driver.start(profile, collection);
        expect(driver.installDone).toBe(true);
        waiting = true;
        now += CACHE_EXPIRE_MS + 1;
      }
      if (operation === "continue") {
        await driver.query(profile, collection);
        waiting = true;
        now += CACHE_EXPIRE_MS + 1;
      }
      const pending =
        operation === "continue" ? driver.continue() : driver.query(profile, collection);
      try {
        await vi.waitFor(() => expect(requests).toHaveBeenCalledTimes(1));
        if (operation === "replacement-query") {
          await driver.query(profile, replacement);
        } else {
          driver.cancel();
          await driver.start(profile, replacement);
        }
        expect(driver.collectionInfo).toEqual(replacementInfo);
        release!();
        await pending;

        expect(driver.collection).toBe(replacement);
        expect(driver.collectionInfo).toEqual(replacementInfo);
        expect(driver.step).toBe(operation === "replacement-query" ? "query" : "start");
        expect(installs).not.toHaveBeenCalled();
        await driver.continue();
        if (operation === "replacement-query") await driver.continue();
        expect(installs).toHaveBeenCalledExactlyOnceWith(
          profile.id,
          gameId,
          [replacement.id],
          true,
        );
      } finally {
        release!();
        await pending;
        driver.cancel();
      }
    });
  }

  for (const stage of ["revision", "version", "dialog"] as const) {
    for (const stop of ["cancel", "pause", "continue"] as const) {
      test(`handles ${stop} while ${stage} is pending`, async ({ makeDriver }) => {
        const harness = makeDriver({
          mods: { [gameId]: { [collection.id]: collection } },
          profiles: { [profile.id]: profile },
          downloads: { [download.id]: download },
        });
        let release: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const requests = vi.fn();
        harness.api.emitAndAwait = (async (event: string) => {
          if (event === "get-nexus-collection-revision") {
            if (stage === "revision") {
              requests();
              await gate;
            }
            return [
              {
                id: 456,
                collection: { id: 123, slug: "start-fixture" },
                modFiles: [],
                gameVersions: stage === "dialog" ? [{ reference: "different-version" }] : [],
              },
            ];
          }
          return [];
        }) as IExtensionApi["emitAndAwait"];
        if (stage === "version") {
          vi.spyOn(getGame(gameId), "getGameVersion").mockImplementation(async () => {
            requests();
            await gate;
            return "1.0.0";
          });
        }
        if (stage === "dialog") {
          harness.api.showDialog = () => {
            requests();
            return Bluebird.resolve(gate).then(() => ({ action: "Continue", input: {} }));
          };
        }
        const started = vi.fn();
        harness.api.events.on("will-install-collection", started);
        const starting = harness.driver.start(profile, collection);
        try {
          await vi.waitFor(() => expect(requests).toHaveBeenCalledTimes(1));
          if (stop === "cancel") harness.driver.cancel();
          if (stop === "pause") harness.driver.pause("logout");
        } finally {
          release!();
          await starting;
        }

        try {
          if (stop === "continue") {
            expect(harness.getState().session.collections.activeSession).toMatchObject({
              gameId,
              profileId: profile.id,
              collectionId: collection.id,
            });
            expect(started).toHaveBeenCalledExactlyOnceWith(gameId, collection.id);
          } else {
            expect(harness.getState().session.collections.activeSession).toBeUndefined();
            expect(harness.driver.currentSessionId).toBeUndefined();
            expect(harness.driver.collection).toBeUndefined();
            expect(harness.driver.step).toBe("prepare");
            expect(started).not.toHaveBeenCalled();
          }
        } finally {
          harness.driver.cancel();
        }
      });
    }
  }

  test("an abandoned start cannot replace a resumed session or release its hold", async ({
    makeDriver,
  }) => {
    const harness = makeDriver({
      mods: { [gameId]: { [collection.id]: collection } },
      profiles: { [profile.id]: profile },
      downloads: { [download.id]: download },
    });
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests = vi.fn();
    harness.api.emitAndAwait = (async (event: string) => {
      if (event === "get-nexus-collection-revision") {
        requests();
        await gate;
        return [{ id: 456, collection: { id: 123, slug: "start-fixture" }, modFiles: [] }];
      }
      return [];
    }) as IExtensionApi["emitAndAwait"];
    const released: boolean[] = [];
    const holds: Promise<void>[] = [];
    const releases: Array<() => void> = [];
    harness.api.ext.withSuppressedTests = (_events: string[], task: () => Promise<void>) => {
      const index = holds.length;
      released.push(false);
      const pending = task();
      // Retain teardown handles even when a release-ownership mutation loses one.
      releases.push((harness.driver as unknown as { mOnStop: () => void }).mOnStop);
      const hold = pending.then(() => {
        released[index] = true;
      });
      holds.push(hold);
      return hold;
    };
    const started = vi.fn();
    harness.api.events.on("will-install-collection", started);
    const starting = harness.driver.start(profile, collection);
    let resumed: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(requests).toHaveBeenCalledTimes(1));
      harness.driver.pause("logout");
      resumed = harness.driver.start(profile, collection);
      await vi.waitFor(() => expect(holds).toHaveLength(2));
      release!();
      await Promise.all([starting, resumed]);

      expect(started).toHaveBeenCalledExactlyOnceWith(gameId, collection.id);
      expect(harness.getState().session.collections.activeSession).toMatchObject({
        gameId,
        profileId: profile.id,
        collectionId: collection.id,
      });
      expect(released).toEqual([true, false]);
      harness.driver.cancel();
      await vi.waitFor(() => expect(released).toEqual([true, true]));
      await Promise.all(holds);
    } finally {
      release!();
      await Promise.allSettled([starting, resumed]);
      harness.driver.cancel();
      releases.forEach((release) => release());
      await Promise.all(holds);
    }
  });
});
