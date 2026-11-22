import { isDeepStrictEqual } from "node:util";

import { DataInvalid } from "@vortex/shared/errors";
import { isClobberedKeySegment } from "@vortex/shared/state";

import type LevelPersist from "./LevelPersist";
import { isStateKeySegment, readStateRows, writeStateRows } from "./stateRows";
import { orderStateRows } from "./stateTree";

type Row = { key: string[]; value: string };

/** Convert legacy container rows before hydration and ordinary descendant diffs. */
export async function normalizeStateBlobs(persist: LevelPersist): Promise<void> {
  const rows = orderStateRows(await persist.getAllKVs());
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    if (row.key.length < 2) continue;
    let parent: Row[] | undefined;
    for (let depth = 1; depth < row.key.length; depth++) {
      parent = groups.get(JSON.stringify(row.key.slice(0, depth)));
      if (parent) break;
    }
    if (parent) {
      parent.push(row);
      continue;
    }
    try {
      const value: unknown = JSON.parse(row.value);
      if (
        value !== null &&
        typeof value === "object" &&
        (Array.isArray(value) || Object.keys(value).length > 0)
      ) {
        groups.set(JSON.stringify(row.key), [row]);
      }
    } catch {
      // Unrelated invalid values retain their existing hydration behavior.
    }
  }
  if (groups.size === 0) return;

  await persist.beginTransaction();
  try {
    for (const group of groups.values()) {
      // Standalone arrays already use the current storage format.
      if (group.length === 1 && Array.isArray(JSON.parse(group[0]!.value))) continue;
      if (group.some((row) => row.key.some(isClobberedKeySegment))) {
        throw new DataInvalid("Cannot normalize state containing unreadable keys");
      }
      const root = group[0]!.key;
      // A terminal hash is readable as an exact row, but cannot prefix encoded children.
      if (root.some((segment) => !isStateKeySegment(segment))) continue;
      const tree = readStateRows(group, root);
      const invalid = group.filter((row) => {
        try {
          if (row.value.length > 0) JSON.parse(row.value);
          return false;
        } catch {
          return true;
        }
      });
      const replacements = writeStateRows(tree.value, root, invalid);
      if (!isDeepStrictEqual(group, orderStateRows(replacements))) {
        await persist.replaceRawRows(root, replacements);
      }
    }
    await persist.commitTransaction();
  } catch (error) {
    await persist.rollbackTransaction();
    throw error;
  }
}
