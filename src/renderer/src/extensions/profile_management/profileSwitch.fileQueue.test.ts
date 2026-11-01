import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import { afterEach, expect, vi } from "vitest";

import {
  makeApiHarness,
  makeLoadOrder,
  makeLoadOrderGameInfo,
  makeProfile,
  registerHarnessGame,
} from "../../test-utils/builders";
import { test } from "../../test-utils/harnessTest";
import type { IExtensionContext } from "../../types/IExtensionContext";
import { UserCanceled } from "../../util/CustomErrors";
import * as atomic from "../../util/fsAtomic";
import { setFBLoadOrder } from "../file_based_loadorder/actions/loadOrder";
import { LoadOrderRegistry } from "../file_based_loadorder/gameSupport";
import { registerLoadOrderHandlers } from "../file_based_loadorder/handlers";
import { REDUCER_BINDINGS } from "../file_based_loadorder/reducers/bindings";
import { loadOrderForProfile } from "../file_based_loadorder/selectors";
import { setNextProfile } from "./actions/settings";
import initProfiles from "./index";
import { profilesReducer } from "./reducers/profiles";
import { settingsReducer } from "./reducers/settings";
import { profilePath } from "./util/manage";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
afterEach(() => vi.restoreAllMocks());

type SnapshotGuard = (
  guard: (save: () => PromiseLike<void>) => PromiseLike<void>,
  cleanup: () => void,
) => void;

for (const mode of [
  "sequential",
  "overlap",
  "failed-write",
  "cancel-retry",
  "boundary-edit",
] as const) {
  test(`profile file snapshot shares the load order queue: ${mode}`, async () => {
    await import("../mod_management/index.js");
    expect(globalThis.Promise).toBe(Bluebird);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "profile-file-queue-"));
    const game = `file-queue-${mode}-game`;
    registerHarnessGame(game);
    const a = makeProfile({ id: `file-queue-${mode}-a`, gameId: game });
    const b = makeProfile({ id: `file-queue-${mode}-b`, gameId: game });
    const target = path.join(root, "settings.ini");
    const savedPath = path.join(profilePath(a), "settings.ini");
    const initial = makeLoadOrder("initial");
    const latest = makeLoadOrder("latest");
    const retry = makeLoadOrder("retry");
    const incoming = makeLoadOrder("incoming");
    const expected = mode === "failed-write" || mode === "cancel-retry" ? retry : latest;
    await fs.writeFile(target, JSON.stringify(initial));
    await fs.mkdir(profilePath(b), { recursive: true });
    await fs.writeFile(path.join(profilePath(b), "settings.ini"), JSON.stringify(incoming));
    const h = makeApiHarness(
      {
        profiles: { [a.id]: a, [b.id]: b },
        activeProfileId: a.id,
        lastActiveProfile: { [game]: a.id },
      },
      [
        ...REDUCER_BINDINGS,
        { path: ["persistent", "profiles"], reducer: profilesReducer },
        { path: ["settings", "profiles"], reducer: settingsReducer },
      ],
    );
    h.setState((state) => {
      state.settings.profiles.nextProfileId = a.id;
      state.session.base = { commandLine: {}, toolsRunning: {}, activity: {} } as never;
    });
    let cancellation: UserCanceled | undefined;
    const work: Promise<unknown>[] = [];
    const track = (result: unknown) => {
      if (typeof (result as PromiseLike<unknown>)?.then === "function") {
        const actual = Promise.resolve(result);
        work.push(actual);
        void actual.catch(() => undefined);
      }
      return result;
    };
    const onStateChange = h.api.onStateChange.bind(h.api);
    vi.spyOn(h.api, "onStateChange").mockImplementation((keys, callback) =>
      onStateChange(keys, (prev, current) => {
        return track(callback(prev, current));
      }),
    );
    const on = h.api.events.on.bind(h.api.events);
    vi.spyOn(h.api.events, "on").mockImplementation((event, callback) =>
      on(event, (...args) => track((callback as (...args: unknown[]) => unknown)(...args))),
    );
    const drain = async () => {
      for (let round = 0; round < 100; round++) {
        const count = work.length;
        const outcomes = await Promise.all(
          work.map((operation) =>
            Promise.resolve(operation).then(
              () => ({ status: "fulfilled" as const }),
              (reason: unknown) => ({ status: "rejected" as const, reason }),
            ),
          ),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (count === work.length) {
          const settled = outcomes.filter(
            (result) => result.status !== "rejected" || result.reason !== cancellation,
          );
          expect(settled.filter((result) => result.status === "rejected")).toEqual([]);
          expect(
            outcomes
              .filter((result) => result.status === "rejected")
              .map((result) => result.reason),
          ).toEqual(cancellation === undefined ? [] : [cancellation]);
          return;
        }
      }
      throw new Error("Profile handlers did not settle");
    };
    const callbacks: Array<() => void> = [];
    const context = new Proxy(
      { api: h.api, once: (cb: () => void) => callbacks.push(cb) },
      { get: (obj, key) => (key in obj ? obj[key] : () => undefined) },
    ) as unknown as IExtensionContext;
    initProfiles(context);
    context.registerProfileFile(game, target);
    h.api.events.on("deploy-mods", (cb) => cb(null));
    const started = deferred();
    h.api.events.once("profile-did-change", started.resolve);
    callbacks.forEach((cb) => cb());
    await started.promise;
    await drain();

    const writeEntered = deferred();
    const releaseWrite = deferred();
    const snapshotSubmitted = deferred();
    const snapshotDone = deferred();
    const releaseCopy = deferred();
    const copyEntered = deferred();
    let snapshotStarted = false;
    let startedBeforeWriteReleased = false;
    let released = false;
    let writes = 0;
    const writtenOrders: string[] = [];
    let reads = 0;
    let canceled = false;
    let snapshots = 0;
    const ordering: string[] = [];
    // This inner observer also lets a failing control finish its early copy before release.
    h.api.events.on("profile-will-change", (_id, _enqueue, guard: SnapshotGuard) => {
      guard(
        async (save) => {
          snapshotStarted = true;
          startedBeforeWriteReleased ||= !released;
          await save();
          snapshotDone.resolve();
        },
        () => undefined,
      );
    });
    const registry = new LoadOrderRegistry();
    registry.addInline(
      makeLoadOrderGameInfo({
        gameId: game,
        serializeLoadOrder: async (order) => {
          writes++;
          if (order === latest) {
            writeEntered.resolve();
            await releaseWrite.promise;
            if (mode === "failed-write") throw new Error("serializer failed");
          }
          await fs.writeFile(target, JSON.stringify(order));
          writtenOrders.push(...order.map((entry) => entry.id));
        },
        deserializeLoadOrder: async () => {
          reads++;
          return JSON.parse(await fs.readFile(target, "utf8"));
        },
      }),
    );
    registerLoadOrderHandlers(h.api, registry);
    h.api.events.on("profile-will-change", (_id, enqueue, guard: SnapshotGuard) => {
      guard(
        (save) => {
          const result = save();
          snapshotSubmitted.resolve();
          return result;
        },
        () => undefined,
      );
      enqueue(async () => {
        ordering.push("purge");
        await fs.writeFile(target, JSON.stringify(makeLoadOrder("purged")));
      });
    });
    const copy = atomic.copyFileAtomic;
    vi.spyOn(atomic, "copyFileAtomic").mockImplementation((source, destination) => {
      const result = Bluebird.try(async () => {
        if (destination === savedPath) {
          snapshots++;
          if (mode === "cancel-retry" && !canceled) {
            canceled = true;
            cancellation = new UserCanceled();
            throw cancellation;
          }
          await copy(source, destination);
          ordering.push("snapshot");
          if (mode === "boundary-edit" && snapshots === 1) {
            copyEntered.resolve();
            await releaseCopy.promise;
          }
        } else await copy(source, destination);
      });
      track(result);
      return result;
    });
    try {
      h.api.store.dispatch(setFBLoadOrder(a.id, initial));
      await drain();
      h.api.store.dispatch(setFBLoadOrder(a.id, latest));
      await writeEntered.promise;
      if (mode === "failed-write") h.api.store.dispatch(setFBLoadOrder(a.id, retry));
      if (mode === "sequential") {
        released = true;
        releaseWrite.resolve();
        await drain();
      }
      h.api.store.dispatch(setNextProfile(b.id));
      await snapshotSubmitted.promise;
      if (snapshotStarted && mode !== "cancel-retry" && mode !== "boundary-edit")
        await snapshotDone.promise;
      released = true;
      releaseWrite.resolve();
      if (mode === "boundary-edit") {
        await copyEntered.promise;
        h.api.store.dispatch(setFBLoadOrder(a.id, makeLoadOrder("late-outgoing-edit")));
        releaseCopy.resolve();
      }
      await drain();
      if (mode === "cancel-retry") {
        expect(h.getState().settings.profiles.activeProfileId).toBe(a.id);
        h.api.store.dispatch(setFBLoadOrder(a.id, retry));
        await drain();
        h.api.store.dispatch(setNextProfile(b.id));
        await drain();
      }
      const saved = JSON.parse(await fs.readFile(savedPath, "utf8"));
      const live = JSON.parse(await fs.readFile(target, "utf8"));
      const outgoingOrder = loadOrderForProfile(h.getState(), a.id);
      const switchReads = reads;
      h.api.store.dispatch(setNextProfile(a.id));
      await drain();
      const restored = JSON.parse(await fs.readFile(target, "utf8"));
      expect(h.getState().settings.profiles.activeProfileId).toBe(a.id);
      expect(saved).toEqual(expected);
      expect(live).toEqual(incoming);
      expect(restored).toEqual(expected);
      expect(loadOrderForProfile(h.getState(), a.id)).toEqual(expected);
      expect(startedBeforeWriteReleased).toBe(false);
      expect(ordering.slice(0, 2)).toEqual(["snapshot", "purge"]);
      expect(snapshots).toBe(mode === "cancel-retry" ? 2 : 1);
      expect(canceled).toBe(mode === "cancel-retry");
      expect(h.errorNotifications).toHaveLength(mode === "failed-write" ? 1 : 0);
      expect(switchReads).toBe(1);
      expect(reads).toBe(2);
      expect(writtenOrders).not.toContain("late-outgoing-edit");
      expect(writes).toBe(
        mode === "failed-write" || mode === "cancel-retry" || mode === "boundary-edit" ? 4 : 3,
      );
      if (mode === "boundary-edit")
        expect(outgoingOrder).toEqual(makeLoadOrder("late-outgoing-edit"));
    } finally {
      released = true;
      releaseWrite.resolve();
      releaseCopy.resolve();
      try {
        await drain();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(profilePath(a), { recursive: true, force: true });
        await fs.rm(profilePath(b), { recursive: true, force: true });
      }
    }
  });
}
