import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Bluebird from "bluebird";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { log } from "@/logging";
import type { IGame } from "@/types/IGame";
import { GameEntryNotFound } from "@/types/IGameStore";
import type { ITool } from "@/types/ITool";

import { quickDiscovery, quickDiscoveryTools } from "./discovery";

vi.mock("@/logging", () => ({ log: vi.fn() }));
vi.mock("./getGame", () => ({
  getGameStores: () => [],
  getGameStoresSafe: () => [],
}));

const makeGame = (queryPath: () => unknown): IGame => ({
  id: "fixture",
  name: "Fixture game",
  executable: () => "FixtureBinary",
  requiredFiles: ["FixtureBinary"],
  queryModPath: () => ".",
  queryPath: queryPath as IGame["queryPath"],
});

const missingQueries = [
  { name: "undefined", query: () => undefined },
  { name: "resolved undefined", query: () => Bluebird.resolve(undefined) },
  {
    name: "rejected missing entry",
    query: () => Bluebird.reject(new GameEntryNotFound("fixture", "steam")),
  },
  {
    name: "thrown missing entry",
    query: () => {
      throw new GameEntryNotFound("fixture", "steam");
    },
  },
];

const brokenQueries = [
  { name: "rejection", query: () => Bluebird.reject(new Error("Fixture plugin failed")) },
  {
    name: "exception",
    query: () => {
      throw new Error("Fixture plugin failed");
    },
  },
];

let directory: string;

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(path.join(os.tmpdir(), "nyastra-discovery-"));
  await writeFile(path.join(directory, "FixtureBinary"), "fixture");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const expectNoFailures = () => {
  expect(
    vi.mocked(log).mock.calls.filter(([level]) => level === "error" || level === "warn"),
  ).toEqual([]);
};

describe("game discovery misses", () => {
  test.for(missingQueries)(
    "handles $name without reporting a plugin failure",
    async ({ query }) => {
      const discoveredGame = vi.fn();
      const discoveredTool = vi.fn();

      expect(await quickDiscovery([makeGame(query)], {}, discoveredGame, discoveredTool)).toEqual(
        [],
      );

      expect(discoveredGame).not.toHaveBeenCalled();
      expect(discoveredTool).not.toHaveBeenCalled();
      expectNoFailures();
    },
  );

  test.for(brokenQueries)(
    "reports an unexpected $name and still discovers other games",
    async ({ query }) => {
      const discoveredGame = vi.fn();
      const installed = { ...makeGame(() => directory), id: "installed" };

      expect(
        await quickDiscovery([makeGame(query), installed], {}, discoveredGame, vi.fn()),
      ).toEqual(["installed"]);

      expect(discoveredGame).toHaveBeenCalledExactlyOnceWith("installed", {
        path: directory,
        executable: undefined,
        store: undefined,
      });
      expect(log).toHaveBeenCalledWith(
        "error",
        "failed to use game support plugin",
        expect.objectContaining({ id: "fixture", err: "Fixture plugin failed" }),
      );
    },
  );
});

describe("tool discovery misses", () => {
  test.for(missingQueries)("handles $name without reporting a tool failure", async ({ query }) => {
    const discoveredTool = vi.fn();
    const tool: ITool = { ...makeGame(query), name: "Fixture tool" };

    await quickDiscoveryTools("fixture", [tool], discoveredTool);

    expect(discoveredTool).not.toHaveBeenCalled();
    expectNoFailures();
  });

  test.for(brokenQueries)("reports an unexpected tool $name", async ({ query }) => {
    const discoveredTool = vi.fn();

    await quickDiscoveryTools("fixture", [makeGame(query)], discoveredTool);

    expect(discoveredTool).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "error",
      "failed to determine tool setup",
      expect.objectContaining({ toolId: "fixture" }),
    );
  });

  test("discovers an installed tool alongside a missing one", async () => {
    const discoveredTool = vi.fn();

    await quickDiscoveryTools(
      "fixture",
      [
        makeGame(() => Bluebird.reject(new GameEntryNotFound("missing", "steam"))),
        { ...makeGame(() => directory), id: "installed-tool" },
      ],
      discoveredTool,
    );

    expect(discoveredTool).toHaveBeenCalledExactlyOnceWith(
      "fixture",
      expect.objectContaining({
        id: "installed-tool",
        path: path.join(directory, "FixtureBinary"),
        hidden: false,
      }),
    );
    expectNoFailures();
  });

  test("reports an invalid callback result", async () => {
    await quickDiscoveryTools("fixture", [makeGame(() => 42)], vi.fn());

    expect(log).toHaveBeenCalledWith(
      "error",
      "failed to determine tool setup",
      expect.objectContaining({ err: expect.objectContaining({ message: "Invalid return type" }) }),
    );
  });
});
