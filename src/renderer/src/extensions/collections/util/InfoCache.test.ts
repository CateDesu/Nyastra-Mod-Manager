import type Nexus from "@nexusmods/nexus-api";
import type { ICollection, IRevision } from "@nexusmods/nexus-api";
import Bluebird from "bluebird";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeApiHarness } from "../../../test-utils/builders";
import type { IExtensionApi } from "../../../types/IExtensionContext";
import {
  onGetNexusCollection,
  onGetNexusCollectionRevision,
} from "../../nexus_integration/eventHandlers";
import { CACHE_EXPIRE_MS } from "../constants";
import persistentReducer from "../reducers/persistent";
import InfoCache from "./InfoCache";

const first = { id: 123, slug: "cache-fixture", name: "First collection" } as ICollection;
const second = { ...first, name: "Updated collection" };

afterEach(() => vi.restoreAllMocks());

function setup() {
  const harness = makeApiHarness({}, [
    { path: ["persistent", "collections"], reducer: persistentReducer },
  ]);
  const getCollectionGraph = vi.fn().mockImplementation(() => Bluebird.resolve(first));
  const getCollectionRevisionGraph = vi
    .fn()
    .mockImplementation(() =>
      Bluebird.resolve({ id: 456, revisionNumber: 2, collection: second } as IRevision),
    );
  const nexus = { getCollectionGraph, getCollectionRevisionGraph } as unknown as Nexus;
  const collection = onGetNexusCollection(harness.api, nexus);
  const revision = onGetNexusCollectionRevision(harness.api, nexus);
  harness.api.emitAndAwait = (async (event: string, ...args: unknown[]) => {
    if (event === "get-nexus-collection") return [await collection(args[0] as string)];
    if (event === "get-nexus-collection-revision") {
      return [await revision(args[0] as string, args[1] as number)];
    }
    throw new Error(`Unexpected event: ${event}`);
  }) as IExtensionApi["emitAndAwait"];
  return { ...harness, getCollectionGraph, getCollectionRevisionGraph };
}

describe("collection metadata cache lifecycle", () => {
  it("rehydrates a collection from persisted numeric keys while offline", async () => {
    const harness = setup();
    await new InfoCache(harness.api).getCollectionInfo(first.slug);
    expect(harness.getState().persistent.collections.collections["123"].info).toEqual(first);
    harness.getCollectionGraph.mockImplementation(() => Bluebird.reject(new Error("offline")));

    const result = await new InfoCache(harness.api).getCollectionInfo(first.slug);

    expect(result).toEqual(first);
    expect(harness.getCollectionGraph).toHaveBeenCalledTimes(1);
    expect(harness.errorNotifications).toEqual([]);
  });

  it("fetches current metadata when a completed request is forcibly refreshed", async () => {
    const harness = setup();
    const cache = new InfoCache(harness.api);
    expect(await cache.getCollectionInfo(first.slug)).toEqual(first);
    harness.getCollectionGraph.mockImplementation(() => Bluebird.resolve(second));

    expect(await cache.getCollectionInfo(first.slug, true)).toEqual(second);
    expect(harness.getCollectionGraph).toHaveBeenCalledTimes(2);
    expect(harness.getState().persistent.collections.collections["123"].info).toEqual(second);
  });

  it("refreshes expired collection metadata", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const harness = setup();
    const cache = new InfoCache(harness.api);
    await cache.getCollectionInfo(first.slug);
    now += CACHE_EXPIRE_MS + 1;
    harness.getCollectionGraph.mockImplementation(() => Bluebird.resolve(second));

    expect(await cache.getCollectionInfo(first.slug)).toEqual(second);
    expect(harness.getCollectionGraph).toHaveBeenCalledTimes(2);
  });

  it("retries after the real Nexus handler reports a network failure", async () => {
    const harness = setup();
    const error = Object.assign(new Error("network disconnected"), { code: "ECONNRESET" });
    harness.getCollectionGraph.mockImplementationOnce(() => Bluebird.reject(error));
    const cache = new InfoCache(harness.api);

    expect(await cache.getCollectionInfo(first.slug)).toBeUndefined();
    expect(harness.errorNotifications).toContainEqual(expect.objectContaining({ message: error }));
    expect(await cache.getCollectionInfo(first.slug)).toEqual(first);
    expect(harness.getCollectionGraph).toHaveBeenCalledTimes(2);
  });

  it("allows a corrected revision request after parameter rejection", async () => {
    const harness = setup();
    const cache = new InfoCache(harness.api);

    await expect(cache.getRevisionInfo(456, first.slug, NaN)).rejects.toThrow(
      "revisionNumber has to be a number",
    );
    expect(await cache.getRevisionInfo(456, first.slug, 2)).toMatchObject({
      id: 456,
      revisionNumber: 2,
      collection: second,
    });
    expect(harness.getCollectionRevisionGraph).toHaveBeenCalledTimes(1);
  });

  it("rehydrates a cached revision with its full persisted collection", async () => {
    const harness = setup();
    const cache = new InfoCache(harness.api);
    await cache.getRevisionInfo(456, first.slug, 2);
    harness.getCollectionGraph.mockImplementation(() => Bluebird.reject(new Error("offline")));

    expect(await new InfoCache(harness.api).getRevisionInfo(456, first.slug, 2)).toMatchObject({
      id: 456,
      collection: second,
    });
    expect(harness.getCollectionGraph).not.toHaveBeenCalled();
    expect(harness.getCollectionRevisionGraph).toHaveBeenCalledTimes(1);
  });

  it("coalesces simultaneous requests while keeping other collections independent", async () => {
    const harness = setup();
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.getCollectionGraph.mockImplementation((_query, slug: string) =>
      Bluebird.resolve(gate).then(() =>
        slug === first.slug ? first : { ...second, id: 987, slug },
      ),
    );
    const cache = new InfoCache(harness.api);
    const requests = [
      cache.getCollectionInfo(first.slug),
      cache.getCollectionInfo(first.slug),
      cache.getCollectionInfo("independent"),
    ];
    try {
      expect(harness.getCollectionGraph).toHaveBeenCalledTimes(2);
    } finally {
      release!();
      await Promise.allSettled(requests);
    }
    expect(await Promise.all(requests)).toEqual([
      first,
      first,
      { ...second, id: 987, slug: "independent" },
    ]);
  });
});
