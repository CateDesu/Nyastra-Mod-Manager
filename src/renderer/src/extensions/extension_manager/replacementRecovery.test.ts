import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import type { IExtensionState } from "../../types/IState";
import { recordReplacement, recoverReplacements, releaseReplacement } from "./replacementRecovery";

let root: string;
let destination: string;
let previous: string;
let candidate: string;
let old: IExtensionState;
let next: IExtensionState;
let journal: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "nyastra-replacement-"));
  destination = path.join(root, "example");
  previous = path.join(root, ".extension.bak-old");
  candidate = path.join(root, ".extension-next.installing");
  for (const [directory, bytes] of [
    [destination, "old"],
    [candidate, "new"],
  ]) {
    mkdirSync(directory);
    writeFileSync(path.join(directory, "index.js"), bytes);
  }
  old = {
    name: "example",
    version: "1",
    path: destination,
    enabled: true,
    remove: false,
    author: "Fixture",
    description: "",
    endorsed: "Undecided",
    modId: 1,
    fileId: 1,
  };
  next = { ...old, version: "2", fileId: 2 };
  journal = recordReplacement(root, destination, previous, candidate, { example: old }, next);
  releaseReplacement(journal);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const bytes = (directory: string) => readFileSync(path.join(directory, "index.js"), "utf8");
it.each(["prepared", "old-aside", "published"])(
  "restores catalog version after %s and repeated recovery",
  (boundary) => {
    if (boundary !== "prepared") renameSync(destination, previous);
    if (boundary === "published") renameSync(candidate, destination);
    for (let i = 0; i < 2; i++) {
      expect(recoverReplacements(root, { example: { ...old, enabled: false } }).size).toBe(0);
      expect(bytes(destination)).toBe("old");
      expect(bytes(candidate)).toBe("new");
    }
  },
);
it("keeps a registered publication and the previous bytes", () => {
  renameSync(destination, previous);
  renameSync(candidate, destination);
  expect(recoverReplacements(root, { example: { ...next, enabled: false } }).size).toBe(0);
  expect(bytes(destination)).toBe("new");
  expect(bytes(previous)).toBe("old");
});
it.each(["remove", "forget"])("honors latest %s without resurrection", (decision) => {
  renameSync(destination, previous);
  renameSync(candidate, destination);
  const state = decision === "remove" ? { example: { ...old, remove: true } } : {};
  expect(recoverReplacements(root, state).size).toBe(0);
  expect(readdirSync(root)).not.toContain("example");
  expect(recoverReplacements(root, {}).size).toBe(0);
  expect(readdirSync(root)).not.toContain("example");
  expect(bytes(previous)).toBe("old");
});
it("preserves a competing live directory and both owned copies", () => {
  renameSync(destination, previous);
  mkdirSync(destination);
  writeFileSync(path.join(destination, "index.js"), "competitor");
  expect(recoverReplacements(root, { example: old })).toEqual(new Set([destination]));
  expect(bytes(destination)).toBe("competitor");
  expect(bytes(previous)).toBe("old");
  expect(bytes(candidate)).toBe("new");
});
it("does not follow a symlink replacement", () => {
  renameSync(destination, previous);
  const external = path.join(root, "external");
  mkdirSync(external);
  writeFileSync(path.join(external, "index.js"), "external");
  symlinkSync(external, destination);
  expect(recoverReplacements(root, { example: old })).toEqual(new Set([destination]));
  expect(bytes(external)).toBe("external");
  expect(bytes(previous)).toBe("old");
});
it("retains a missing legacy owner without selecting a random backup", () => {
  rmSync(journal);
  renameSync(destination, previous);
  expect(recoverReplacements(root, { example: old })).toEqual(new Set([destination]));
  expect(bytes(previous)).toBe("old");
  expect(recoverReplacements(root, { example: { ...old, remove: true } }).size).toBe(0);
});
it("refuses changed metadata and invalid traversal records", () => {
  renameSync(destination, previous);
  expect(recoverReplacements(root, { example: { ...old, version: "unrelated" } })).toEqual(
    new Set([destination]),
  );
  const record = JSON.parse(readFileSync(journal, "utf8"));
  record.previous.name = "../outside";
  writeFileSync(journal, JSON.stringify(record));
  expect(recoverReplacements(root, { example: old })).toEqual(new Set([destination]));
  expect(bytes(previous)).toBe("old");
  expect(bytes(candidate)).toBe("new");
});
it("recovers an earlier durable catalog through multiple unpublished updates", () => {
  renameSync(destination, previous);
  renameSync(candidate, destination);
  const secondCandidate = path.join(root, ".extension-third.installing"),
    secondBackup = path.join(root, ".extension.bak-second");
  mkdirSync(secondCandidate);
  writeFileSync(path.join(secondCandidate, "index.js"), "third");
  const second = recordReplacement(
    root,
    destination,
    secondBackup,
    secondCandidate,
    { example: next },
    { ...next, version: "3", fileId: 3 },
  );
  releaseReplacement(second);
  renameSync(destination, secondBackup);
  renameSync(secondCandidate, destination);
  expect(recoverReplacements(root, { example: old }).size).toBe(0);
  expect(bytes(destination)).toBe("old");
  expect(bytes(secondBackup)).toBe("new");
  expect(bytes(secondCandidate)).toBe("third");
});

it("keeps recovery behind an active replacement for the same destination", () => {
  renameSync(destination, previous);
  renameSync(candidate, destination);
  const secondCandidate = path.join(root, ".extension-third.installing");
  const secondBackup = path.join(root, ".extension.bak-second");
  mkdirSync(secondCandidate);
  writeFileSync(path.join(secondCandidate, "index.js"), "third");
  const second = recordReplacement(
    root,
    destination,
    secondBackup,
    secondCandidate,
    { example: next },
    { ...next, version: "3", fileId: 3 },
  );
  try {
    renameSync(destination, secondBackup);
    expect(recoverReplacements(root, { example: next })).toEqual(new Set([destination]));
    expect(recoverReplacements(root, { example: next }, false).size).toBe(0);
    expect(readdirSync(root)).not.toContain("example");
    expect(bytes(secondBackup)).toBe("new");
    expect(bytes(secondCandidate)).toBe("third");
  } finally {
    releaseReplacement(second);
  }
  expect(recoverReplacements(root, { example: next }).size).toBe(0);
  expect(bytes(destination)).toBe("new");
});

it("preserves edits to retained bytes instead of replacing them from the archive", () => {
  renameSync(destination, previous);
  writeFileSync(path.join(previous, "index.js"), "external edit");
  expect(recoverReplacements(root, { example: old }).size).toBe(0);
  expect(bytes(destination)).toBe("external edit");
  expect(bytes(candidate)).toBe("new");
});

it("leaves ordinary missing entries to normal removal reconciliation", () => {
  rmSync(journal);
  rmSync(destination, { recursive: true });
  expect(recoverReplacements(root, { example: old }).size).toBe(0);
  expect(bytes(candidate)).toBe("new");
});

it("preserves indistinguishable copies for deliberate recovery", () => {
  rmSync(journal);
  const ambiguous = recordReplacement(
    root,
    destination,
    previous,
    candidate,
    { example: old },
    { ...old },
  );
  releaseReplacement(ambiguous);
  renameSync(destination, previous);
  expect(recoverReplacements(root, { example: old })).toEqual(new Set([destination]));
  expect(bytes(previous)).toBe("old");
  expect(bytes(candidate)).toBe("new");
});
