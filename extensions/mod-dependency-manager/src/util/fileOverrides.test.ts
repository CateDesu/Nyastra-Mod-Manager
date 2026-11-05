import type { types } from "@nexusmods/vortex-api";
import { expect, test } from "vitest";

import type { IConflict } from "../types/IConflict";
import { planOverrideUpdate } from "./fileOverrides";

const shared = "/fixture/game/config.ini";
const second = "/fixture/game/second.ini";

function mod(id: string, type: string, extra: Partial<types.IMod> = {}): types.IMod {
  return { id, type, state: "installed", installationPath: id, attributes: { name: id }, ...extra };
}

function conflict(id: string, files = [shared]): IConflict {
  return {
    otherMod: { id, fileMD5: "", fileSizeBytes: 0, fileName: id, version: "1" },
    files,
    suggestion: null,
  };
}

const conflicts = { a: [conflict("b")], b: [conflict("a")] };

test.each(["before", "after"] as const)("honors a %s rule across mod types", (type) => {
  const mods = {
    b: mod("b", "root"),
    a: mod("a", "", { rules: [{ type, reference: { id: "b" } }] }),
  };
  const { changes, purgeFirst } = planOverrideUpdate(mods, new Set(["a", "b"]), conflicts);
  const owner = type === "before" ? "b" : "a";
  const loser = owner === "a" ? "b" : "a";
  expect(changes).toEqual({ [loser]: [shared] });
  expect(purgeFirst).toBe(true);
  expect(mods.a.fileOverrides).toBeUndefined();
});

test("retains an explicit file winner despite an opposite load order", () => {
  const mods = {
    a: mod("a", "", { rules: [{ type: "before", reference: { id: "b" } }] }),
    b: mod("b", "root", { fileOverrides: [shared] }),
  };
  expect(planOverrideUpdate(mods, new Set(["a", "b"]), conflicts)).toEqual({
    changes: {},
    purgeFirst: false,
  });
});

test("resolves a file excluded by both mod types", () => {
  const mods = {
    a: mod("a", "", { fileOverrides: [shared] }),
    b: mod("b", "root", { fileOverrides: [shared] }),
  };
  expect(planOverrideUpdate(mods, new Set(["a", "b"]), conflicts)).toEqual({
    changes: { b: [] },
    purgeFirst: true,
  });
});

test("applies manual ownership edits together before planning", () => {
  const mods = {
    a: mod("a", "", { fileOverrides: [shared] }),
    b: mod("b", "root"),
  };
  expect(planOverrideUpdate(mods, new Set(["a", "b"]), conflicts, { a: [], b: [shared] })).toEqual({
    changes: { a: [], b: [shared] },
    purgeFirst: true,
  });
});

test("keeps exclusions for multiple shared files", () => {
  const mods = {
    a: mod("a", ""),
    b: mod("b", "root", { rules: [{ type: "after", reference: { id: "a" } }] }),
    c: mod("c", "other", { rules: [{ type: "after", reference: { id: "a" } }] }),
  };
  const result = planOverrideUpdate(mods, new Set(["a", "b", "c"]), {
    a: [conflict("b"), conflict("c", [second])],
    b: [conflict("a")],
    c: [conflict("a", [second])],
  });
  expect(result.changes).toEqual({ a: [shared, second] });
  expect(result.purgeFirst).toBe(true);
});

test("uses rules through a mod that does not share the file", () => {
  const mods = {
    b: mod("b", "root"),
    a: mod("a", "", { rules: [{ type: "before", reference: { id: "middle" } }] }),
    middle: mod("middle", "", { rules: [{ type: "before", reference: { id: "b" } }] }),
  };
  expect(planOverrideUpdate(mods, new Set(Object.keys(mods)), conflicts).changes).toEqual({
    a: [shared],
  });
});

test("restores the remaining owner after the other mod type is disabled", () => {
  const mods = {
    a: mod("a", "", { fileOverrides: [shared] }),
    b: mod("b", "root"),
  };
  expect(planOverrideUpdate(mods, new Set(["a"]), conflicts)).toEqual({
    changes: { a: [] },
    purgeFirst: true,
  });
});

test("same-type load order needs no exclusions or purge", () => {
  const mods = { a: mod("a", ""), b: mod("b", "") };
  expect(planOverrideUpdate(mods, new Set(["a", "b"]), conflicts)).toEqual({
    changes: {},
    purgeFirst: false,
  });
});

test("same-type manual edits retain one owner without a purge", () => {
  const mods = { a: mod("a", "", { fileOverrides: [shared] }), b: mod("b", "") };
  expect(planOverrideUpdate(mods, new Set(["a", "b"]), conflicts, { a: [], b: [shared] })).toEqual({
    changes: { a: [], b: [shared] },
    purgeFirst: false,
  });
});

test("ignores an edit for a removed mod", () => {
  expect(planOverrideUpdate({}, new Set(), {}, { removed: [shared] })).toEqual({
    changes: {},
    purgeFirst: false,
  });
});

test("purges before restoring exclusions after conflict discovery drops a disabled owner", () => {
  const mods = {
    a: mod("a", "", { fileOverrides: [shared] }),
    b: mod("b", "root"),
  };
  expect(planOverrideUpdate(mods, new Set(["a"]), {})).toEqual({
    changes: { a: [] },
    purgeFirst: true,
  });
});

test("retains different manual winners for multiple files shared by three types", () => {
  const mods = {
    a: mod("a", "", { fileOverrides: [shared, second] }),
    b: mod("b", "root", { fileOverrides: [second] }),
    c: mod("c", "other", { fileOverrides: [shared] }),
  };
  expect(
    planOverrideUpdate(mods, new Set(Object.keys(mods)), {
      a: [conflict("b", [shared, second]), conflict("c", [shared, second])],
      b: [conflict("a", [shared, second]), conflict("c", [shared, second])],
      c: [conflict("a", [shared, second]), conflict("b", [shared, second])],
    }),
  ).toEqual({ changes: {}, purgeFirst: false });
});
