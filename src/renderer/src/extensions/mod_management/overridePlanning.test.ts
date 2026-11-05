import path from "node:path";

import Bluebird from "bluebird";
import { expect, test, vi } from "vitest";

import { makeApiHarness, makeMod } from "../../test-utils/builders";
import type { IModReference } from "./types/IMod";
import sortMods from "./util/sort";

const plannerPath = path.resolve(
  __dirname,
  "../../../../../extensions/mod-dependency-manager/src/util/fileOverrides.ts",
);
const shared = "/fixture/game/config.ini";

for (const reference of [
  { fileMD5: "target-md5" },
  { logicalFileName: "Target" },
  { tag: "target-tag" },
] satisfies IModReference[]) {
  test(`cross-type ownership follows deployment rules matched by ${Object.keys(reference)[0]}`, async () => {
    const b = makeMod({
      id: "b",
      type: "root",
      installationPath: "b",
      attributes: {
        fileMD5: "target-md5",
        logicalFileName: "Target",
        referenceTag: "target-tag",
        version: "1.0.0",
      },
    });
    const a = makeMod({
      id: "a",
      installationPath: "a",
      rules: [{ type: "before", reference }],
    });
    const h = makeApiHarness();
    h.api.lookupModMeta = vi.fn(() => Bluebird.resolve([]));
    const sorted = await sortMods("skyrimse", [b, a], h.api);
    expect(sorted.map((mod) => mod.id)).toEqual(["a", "b"]);
    const { planOverrideUpdate } = await import(plannerPath);
    const result = planOverrideUpdate(
      { b, a },
      new Set(["a", "b"]),
      {
        a: [{ otherMod: { id: "b" }, files: [shared] }],
        b: [{ otherMod: { id: "a" }, files: [shared] }],
      },
      {},
      sorted.toReversed().map((mod) => mod.id),
    );
    expect(result.changes).toEqual({ a: [shared] });
  });
}

test("cross-type ownership includes load order rules returned by archive metadata", async () => {
  const b = makeMod({
    id: "metadata-b",
    type: "root",
    installationPath: "b",
    attributes: { fileMD5: "metadata-target" },
  });
  const a = makeMod({
    id: "metadata-a",
    installationPath: "a",
    attributes: { fileMD5: "source-md5" },
  });
  const h = makeApiHarness();
  h.api.lookupModMeta = (query) =>
    Bluebird.resolve(
      query.fileMD5 === "source-md5"
        ? [
            {
              key: "fixture",
              value: {
                gameId: "skyrimse",
                fileName: "source.zip",
                fileSizeBytes: 1,
                fileVersion: "1.0.0",
                sourceURI: "https://example.invalid/source",
                fileMD5: "source-md5",
                rules: [{ type: "before", reference: { fileMD5: "metadata-target" } }],
              },
            },
          ]
        : [],
    );
  const sorted = await sortMods("skyrimse", [b, a], h.api);
  expect(sorted.map((mod) => mod.id)).toEqual([a.id, b.id]);
  const { planOverrideUpdate } = await import(plannerPath);
  expect(
    planOverrideUpdate(
      { [b.id]: b, [a.id]: a },
      new Set([a.id, b.id]),
      { [a.id]: [{ otherMod: { id: b.id }, files: [shared] }] },
      {},
      sorted.toReversed().map((mod) => mod.id),
    ).changes,
  ).toEqual({ [a.id]: [shared] });
});

test.each([false, true])(
  "ignored=%s dependency rules do not change file load order",
  async (ignored) => {
    const b = makeMod({ id: "dependency-b", type: "root", installationPath: "b" });
    const a = makeMod({
      id: "dependency-a",
      installationPath: "a",
      rules: [{ type: "requires", reference: { id: b.id }, ignored }],
    });
    const h = makeApiHarness();
    h.api.lookupModMeta = () => Bluebird.resolve([]);
    const sorted = await sortMods("skyrimse", [b, a], h.api);
    const { planOverrideUpdate } = await import(plannerPath);
    expect(
      planOverrideUpdate(
        { [b.id]: b, [a.id]: a },
        new Set([a.id, b.id]),
        { [a.id]: [{ otherMod: { id: b.id }, files: [shared] }] },
        {},
        sorted.toReversed().map((mod) => mod.id),
      ).changes,
    ).toEqual({ [b.id]: [shared] });
  },
);
