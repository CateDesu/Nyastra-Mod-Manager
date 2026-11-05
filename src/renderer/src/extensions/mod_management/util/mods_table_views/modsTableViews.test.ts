import { describe, expect, it } from "vitest";

import { collectionsByMod } from "../../../collections/util/collectionsByMod";
import type { IModWithState } from "../../types/IModProps";
import { allModRows, groupMods, sharedMods } from "./modsTableViews";

const t = ((key: string) => key) as Parameters<typeof groupMods>[2];

const mod = (id: string, name: string, extra: object = {}) =>
  ({ id, enabled: true, attributes: { name }, ...extra }) as unknown as IModWithState;

const collection = (id: string, name: string, memberIds: string[]) =>
  mod(id, name, {
    type: "collection",
    rules: memberIds.map((memberId) => ({ type: "requires", reference: { id: memberId } })),
  });

// Beta is only Xenon's; Gamma is Xenon's and Yttrium's and Zinc's; Alpha is in none.
const MODS = {
  a: mod("a", "Alpha"),
  b: mod("b", "Beta"),
  c: mod("c", "Gamma"),
  x: collection("x", "Xenon", ["b", "c"]),
  y: collection("y", "Yttrium", ["c"]),
  z: collection("z", "Zinc", ["c"]),
};

const group = (id: string) => groupMods(MODS, "collection", t).find((g) => g.id === id);

describe("sharedMods", () => {
  it("finds a collection's mods other collections have too, and names those, by name", () => {
    const shared = sharedMods(group("x"), collectionsByMod(MODS));

    expect(shared.rows.map(({ mod }) => mod.id)).toEqual(["c"]);
    expect(shared.collections).toEqual(["Yttrium", "Zinc"]);
  });

  it("counts any collection for a group that isn't one", () => {
    const authorGroup = { id: "author:Ann", label: "Ann", rows: group("x").rows };

    expect(sharedMods(authorGroup, collectionsByMod(MODS)).collections).toEqual([
      "Xenon",
      "Yttrium",
      "Zinc",
    ]);
  });

  it("finds none for the mods in no collection", () => {
    expect(sharedMods(group("no-collection"), collectionsByMod(MODS)).rows).toEqual([]);
  });
});

describe("groupMods by a column", () => {
  const category = {
    id: "category",
    header: "Category",
    groupBy: ({ mod }: { mod: IModWithState }) => String(mod.attributes?.category ?? ""),
  };

  const CATEGORISED = {
    a: mod("a", "Alpha", { attributes: { name: "Alpha", category: "Weapons" } }),
    b: mod("b", "Beta", { attributes: { name: "Beta", category: "Armour" } }),
    c: mod("c", "Gamma", { attributes: { name: "Gamma", category: "Weapons" } }),
    d: mod("d", "Delta"),
  };

  it("groups the mods without a value first, then by each value, by name", () => {
    const groups = groupMods(CATEGORISED, "category", t, category);

    expect(groups.map(({ id, label, rows }) => [id, label, rows.map((row) => row.name)])).toEqual([
      ["no-category", "No {{column}}", ["Delta"]],
      ["category:Armour", "Armour", ["Beta"]],
      ["category:Weapons", "Weapons", ["Alpha", "Gamma"]],
    ]);
  });

  it("leaves the mods ungrouped without the column it names", () => {
    expect(groupMods(CATEGORISED, "category", t)).toBeUndefined();
    expect(groupMods(CATEGORISED, "none", t, category)).toBeUndefined();
  });
});

describe("nameless mods and collections", () => {
  it("labels an archive with empty name fields and an empty installation path by its id", () => {
    const archive = mod("archive", "", { installationPath: "" });
    expect(allModRows({ archive })[0].name).toBe("archive");
  });

  it("sorts a mod without attributes by its id", () => {
    const nameless = { id: "dl-1", enabled: false } as unknown as IModWithState;
    expect(
      allModRows({ b: mod("b", "Beta"), n: nameless, a: mod("a", "Alpha") }).map(
        ({ name }) => name,
      ),
    ).toEqual(["Alpha", "Beta", "dl-1"]);
  });

  it("uses the id when all name fields are empty", () => {
    expect(allModRows({ n: mod("n", ""), a: mod("a", "Alpha") }).map(({ name }) => name)).toEqual([
      "Alpha",
      "n",
    ]);
  });

  it("labels and sorts a collection with no name by its id", () => {
    const mods = { ...MODS, y: collection("y", "", ["c"]) };
    expect(groupMods(mods, "collection", t).map(({ label }) => label)).toEqual([
      "No collection",
      "Xenon",
      "y",
      "Zinc",
    ]);
    expect(sharedMods(group("x"), collectionsByMod(mods)).collections).toEqual(["y", "Zinc"]);
  });
});
