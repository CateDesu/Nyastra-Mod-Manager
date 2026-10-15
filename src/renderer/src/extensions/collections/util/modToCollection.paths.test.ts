import { access, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import Bluebird from "bluebird";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  makeApiHarness,
  makeMod,
  makeProfile,
  makeRule,
  registerHarnessGame,
  resetHarnessRegistries,
} from "../../../test-utils/builders";
import { scanForDiffs } from "./binaryPatching";
import { modToCollection } from "./modToCollection";

vi.mock("./binaryPatching", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanForDiffs: vi.fn(() => Promise.resolve({})),
}));
vi.mock("./gameSupport", () => ({ generateGameSpecifics: () => Promise.resolve({}) }));
vi.mock("./extension", () => ({ findExtensions: () => [] }));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nyastra-export-paths-"));
  registerHarnessGame("skyrimse");
});
afterEach(async () => {
  vi.clearAllMocks();
  resetHarnessRegistries();
  await rm(root, { recursive: true, force: true });
});

async function exportMember(name: string) {
  const member = makeMod({
    id: "member",
    installationPath: "member",
    attributes: { name, source: "nexus", modId: 1, fileId: 2, version: "1.0.0" },
  });
  const collection = makeMod({
    id: "collection",
    installationPath: "collection",
    rules: [makeRule({ reference: { id: "member", versionMatch: "*" } })],
    attributes: { name: "Collection", collection: { saveEdits: { member: true } } },
  });
  const mods = { member, collection };
  const h = makeApiHarness({
    mods: { skyrimse: mods },
    profiles: { p: makeProfile({ id: "p", gameId: "skyrimse", name: "Profile" }) },
    activeProfileId: "p",
    installPath: { skyrimse: root },
  });
  const onError = vi.fn();
  h.api.lookupModMeta = vi.fn(() => Bluebird.resolve([]));
  const result = await modToCollection(
    h.api,
    "skyrimse",
    root,
    collection,
    mods,
    () => undefined,
    onError,
  );
  return { result, onError };
}

it("does not create a patch folder outside the collection for an unsafe display name", async () => {
  const { onError } = await exportMember("../../escaped");
  await expect(access(path.join(root, "escaped"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(scanForDiffs).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ error: expect.stringContaining("Invalid collection patch path") }),
    true,
  );
});

it("keeps valid display names and their patch folder unchanged", async () => {
  const { result, onError } = await exportMember("Normal Member");
  expect(onError).not.toHaveBeenCalled();
  expect(scanForDiffs).toHaveBeenCalledWith(
    expect.anything(),
    "skyrimse",
    "member",
    path.join(root, "collection", "patches", "Normal Member"),
    expect.any(Function),
  );
  expect(result.mods[0].name).toBe("Normal Member");
});
