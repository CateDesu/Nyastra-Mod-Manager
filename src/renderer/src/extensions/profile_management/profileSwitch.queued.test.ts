import { existsSync } from "node:fs";
import path from "node:path";

import Bluebird from "bluebird";
import { expect, vi, afterEach, test } from "vitest";

import {
  makeProfile,
  makeProfileSwitchHarness,
  resetHarnessRegistries,
} from "../../test-utils/builders";
import type { IProfileSwitchOpts } from "../../test-utils/harnessTypes";
import * as atomic from "../../util/fsAtomic";
import { setNextProfile } from "./actions/settings";
import init from "./index";
import { profilePath } from "./util/manage";

afterEach(() => {
  vi.restoreAllMocks();
  resetHarnessRegistries();
});

async function observedHarness(opts: IProfileSwitchOpts) {
  const handlers: PromiseLike<unknown>[] = [];
  const h = await makeProfileSwitchHarness((context) => {
    const register = context.api.onStateChange.bind(context.api);
    context.api.onStateChange = (keys, callback) =>
      register(keys, (prev, current) => {
        const result = callback(prev, current);
        if (keys.join(".") === "settings.profiles.nextProfileId") {
          handlers.push(Promise.resolve(result));
        }
      });
    context.api.events.removeAllListeners("deploy-mods");
    context.api.events.on("deploy-mods", (cb) => cb(null));
    return init(context);
  }, opts);
  const drain = async () => {
    let count = -1;
    while (count !== handlers.length) {
      count = handlers.length;
      await Promise.all(handlers);
    }
  };
  return { ...h, drain };
}

for (const mode of ["sequential", "coalesced", "startup", "inflight"] as const) {
  test(`snapshot ownership through real next-profile actions: ${mode}`, async () => {
    const gameId = `queued-${mode}-game`;
    const profiles = ["a", "b", "c", "d"].map((id) =>
      makeProfile({ id: `queued-${mode}-${id}`, gameId }),
    );
    const [a, b, c, d] = profiles;
    const copy = atomic.copyFileAtomic;
    const entered = Bluebird.defer<void>();
    const gate = Bluebird.defer<void>();
    const copies: PromiseLike<void>[] = [];
    let hold = mode === "startup";
    vi.spyOn(atomic, "copyFileAtomic").mockImplementation((source, destination) => {
      const task =
        hold && existsSync(source) && destination === path.join(profilePath(a), "settings.ini")
          ? ((hold = false), entered.resolve(), gate.promise.then(() => copy(source, destination)))
          : copy(source, destination);
      copies.push(task);
      return task;
    });
    const h = await observedHarness({
      profiles,
      activeProfileId: a.id,
      lastActive: { [gameId]: a.id },
      gameSettings: { [gameId]: "live A edits" },
      savedSettings: { [b.id]: "saved B", [c.id]: "saved C", [d.id]: "saved D" },
      waitForStartup: mode !== "startup",
    });
    try {
      if (mode === "sequential") {
        h.api.store.dispatch(setNextProfile(b.id));
        await h.drain();
        h.api.store.dispatch(setNextProfile(c.id));
      } else if (mode === "inflight") {
        hold = true;
        h.api.store.dispatch(setNextProfile(b.id));
        await entered.promise;
        h.api.store.dispatch(setNextProfile(c.id));
        h.api.store.dispatch(setNextProfile(d.id));
      } else {
        if (mode === "startup") await entered.promise;
        h.api.store.dispatch(setNextProfile(b.id));
        h.api.store.dispatch(setNextProfile(c.id));
      }
      gate.resolve();
      await h.drain();
      await Promise.all(copies);
      const expected = mode === "inflight" ? d : c;
      const saved = Object.fromEntries(
        await Promise.all(profiles.map(async (p) => [p.id, await h.savedSettings(p.id)])),
      );
      expect(h.getState().settings.profiles.activeProfileId).toBe(expected.id);
      expect(await h.gameSettings(gameId)).toBe(mode === "inflight" ? "saved D" : "saved C");
      expect(saved).toEqual({
        [a.id]: "live A edits",
        [b.id]: "saved B",
        [c.id]: "saved C",
        [d.id]: "saved D",
      });
    } finally {
      gate.resolve();
      await h.drain();
      await Promise.allSettled(copies);
      await h.cleanup();
    }
  });
}

test("repeated target during startup serializes whole switches", async () => {
  const gameId = "queued-repeat-game";
  const [a, b, c] = ["a", "b", "c"].map((id) => makeProfile({ id: `queued-repeat-${id}`, gameId }));
  const startupEntered = Bluebird.defer<void>();
  const startupGate = Bluebird.defer<void>();
  const lateGate = Bluebird.defer<void>();
  const restored = Bluebird.defer<void>();
  const copy = atomic.copyFileAtomic;
  const copies: PromiseLike<void>[] = [];
  let saves = 0;
  let switchStarts = 0;
  vi.spyOn(atomic, "copyFileAtomic").mockImplementation((source, destination) => {
    let task: ReturnType<typeof copy>;
    const perform = () =>
      copy(source, destination).then(() => {
        if (source === path.join(profilePath(b), "settings.ini")) restored.resolve();
      });
    const savingLive =
      existsSync(source) &&
      [a, c].some((p) => destination === path.join(profilePath(p), "settings.ini"));
    if (savingLive) {
      saves++;
      if (saves === 1) {
        startupEntered.resolve();
        task = startupGate.promise.then(perform);
      } else if (saves === 3) task = lateGate.promise.then(perform);
      else task = perform();
    } else task = perform();
    copies.push(task);
    return task;
  });
  const h = await observedHarness({
    profiles: [a, b, c],
    activeProfileId: a.id,
    lastActive: { [gameId]: a.id },
    gameSettings: { [gameId]: "repeat A edits" },
    savedSettings: { [b.id]: "repeat B", [c.id]: "repeat C" },
    waitForStartup: false,
  });
  h.api.events.on("profile-will-change", () => {
    switchStarts++;
  });
  try {
    await startupEntered.promise;
    h.api.store.dispatch(setNextProfile(b.id));
    h.api.store.dispatch(setNextProfile(c.id));
    h.api.store.dispatch(setNextProfile(b.id));
    startupGate.resolve();
    await restored.promise;
    lateGate.resolve();
    await h.drain();
    await Promise.all(copies);
    const savedA = await h.savedSettings(a.id);
    const savedC = await h.savedSettings(c.id);
    expect(h.getState().settings.profiles.activeProfileId).toBe(b.id);
    expect(await h.gameSettings(gameId)).toBe("repeat B");
    expect({ savedA, savedC, switchStarts }).toEqual({
      savedA: "repeat A edits",
      savedC: "repeat C",
      switchStarts: 1,
    });
  } finally {
    startupGate.resolve();
    lateGate.resolve();
    await h.drain();
    await Promise.allSettled(copies);
    await h.cleanup();
  }
});
