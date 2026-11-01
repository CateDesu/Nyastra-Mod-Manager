import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, vi } from "vitest";

import { sessionReducer } from "../../reducers/session";
import { flushAsync } from "../../test-utils/async";
import {
  makeGameHarness,
  makeLoadOrder,
  makeLoadOrderGameInfo,
  makeProfile,
} from "../../test-utils/builders";
import { test } from "../../test-utils/harnessTest";
import { profilesReducer } from "../profile_management/reducers/profiles";
import { setFBLoadOrder } from "./actions/loadOrder";
import { LoadOrderRegistry } from "./gameSupport";
import { onStartUp, registerLoadOrderHandlers } from "./handlers";
import { REDUCER_BINDINGS } from "./reducers/bindings";
import { loadOrderForProfile } from "./selectors";
import type { LoadOrder } from "./types/types";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const ids = (order: LoadOrder) => order.map((entry) => entry.id);

function makeHarness() {
  const h = makeGameHarness({}, [
    ...REDUCER_BINDINGS,
    { path: ["persistent", "profiles"], reducer: profilesReducer },
    { path: ["session", "base"], reducer: sessionReducer },
  ]);
  const work: Promise<unknown>[] = [];
  const track = (result: unknown) => {
    if (result instanceof Promise || typeof (result as PromiseLike<unknown>)?.then === "function") {
      const actual = Promise.resolve(result);
      work.push(actual);
      void actual.catch(() => undefined);
    }
    return result;
  };
  const onStateChange = h.api.onStateChange.bind(h.api);
  vi.spyOn(h.api, "onStateChange").mockImplementation((statePath, cb) =>
    onStateChange(statePath, (previous, current) => {
      track(cb(previous, current));
    }),
  );
  const registry = new LoadOrderRegistry();
  registerLoadOrderHandlers(h.api, registry);
  return {
    ...h,
    registry,
    track,
    order: (profileId = h.profileId, loadOrderId?: string) =>
      loadOrderForProfile(h.getState(), profileId, loadOrderId),
    register: (overrides: Parameters<typeof makeLoadOrderGameInfo>[0]) =>
      registry.addInline(makeLoadOrderGameInfo({ gameId: h.gameId, ...overrides })),
    drain: async () => {
      for (let round = 0; round < 100; round++) {
        const count = work.length;
        const settled = await Promise.allSettled(work);
        expect(settled.filter((result) => result.status === "rejected")).toEqual([]);
        await flushAsync();
        if (count === work.length) return;
      }
      throw new Error("Load order handlers did not settle");
    },
  };
}

afterEach(() => vi.restoreAllMocks());

for (const loadOrderId of [undefined, "redmod"]) {
  test(`startup reads an empty profile from disk ${loadOrderId ?? "primary"}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loadorder-startup-"));
    const target = path.join(root, "order.json");
    const h = makeHarness();
    const order = makeLoadOrder("disk-entry");
    await fs.writeFile(target, JSON.stringify(order));
    h.register({
      loadOrderId,
      deserializeLoadOrder: async () => JSON.parse(await fs.readFile(target, "utf8")),
    });
    try {
      expect(await onStartUp(h.api, h.registry, h.gameId, loadOrderId)).toEqual(order);
      await h.drain();
      expect(h.order(h.profileId, loadOrderId)).toEqual([]);
      expect(h.errorNotifications).toEqual([]);
    } finally {
      await h.drain();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("named orders that share a physical file also share the queue", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loadorder-shared-"));
  const target = path.join(root, "order.json");
  const h = makeHarness();
  const entered = deferred();
  const release = deferred();
  const first = makeLoadOrder("first");
  const last = makeLoadOrder("last");
  let concurrent = 0;
  let maximum = 0;
  const serialize = async (order: LoadOrder) => {
    maximum = Math.max(maximum, ++concurrent);
    try {
      if (order === first) {
        entered.resolve();
        await release.promise;
      }
      await fs.writeFile(target, JSON.stringify(order));
    } finally {
      concurrent--;
    }
  };
  h.register({ loadOrderId: "one", serializeLoadOrder: serialize });
  h.register({ loadOrderId: "two", serializeLoadOrder: serialize });
  try {
    h.api.store.dispatch(setFBLoadOrder(h.profileId, first, "one"));
    await entered.promise;
    h.api.store.dispatch(setFBLoadOrder(h.profileId, last, "two"));
    await flushAsync();
    release.resolve();
    await h.drain();
    expect(maximum).toBe(1);
    expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual(last);
    expect(h.order(h.profileId, "one")).toEqual(first);
    expect(h.order(h.profileId, "two")).toEqual(last);
  } finally {
    release.resolve();
    await h.drain();
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const loadOrderId of [undefined, "redmod"]) {
  for (const overlap of [false, true]) {
    test(`disk retains latest edit ${loadOrderId ?? "primary"}, overlap=${overlap}`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "loadorder-queue-"));
      const target = path.join(root, "order.json");
      const h = makeHarness();
      const entered = deferred();
      const release = deferred();
      const initial = makeLoadOrder("a.pak", "b.pak", "c.pak");
      const first = makeLoadOrder("b.pak", "a.pak", "c.pak");
      const last = makeLoadOrder("c.pak", "b.pak", "a.pak");
      let concurrent = 0;
      let maximum = 0;
      const serialize = vi.fn(async (order: LoadOrder) => {
        maximum = Math.max(maximum, ++concurrent);
        try {
          if (ids(order).join() === ids(first).join()) {
            entered.resolve();
            await release.promise;
          }
          await fs.writeFile(target, JSON.stringify(order));
        } finally {
          concurrent--;
        }
      });
      h.register({ loadOrderId, serializeLoadOrder: serialize });
      try {
        h.api.store.dispatch(setFBLoadOrder(h.profileId, initial, loadOrderId));
        await h.drain();
        h.api.store.dispatch(setFBLoadOrder(h.profileId, first, loadOrderId));
        await entered.promise;
        if (!overlap) {
          release.resolve();
          await h.drain();
        }
        h.api.store.dispatch(setFBLoadOrder(h.profileId, last, loadOrderId));
        await flushAsync();
        release.resolve();
        await h.drain();
        expect(maximum).toBe(1);
        expect(concurrent).toBe(0);
        expect(serialize).toHaveBeenCalledTimes(3);
        expect(h.order(h.profileId, loadOrderId)).toEqual(last);
        expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual(last);
        expect(h.errorNotifications).toEqual([]);
      } finally {
        release.resolve();
        await h.drain();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
}

test("a failed write releases the game file for the next edit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loadorder-retry-"));
  const target = path.join(root, "order.json");
  const h = makeHarness();
  const entered = deferred();
  const release = deferred();
  const first = makeLoadOrder("first");
  const last = makeLoadOrder("last");
  const serialize = vi.fn(async (order: LoadOrder) => {
    if (order === first) {
      entered.resolve();
      await release.promise;
      throw new Error("Fixture write failed");
    }
    await fs.writeFile(target, JSON.stringify(order));
  });
  h.register({ serializeLoadOrder: serialize });
  try {
    h.api.store.dispatch(setFBLoadOrder(h.profileId, first));
    await entered.promise;
    h.api.store.dispatch(setFBLoadOrder(h.profileId, last));
    release.resolve();
    await h.drain();
    expect(serialize).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual(last);
    expect(h.errorNotifications).toHaveLength(1);
  } finally {
    release.resolve();
    await h.drain();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("profiles using one game file share the write queue and switch barrier", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loadorder-profiles-"));
  const target = path.join(root, "order.json");
  const h = makeHarness();
  const other = makeProfile({ id: "other", gameId: h.gameId });
  h.setState((state) => {
    state.persistent.profiles[other.id] = other;
  });
  const entered = deferred();
  const release = deferred();
  const first = makeLoadOrder("owner-a");
  const last = makeLoadOrder("owner-b");
  let concurrent = 0;
  let maximum = 0;
  h.register({
    serializeLoadOrder: async (order) => {
      maximum = Math.max(maximum, ++concurrent);
      try {
        if (ids(order).join() === "owner-a") {
          entered.resolve();
          await release.promise;
        }
        await fs.writeFile(target, JSON.stringify(order));
      } finally {
        concurrent--;
      }
    },
    deserializeLoadOrder: async () => JSON.parse(await fs.readFile(target, "utf8")),
  });
  try {
    h.api.store.dispatch(setFBLoadOrder(h.profileId, first));
    await entered.promise;
    let switchReady = false;
    h.api.events.emit("profile-will-change", other.id, (cb: () => Promise<void>) => {
      h.track(
        cb().then(() => {
          switchReady = true;
        }),
      );
    });
    await flushAsync();
    expect(switchReady).toBe(false);
    h.setState((state) => {
      state.settings.profiles.activeProfileId = other.id;
      state.settings.profiles.lastActiveProfile[h.gameId] = other.id;
    });
    h.api.store.dispatch(setFBLoadOrder(other.id, last));
    h.track(h.emitAndAwait("profile-did-change", other.id));
    await flushAsync();
    release.resolve();
    await h.drain();
    expect(maximum).toBe(1);
    expect(switchReady).toBe(true);
    expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual(last);
    expect(h.order(other.id)).toEqual(last);
    expect(h.order()).toEqual(first);
    expect(h.errorNotifications).toEqual([]);
  } finally {
    release.resolve();
    await h.drain();
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const reader of ["startup", "tools", "deploy", "purge", "profile"] as const) {
  test(`a delayed ${reader} read cannot replace a newer edit`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loadorder-read-"));
    const target = path.join(root, "order.json");
    const h = makeHarness();
    const entered = deferred();
    const release = deferred();
    const initial = makeLoadOrder("initial");
    const last = makeLoadOrder("last");
    let reading = false;
    let overlappingIO = false;
    let startup: ReturnType<typeof onStartUp>;
    await fs.writeFile(target, JSON.stringify(initial));
    h.register({
      serializeLoadOrder: (order) => {
        overlappingIO ||= reading;
        return fs.writeFile(target, JSON.stringify(order));
      },
      deserializeLoadOrder: async () => {
        const contents: LoadOrder = JSON.parse(await fs.readFile(target, "utf8"));
        reading = true;
        entered.resolve();
        await release.promise;
        reading = false;
        return contents;
      },
    });
    try {
      h.api.store.dispatch(setFBLoadOrder(h.profileId, initial));
      await h.drain();
      if (reader === "tools") {
        h.setState((state) => {
          state.session.base.toolsRunning = { fixture: { pid: 1, exclusive: false, started: 1 } };
        });
        await h.drain();
      }
      if (reader === "startup") {
        startup = onStartUp(h.api, h.registry, h.gameId);
        h.track(startup);
      }
      if (reader === "tools")
        h.setState((state) => {
          state.session.base.toolsRunning = {};
        });
      if (reader === "deploy" || reader === "purge")
        h.track(h.emitAndAwait(`did-${reader}`, h.profileId));
      if (reader === "profile") {
        expect(h.api.events.listenerCount("profile-did-change")).toBeGreaterThan(0);
        h.track(h.emitAndAwait("profile-did-change", h.profileId));
      }
      await entered.promise;
      h.api.store.dispatch(setFBLoadOrder(h.profileId, last));
      await flushAsync();
      release.resolve();
      await h.drain();
      expect(overlappingIO).toBe(false);
      if (reader === "startup") expect(await startup).toBeUndefined();
      expect(h.order()).toEqual(last);
      expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual(last);
      expect(h.errorNotifications).toEqual([]);
    } finally {
      release.resolve();
      await h.drain();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

for (const change of ["switch", "remove", "change-game"] as const) {
  test(`a read cannot update an owner after ${change}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loadorder-read-owner-"));
    const target = path.join(root, "order.json");
    const h = makeHarness();
    const other = makeProfile({ id: "other", gameId: h.gameId });
    h.setState((state) => {
      state.persistent.profiles[other.id] = other;
    });
    await h.drain();
    const entered = deferred();
    const release = deferred();
    const initial = makeLoadOrder("initial");
    const external = makeLoadOrder("external");
    h.register({
      serializeLoadOrder: (order) => fs.writeFile(target, JSON.stringify(order)),
      deserializeLoadOrder: async () => {
        const order: LoadOrder = JSON.parse(await fs.readFile(target, "utf8"));
        entered.resolve();
        await release.promise;
        return order;
      },
    });
    try {
      h.api.store.dispatch(setFBLoadOrder(h.profileId, initial));
      await h.drain();
      await fs.writeFile(target, JSON.stringify(external));
      h.track(h.emitAndAwait("did-purge", h.profileId));
      await entered.promise;
      h.setState((state) => {
        if (change === "switch") {
          state.settings.profiles.activeProfileId = other.id;
          state.settings.profiles.lastActiveProfile[h.gameId] = other.id;
        } else if (change === "remove") delete state.persistent.profiles[h.profileId];
        else state.persistent.profiles[h.profileId].gameId = "other-game";
      });
      release.resolve();
      await h.drain();
      expect(h.order()).toEqual(change === "remove" ? [] : initial);
      expect(h.order(other.id)).toEqual([]);
      expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual(external);
    } finally {
      release.resolve();
      await h.drain();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("late validation cannot put the outgoing profile's error on the active profile", async () => {
  const h = makeHarness();
  const other = makeProfile({ id: "other", gameId: h.gameId });
  h.setState((state) => {
    state.persistent.profiles[other.id] = other;
  });
  await h.drain();
  let release: () => void;
  let entered: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const validations: Promise<unknown>[] = [];
  h.register({
    validate: (_previous, order) => {
      const work = (async () => {
        entered();
        await gate;
        return { invalid: [{ id: order[0].id, reason: "Fixture validation failure" }] };
      })();
      validations.push(work);
      return work;
    },
  });
  try {
    h.api.store.dispatch(setFBLoadOrder(h.profileId, makeLoadOrder("first")));
    await started;
    h.setState((state) => {
      state.settings.profiles.activeProfileId = other.id;
      state.settings.profiles.lastActiveProfile[h.gameId] = other.id;
    });
    release();
    await Promise.all(validations);
    await h.drain();
    expect(h.dispatched.filter((action) => action.type === "SET_FB_VALIDATION_RESULT")).toEqual([]);
    expect(h.errorNotifications).toEqual([]);
  } finally {
    release();
    await Promise.allSettled(validations);
    await h.drain();
  }
});
