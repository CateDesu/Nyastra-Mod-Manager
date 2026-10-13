import { readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import * as path from "node:path";

function matchSegment(entries: string[], segment: string, parent: string): string {
  if (entries.includes(segment)) return segment;
  const matches = entries.filter((entry) => entry.toLowerCase() === segment.toLowerCase());
  if (matches.length > 1) {
    throw Object.assign(new Error(`Ambiguous filename casing in ${parent}: ${segment}`), {
      code: "EEXIST",
      path: path.join(parent, segment),
    });
  }
  return matches[0] ?? segment;
}

function missingDirectory(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code);
}

export async function resolvePathCase(
  root: string,
  relative: string,
  cache?: Map<string, Promise<string[]>>,
): Promise<string> {
  let current = root;
  for (const segment of relative.replace(/\\/g, "/").split("/").filter(Boolean)) {
    let listing = cache?.get(current);
    if (!listing) {
      listing = readdir(current).catch((error: unknown) => {
        if (!missingDirectory(error)) throw error;
        return [];
      });
      cache?.set(current, listing);
    }
    const entries = await listing;
    const match = matchSegment(entries, segment, current);
    if (cache && !entries.includes(match)) entries.push(match);
    current = path.join(current, match);
  }
  return current;
}

export function resolvePathCaseSync(root: string, relative: string): string {
  let current = root;
  for (const segment of relative.replace(/\\/g, "/").split("/").filter(Boolean)) {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch (error) {
      if (!missingDirectory(error)) throw error;
      entries = [];
    }
    current = path.join(current, matchSegment(entries, segment, current));
  }
  return current;
}

export function isWinePrefixPath(filename: unknown): filename is string {
  return (
    process.platform === "linux" &&
    typeof filename === "string" &&
    /\/(?:pfx|\.wine)\/(?:drive_c|dosdevices)\//i.test(filename)
  );
}

export function resolveWinePath(filename: string): Promise<string> {
  return isWinePrefixPath(filename)
    ? resolvePathCase(path.parse(filename).root, filename)
    : Promise.resolve(filename);
}
