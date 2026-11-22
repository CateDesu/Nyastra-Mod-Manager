import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { log } from "../../logging";
import type { IExtensionState } from "../../types/IState";
import { canonicalDestination, isLinkedImportDirectory } from "./importedExtensionPaths";

type Catalog = Record<string, IExtensionState>;
type Identity = { dev: string; ino: string };
type Copy = { name: string; identity: Identity; catalog: Catalog };
interface Replacement {
  version: 1;
  destination: string;
  previous: Copy;
  candidate: Copy;
}
const active = new Set<string>();

function identity(filename: string): Identity | undefined {
  try {
    const info = fs.lstatSync(filename, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe extension directory");
    return { dev: String(info.dev), ino: String(info.ino) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function same(left: Identity | undefined, right: Identity): boolean {
  return left?.dev === right.dev && left?.ino === right.ino;
}
function bounded(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name !== "." &&
    name !== ".." &&
    name !== "" &&
    path.basename(name) === name
  );
}
function owned(copy: Copy): boolean {
  return (
    bounded(copy?.name) &&
    /^\.extension(?:\.bak-|-.+\.installing$)/.test(copy.name) &&
    typeof copy.identity?.dev === "string" &&
    /^\d+$/.test(copy.identity.dev) &&
    typeof copy.identity.ino === "string" &&
    /^\d+$/.test(copy.identity.ino) &&
    copy.catalog !== null &&
    typeof copy.catalog === "object" &&
    !Array.isArray(copy.catalog)
  );
}
function metadata(left: IExtensionState, right: IExtensionState): boolean {
  return (["name", "version", "modId", "fileId", "infoJsonId", "type"] as const).every(
    (key) => left[key] === right[key],
  );
}
function pathIs(value: string | undefined, destination: string): boolean {
  return value !== undefined && canonicalDestination(value) === destination;
}
function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Record ownership before either folder moves. Retained copies allow safe restart recovery. */
export function recordReplacement(
  root: string,
  destination: string,
  previous: string,
  candidate: string,
  catalog: Catalog,
  next: IExtensionState,
): string {
  root = fs.realpathSync(root);
  for (const filename of [destination, previous, candidate]) {
    if (fs.realpathSync(path.dirname(filename)) !== root || !bounded(path.basename(filename))) {
      throw new Error("Extension replacement path is outside the selected plugins directory");
    }
  }
  if (!pathIs(next.path, path.join(root, path.basename(destination))))
    throw new Error("Invalid replacement catalog path");
  const old = identity(destination);
  const fresh = identity(candidate);
  if (old === undefined || fresh === undefined)
    throw new Error("Extension replacement files are missing");
  const record: Replacement = {
    version: 1,
    destination: path.basename(destination),
    previous: {
      name: path.basename(previous),
      identity: old,
      catalog: Object.fromEntries(
        Object.entries(catalog).filter(([, entry]) =>
          pathIs(entry.path, path.join(root, path.basename(destination))),
        ),
      ),
    },
    candidate: { name: path.basename(candidate), identity: fresh, catalog: { [next.name]: next } },
  };
  const filename = path.join(root, `.extension-replacement-${randomUUID()}.json`);
  const temporary = filename + ".tmp";
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(record));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filename);
  syncDirectory(root);
  active.add(filename);
  return filename;
}

export function releaseReplacement(filename: string): void {
  active.delete(filename);
}

/** Run before removal/scanning and before extraction. Never infer ownership from manifests. */
export function recoverReplacements(
  directory: string,
  catalog: Catalog,
  protectActive = true,
): Set<string> {
  const blocked = new Set<string>();
  if (!fs.existsSync(directory) || isLinkedImportDirectory(directory)) return blocked;
  const root = fs.realpathSync(directory);
  const groups = new Map<string, Replacement[]>();
  const claimed = new Set<string>();
  const activeDestinations = new Set<string>();
  let invalid = false;
  for (const name of fs
    .readdirSync(root)
    .filter((name) => /^\.extension-replacement-.+\.json$/.test(name))) {
    const filename = path.join(root, name);
    try {
      if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink())
        throw new Error("Unsafe extension replacement record");
      const record = JSON.parse(fs.readFileSync(filename, "utf8")) as Replacement;
      if (
        record.version !== 1 ||
        !bounded(record.destination) ||
        record.destination.startsWith(".") ||
        !owned(record.previous) ||
        !owned(record.candidate) ||
        record.previous.name === record.candidate.name
      )
        throw new Error("Invalid extension replacement record");
      for (const copy of [record.previous, record.candidate]) {
        if (
          !Object.values(copy.catalog).every(
            (entry) =>
              entry !== null &&
              typeof entry === "object" &&
              pathIs(entry.path, path.join(root, record.destination)),
          )
        )
          throw new Error("Invalid extension catalog ownership");
        claimed.add(copy.name);
      }
      if (active.has(filename)) {
        activeDestinations.add(record.destination);
        if (protectActive) blocked.add(path.join(root, record.destination));
        continue;
      }
      const records = groups.get(record.destination) ?? [];
      records.push(record);
      groups.set(record.destination, records);
    } catch (error) {
      invalid = true;
      log("error", "Extension replacement needs deliberate recovery", { filename, error });
    }
  }
  const legacy = fs.readdirSync(root).some((name) => /\.bak-/.test(name) && !claimed.has(name));
  for (const [destination, records] of groups) {
    if (activeDestinations.has(destination)) continue;
    const livePath = path.join(root, destination);
    const copies = records.flatMap((record) => [record.previous, record.candidate]);
    const entries = Object.entries(catalog).filter(([, entry]) => pathIs(entry.path, livePath));
    try {
      const locations = [...new Set([destination, ...copies.map((copy) => copy.name)])];
      const current = identity(livePath);
      if (current !== undefined && !copies.some((copy) => same(current, copy.identity)))
        throw new Error("Competing extension destination retained");
      // Missing owners and explicit removal are decisions, not failed installations.
      if (entries.length === 0 || entries.some(([, entry]) => entry.remove)) {
        if (current !== undefined) {
          const copy = copies.find((copy) => same(current, copy.identity))!;
          const retained = path.join(root, copy.name);
          if (fs.existsSync(retained)) throw new Error("Extension removal copy collides");
          fs.renameSync(livePath, retained);
          syncDirectory(root);
        }
        continue;
      }
      const matches = copies.filter((copy) =>
        entries.every(([, entry]) =>
          Object.values(copy.catalog).some((recorded) => metadata(entry, recorded)),
        ),
      );
      if (current !== undefined && matches.some((copy) => same(current, copy.identity))) continue;
      const identities = new Set(
        matches.map((copy) => `${copy.identity.dev}:${copy.identity.ino}`),
      );
      if (identities.size !== 1)
        throw new Error("Extension catalog does not identify a unique retained copy");
      const chosen = matches[0];
      const source = locations.find((name) =>
        same(identity(path.join(root, name)), chosen.identity),
      );
      if (source === undefined) throw new Error("Owned extension copy is missing");
      if (current !== undefined) {
        const copy = copies.find((copy) => same(current, copy.identity))!;
        const retained = path.join(root, copy.name);
        if (fs.existsSync(retained)) throw new Error("Extension recovery copy collides");
        fs.renameSync(livePath, retained);
      }
      // An exclusive reservation protects competing existing files and directories.
      fs.mkdirSync(livePath);
      const reservation = identity(livePath)!;
      try {
        if (!same(identity(livePath), reservation))
          throw new Error("Extension recovery destination changed");
        fs.renameSync(path.join(root, source), livePath);
      } catch (error) {
        if (same(identity(livePath), reservation)) fs.rmdirSync(livePath);
        throw error;
      }
      syncDirectory(root);
    } catch (error) {
      blocked.add(livePath);
      log("error", "Extension replacement needs deliberate recovery", {
        destination: livePath,
        error,
      });
    }
  }
  if (legacy || invalid) {
    for (const entry of Object.values(catalog)) {
      if (entry.remove || entry.path === undefined) continue;
      const destination = path.join(root, path.basename(entry.path));
      if (pathIs(entry.path, destination) && !fs.existsSync(destination)) blocked.add(destination);
    }
  }
  return blocked;
}
