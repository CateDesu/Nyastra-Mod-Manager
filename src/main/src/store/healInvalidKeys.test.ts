import { expect, it, vi } from "vitest";

import { healInvalidKeys } from "./healInvalidKeys";
import type LevelPersist from "./LevelPersist";

vi.mock("../logging", () => ({ log: vi.fn() }));

it("preserves the exact clean prefix row while removing corrupt descendants", async () => {
  const prefix = ["persistent", "mods", "skyrimse"];
  const original = [
    { key: prefix, value: '{"retained":"parent blob"}' },
    { key: [...prefix, "healthy", "enabled"], value: "true" },
    { key: [...prefix, "bad\ufffd", "enabled"], value: "false" },
    { key: ["settings", "window", "width"], value: "800" },
  ];
  let rows = structuredClone(original);
  const persist = {
    getAllKeys: () => Promise.resolve(rows.map((row) => row.key)),
    getAllKVs: () => Promise.resolve(structuredClone(rows)),
    beginTransaction: vi.fn(async () => {}),
    commitTransaction: vi.fn(async () => {}),
    rollbackTransaction: vi.fn(async () => {}),
    replaceRawRows: (key: string[], items: typeof rows) => {
      rows = rows.filter((row) => !key.every((segment, i) => row.key[i] === segment));
      rows.push(...items);
      return Promise.resolve();
    },
  };

  const result = await healInvalidKeys(persist as unknown as LevelPersist);
  expect(rows).toEqual(expect.arrayContaining([original[0], original[1], original[3]]));
  expect(rows).toHaveLength(3);
  expect(result).toMatchObject({ removed: 1, rewritten: 2 });
  expect(persist.commitTransaction).toHaveBeenCalledOnce();
  expect(persist.rollbackTransaction).not.toHaveBeenCalled();
  await expect(healInvalidKeys(persist as unknown as LevelPersist)).resolves.toMatchObject({
    removed: 0,
    rewritten: 0,
  });
});
