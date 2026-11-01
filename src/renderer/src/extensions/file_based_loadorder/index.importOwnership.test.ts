import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import { expect, test, vi } from "vitest";

import { sessionReducer } from "../../reducers/session";
import {
  makeApiHarness,
  makeLoadOrder,
  makeLoadOrderGameInfo,
  makeProfile,
} from "../../test-utils/builders";
import type {
  IExtensionApi,
  IExtensionContext,
  IMainPageOptions,
} from "../../types/IExtensionContext";
import initModManagement from "../mod_management/index";
import { setCurrentProfile } from "../profile_management/actions/settings";
import { settingsReducer } from "../profile_management/reducers/settings";
import { setFBLoadOrder } from "./actions/loadOrder";
import initLoadOrders from "./index";
import { parseLoadOrderFile } from "./loadOrderFile";
import { REDUCER_BINDINGS } from "./reducers/bindings";
import { loadOrderForProfile } from "./selectors";
import type { ILoadOrderGameInfo, LoadOrder } from "./types/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function isWork(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

type ImportProps = { onImportList: (loadOrderId?: string) => Promise<void> };

function isImportProps(value: Record<string, unknown>): value is ImportProps {
  return typeof value.onImportList === "function";
}

function trackWork() {
  const work: Promise<unknown>[] = [];
  const outcomes: Array<Promise<{ status: string; reason?: unknown }>> = [];
  const track = <T>(value: PromiseLike<T>): Promise<T> => {
    const original = Promise.resolve(value);
    work.push(original);
    outcomes.push(
      original.then(
        () => ({ status: "fulfilled" }),
        (reason: unknown) => ({ status: "rejected", reason }),
      ),
    );
    return original;
  };
  const trackResult = (value: unknown) => {
    if (isWork(value)) void track(value);
    return value;
  };
  const drain = async () => {
    let settled: Array<{ status: string; reason?: unknown }> = [];
    let stable = false;
    for (let round = 0; round < 100; round++) {
      const count = work.length;
      settled = await Promise.all(outcomes);
      await new Promise<void>((done) => setImmediate(done));
      if (count === work.length) {
        stable = true;
        break;
      }
    }
    if (!stable) throw new Error("Import handlers did not settle");
    expect(settled.filter((result) => result.status === "rejected")).toEqual([]);
    expect(settled).toHaveLength(work.length);
  };
  return { track, trackResult, drain };
}

test.each([
  { name: "unchanged profile", switched: false },
  { name: "active game and profile changed", switched: true },
])("load order import keeps its initiating profile: $name", async ({ switched }) => {
  expect(initModManagement).toBeTypeOf("function");
  expect(globalThis.Promise).toBe(Bluebird);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loadorder-import-"));
  const a = makeProfile({ id: "import-owner-a", gameId: "import-game-a" });
  const b = makeProfile({ id: "import-owner-b", gameId: "import-game-b" });
  const originalA = makeLoadOrder("original-a");
  const originalB = makeLoadOrder("original-b");
  const selected = makeLoadOrder("selected-for-a");
  const fileA = path.join(root, "game-a.json");
  const fileB = path.join(root, "game-b.json");
  const fileImport = path.join(root, "import.json");
  await fs.writeFile(fileA, JSON.stringify(originalA));
  await fs.writeFile(fileB, JSON.stringify(originalB));
  await fs.writeFile(fileImport, JSON.stringify(selected));
  const h = makeApiHarness(
    {
      profiles: { [a.id]: a, [b.id]: b },
      activeProfileId: a.id,
      lastActiveProfile: { [a.gameId]: a.id, [b.gameId]: b.id },
    },
    [
      ...REDUCER_BINDINGS,
      { path: ["settings", "profiles"], reducer: settingsReducer },
      { path: ["session", "base"], reducer: sessionReducer },
    ],
  );
  h.api.store.dispatch(setFBLoadOrder(a.id, originalA));
  h.api.store.dispatch(setFBLoadOrder(b.id, originalB));
  const { track, trackResult, drain } = trackWork();
  const stateChange = h.api.onStateChange.bind(h.api);
  vi.spyOn(h.api, "onStateChange").mockImplementation((keys, cb) =>
    stateChange(keys, (previous, current) => {
      trackResult(cb(previous, current));
    }),
  );
  const selectionStarted = deferred<void>();
  const selection = deferred<string>();
  const select = vi.fn<IExtensionApi["selectFile"]>(() => {
    selectionStarted.resolve();
    return Bluebird.resolve(track(selection.promise));
  });
  h.api.selectFile = select;
  const callbacks: Array<() => void | PromiseLike<void>> = [];
  let pageProps: IMainPageOptions["props"];
  let addPage: (gameInfo: ILoadOrderGameInfo) => unknown;
  const context: Partial<IExtensionContext> = {
    api: h.api,
    once: (cb) => {
      callbacks.push(cb);
    },
    optional: { registerCollectionFeature: vi.fn<() => void>() },
    registerReducer: vi.fn<IExtensionContext["registerReducer"]>(),
    registerActionCheck: vi.fn<IExtensionContext["registerActionCheck"]>(),
    registerMainPage: (_icon, _title, _component, options) => {
      pageProps = options.props;
    },
    registerAPI: (name, cb) => {
      if (name === "addLoadOrderPage") addPage = cb;
    },
  };
  initLoadOrders(context as IExtensionContext);
  if (addPage === undefined) throw new Error("Load order API was not registered");
  const writes = { a: 0, b: 0 };
  let activeWrites = 0;
  let maximum = 0;
  const serialize = (name: "a" | "b", target: string) => async (order: LoadOrder) => {
    writes[name]++;
    maximum = Math.max(maximum, ++activeWrites);
    try {
      await track(fs.writeFile(target, JSON.stringify(order)));
    } finally {
      activeWrites--;
    }
  };
  addPage(
    makeLoadOrderGameInfo({
      gameId: a.gameId,
      serializeLoadOrder: serialize("a", fileA),
      deserializeLoadOrder: async () =>
        parseLoadOrderFile(await track(fs.readFile(fileA, "utf8"))).entries,
    }),
  );
  addPage(
    makeLoadOrderGameInfo({
      gameId: b.gameId,
      serializeLoadOrder: serialize("b", fileB),
      deserializeLoadOrder: async () =>
        parseLoadOrderFile(await track(fs.readFile(fileB, "utf8"))).entries,
    }),
  );
  callbacks.forEach((cb) => trackResult(cb()));
  const props = pageProps?.();
  if (props === undefined || !isImportProps(props)) {
    throw new Error("Load order page was not registered");
  }
  const expectedA = switched ? originalA : selected;
  try {
    const importing = track(props.onImportList());
    await selectionStarted.promise;
    expect(select).toHaveBeenCalledTimes(1);
    if (switched) {
      h.api.store.dispatch(setCurrentProfile(b.gameId, b.id));
      await track(h.emitAndAwait("profile-did-change", b.id));
    }
    selection.resolve(fileImport);
    await importing;
    await drain();
    const stateA = loadOrderForProfile(h.getState(), a.id);
    const stateB = loadOrderForProfile(h.getState(), b.id);
    const bytesA = await fs.readFile(fileA, "utf8");
    const bytesB = await fs.readFile(fileB, "utf8");
    const success = h.notifications.filter((n) => n.id === "import-load-order");
    expect(h.errorNotifications).toEqual([]);
    expect(activeWrites).toBe(0);
    expect(maximum).toBeLessThanOrEqual(1);
    expect.soft(stateA).toEqual(expectedA);
    expect.soft(stateB).toEqual(originalB);
    expect.soft(parseLoadOrderFile(bytesA).entries).toEqual(expectedA);
    expect.soft(parseLoadOrderFile(bytesB).entries).toEqual(originalB);
    expect.soft(writes).toEqual({ a: switched ? 0 : 1, b: 0 });
    expect.soft(success).toHaveLength(switched ? 0 : 1);
    expect(bytesA).toBe(JSON.stringify(expectedA));
    expect(bytesB).toBe(JSON.stringify(originalB));
    expect(await fs.readFile(fileImport, "utf8")).toBe(JSON.stringify(selected));
    expect(h.getState().settings.profiles.activeProfileId).toBe(switched ? b.id : a.id);
  } finally {
    selection.resolve(fileImport);
    try {
      await drain();
    } finally {
      vi.restoreAllMocks();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
