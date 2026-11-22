import { isDeepStrictEqual } from "node:util";

import { DataInvalid } from "@vortex/shared/errors";
import { isClobberedKeySegment } from "@vortex/shared/state";

import { insertStateValue, orderStateRows } from "./stateTree";

export type StateRow = { key: string[]; value: string };

export function isStateKeySegment(segment: string): boolean {
  return (
    !segment.includes("###") &&
    !segment.endsWith("#") &&
    !isClobberedKeySegment(segment) &&
    Buffer.from(segment).toString("utf8") === segment
  );
}

export function isEncodedStatePath(key: string[]): boolean {
  return (
    key.every(
      (segment) =>
        !isClobberedKeySegment(segment) && Buffer.from(segment).toString("utf8") === segment,
    ) && isDeepStrictEqual(key, key.join("###").split("###"))
  );
}

export function stateStorageRoot(key: string[]): string[] {
  const unsafe = key.findIndex((segment) => !isStateKeySegment(segment));
  if (unsafe < 0) return key;
  const terminal = key.slice(0, unsafe + 1);
  return isEncodedStatePath(terminal) ? terminal : key.slice(0, unsafe);
}

export function readStateRows(rows: StateRow[], root: string[]): { value?: unknown } {
  const tree: { value?: unknown } = {};
  for (const row of orderStateRows([...rows])) {
    let value: unknown;
    try {
      value = row.value.length === 0 ? "" : JSON.parse(row.value);
    } catch {
      value = undefined;
    }
    insertStateValue(tree, ["value", ...row.key.slice(root.length)], value);
  }
  return tree;
}

/** Keep names that cannot be encoded in paths inside their parent JSON row. */
export function writeStateRows(
  value: unknown,
  root: string[],
  invalid: StateRow[] = [],
): StateRow[] {
  const rows: StateRow[] = [];
  const emit = (key: string[], value: unknown) => rows.push({ key, value: JSON.stringify(value) });
  const flatten = (value: unknown, key: string[]) => {
    if (value === undefined) return;
    if (key.at(-1)?.endsWith("#")) {
      emit(key, value);
      return;
    }
    if (value === null || typeof value !== "object") {
      emit(key, value);
      return;
    }
    if (Array.isArray(value)) {
      const serialized: unknown = JSON.parse(JSON.stringify(value));
      if (isDeepStrictEqual(value, serialized)) {
        emit(key, value);
        return;
      }
      // Indexed rows retain sparse arrays and named properties without JSON dropping them.
      emit(key, []);
      for (const [name, child] of Object.entries(value)) {
        if (!isEncodedStatePath([...key, name]))
          throw new DataInvalid("Cannot encode an array property");
        flatten(child, [...key, name]);
      }
      return;
    }
    const opaque = Object.fromEntries(
      Object.entries(value).filter(([name]) => !isStateKeySegment(name)),
    );
    if (Object.keys(opaque).length > 0 || Object.keys(value).length === 0) emit(key, opaque);
    for (const [name, child] of Object.entries(value)) {
      if (isStateKeySegment(name)) flatten(child, [...key, name]);
    }
  };
  if (root.at(-1)?.endsWith("#")) emit(root, value);
  else flatten(value, root);
  rows.push(...invalid);
  if (
    rows.some((row) =>
      row.key.some(
        (segment) =>
          isClobberedKeySegment(segment) || Buffer.from(segment).toString("utf8") !== segment,
      ),
    )
  )
    throw new DataInvalid("Cannot normalize state containing unreadable keys");
  const restored = readStateRows(
    rows.map((row) => ({ ...row, key: row.key.join("###").split("###") })),
    root,
  ).value;
  if (!isDeepStrictEqual(value, restored))
    throw new DataInvalid("Cannot normalize state without changing its contents");
  return rows;
}
