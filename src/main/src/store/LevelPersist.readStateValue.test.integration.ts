import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, expect, it, vi } from "vitest";

import DuckDBSingleton from "./DuckDBSingleton";
import LevelPersist from "./LevelPersist";
import { normalizeStateBlobs } from "./normalizeStateBlobs";

vi.mock("../logging", () => ({ log: vi.fn() }));

const roots: string[] = [];
const key = ["persistent", "mods", "skyrimse", "retained", "attributes", "name"];

async function open(root: string) {
  const singleton = DuckDBSingleton.getInstance();
  await singleton.initialize(path.resolve(import.meta.dirname, "../../build/duckdb-extensions"));
  const alias = singleton.nextAlias();
  return new LevelPersist(await singleton.attachDatabase(root, alias), alias);
}

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "logical-reader-"));
  roots.push(root);
  const persist = await open(root);
  await persist.setItem(
    key.slice(0, 3),
    JSON.stringify({
      retained: {
        id: "retained",
        state: "installed",
        attributes: {
          name: "Original",
          "literal###name": "keep",
        },
      },
      sibling: { id: "sibling", state: "installed" },
    }),
  );
  await normalizeStateBlobs(persist);
  return { persist, root };
}

afterEach(() => {
  vi.restoreAllMocks();
  DuckDBSingleton.getInstance().close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
  { change: "set", rollback: true },
  { change: "remove", rollback: true },
  { change: "set", rollback: false },
])(
  "read before queued $change keeps its snapshot, rollback $rollback",
  async ({ change, rollback }) => {
    const { persist, root } = await fixture();
    const captured = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const changed = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const nativeRead = persist.connection.runAndReadAll.bind(persist.connection);
    let paused = false;
    vi.spyOn(persist.connection, "runAndReadAll").mockImplementation(async (sql, ...args) => {
      const result = await nativeRead(sql, ...args);
      if (!paused && sql.includes("WHERE key IN")) {
        paused = true;
        captured.resolve();
        await resume.promise;
      }
      return result;
    });
    const events: string[] = [];
    const read = persist.readStateValue(key).then((value) => {
      events.push("read");
      return value;
    });
    await captured.promise;
    const writer = persist
      .withTransaction(async () => {
        events.push("writer");
        if (change === "remove") await persist.removeItem(key);
        else await persist.setItem(key, '"Changed"');
        changed.resolve();
        await finish.promise;
        if (rollback) throw new Error("cancel writer");
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    let observed: unknown;
    try {
      // Give a broken queue time to write, without waiting forever on a correct queue.
      await Promise.race([changed.promise, delay(100)]);
      resume.resolve();
      observed = await read;
    } finally {
      resume.resolve();
      finish.resolve();
      await writer;
    }
    expect(await writer).toEqual(rollback ? new Error("cancel writer") : undefined);
    vi.restoreAllMocks();
    await persist.close();
    const reopened = await open(root);
    expect(await reopened.readStateValue(key)).toBe(rollback ? "Original" : "Changed");
    expect(await reopened.readStateValue([...key.slice(0, -1), "literal###name"])).toBe("keep");
    await reopened.close();
    expect(observed).toBe("Original");
    expect(events).toEqual(["read", "writer"]);
  },
);

it.each([true, false])("read after queued writer waits, rollback %s", async (rollback) => {
  const { persist } = await fixture();
  const changed = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const writer = persist
    .withTransaction(async () => {
      await persist.setItem(key, '"Changed"');
      changed.resolve();
      await finish.promise;
      if (rollback) throw new Error("cancel writer");
    })
    .catch((error: unknown) => error);
  await changed.promise;
  let settled = false;
  const read = persist.readStateValue(key).then((value) => {
    settled = true;
    return value;
  });
  try {
    await delay(20);
    expect(settled).toBe(false);
  } finally {
    finish.resolve();
    await writer;
  }
  expect(await read).toBe(rollback ? "Original" : "Changed");
  await persist.close();
});

it("owning transaction can read and nest writes while another writer is queued", async () => {
  const { persist } = await fixture();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const owner = persist
    .withTransaction(async () => {
      await persist.setItem(key, '"Owned"');
      entered.resolve();
      await resume.promise;
      expect(await persist.readStateValue(key)).toBe("Owned");
      await persist.withTransaction(async () => {
        expect(await persist.readStateValue(key)).toBe("Owned");
      });
      throw new Error("rollback owner");
    })
    .catch((error: unknown) => error);
  await entered.promise;
  const other = persist.setItem(key, '"Other"');
  resume.resolve();
  expect(await owner).toEqual(new Error("rollback owner"));
  await other;
  expect(await persist.readStateValue(key)).toBe("Other");
  await persist.close();
});

it("a failed logical read releases the queue for later writes and reads", async () => {
  const { persist } = await fixture();
  vi.spyOn(persist.connection, "runAndReadAll").mockRejectedValueOnce(new Error("read failure"));
  await expect(persist.readStateValue(key)).rejects.toThrow("read failure");
  await persist.setItem(key, '"Later"');
  expect(await persist.readStateValue(key)).toBe("Later");
  await persist.close();
});
