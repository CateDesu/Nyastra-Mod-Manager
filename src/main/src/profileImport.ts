import { readFile, rename } from "node:fs/promises";
import path from "node:path";

import { flattenState } from "./store/flattenState";
import type LevelPersist from "./store/LevelPersist";

type ImportPersistor = Pick<
  LevelPersist,
  | "getAllKVs"
  | "removeItem"
  | "setItem"
  | "beginTransaction"
  | "commitTransaction"
  | "rollbackTransaction"
>;

export async function finishProfileImport(
  persistor: ImportPersistor,
  userData: string,
): Promise<void> {
  const marker = path.join(userData, "nyastra-import.json");
  let contents: string;
  try {
    contents = await readFile(marker, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const record = JSON.parse(contents) as { version: number; source: string };
  if (
    record.version !== 1 ||
    typeof record.source !== "string" ||
    !path.isAbsolute(record.source) ||
    path.resolve(record.source) === path.resolve(userData)
  ) {
    throw new Error("Invalid profile import record");
  }
  const entries = await persistor.getAllKVs();
  const asRecord = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : (Object.create(null) as Record<string, unknown>);
  const root = Object.create(null) as Record<string, unknown>;
  for (const { key, value } of entries.toSorted(
    (left, right) => left.key.length - right.key.length,
  )) {
    let current = root;
    for (const part of key.slice(0, -1)) {
      const child = asRecord(Object.hasOwn(current, part) ? current[part] : undefined);
      Object.defineProperty(current, part, {
        value: child,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      current = child;
    }
    if (key.length)
      Object.defineProperty(current, key.at(-1)!, {
        value: JSON.parse(value) as unknown,
        writable: true,
        enumerable: true,
        configurable: true,
      });
  }
  const read = (prefix: string[]): Record<string, unknown> => {
    let result = root;
    for (const part of prefix)
      result = asRecord(Object.hasOwn(result, part) ? result[part] : undefined);
    return result;
  };
  const installPaths = Object.fromEntries(
    Object.entries(read(["settings", "mods", "installPath"])).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const games = new Set([
    ...Object.keys(read(["persistent", "mods"])),
    ...Object.keys(read(["settings", "gameMode", "discovered"])),
    ...Object.keys(installPaths),
  ]);
  const preserve = (pattern: string) => pattern.replace(/\{USERDATA\}/gi, () => record.source);
  await persistor.beginTransaction();
  try {
    await persistor.removeItem(["confidential"]);
    await persistor.removeItem(["persistent", "changelogs"]);
    const nexus = read(["persistent", "nexus"]);
    delete nexus.userInfo;
    await persistor.removeItem(["persistent", "nexus"]);
    for (const leaf of flattenState(nexus, ["persistent", "nexus"]))
      await persistor.setItem(leaf.key, JSON.stringify(leaf.value));
    const settings = read(["settings"]);
    settings.analytics = { ...asRecord(settings.analytics), enabled: false };
    const downloads = asRecord(settings.downloads).path;
    settings.downloads = {
      ...asRecord(settings.downloads),
      path: preserve(
        typeof downloads === "string" && downloads
          ? downloads
          : path.join("{USERDATA}", "downloads"),
      ),
    };
    const modSettings = { ...asRecord(settings.mods), installPath: { ...installPaths } };
    settings.mods = modSettings;
    for (const game of games)
      modSettings.installPath[game] = preserve(
        installPaths[game] || path.join("{USERDATA}", "{GAME}", "mods"),
      );
    await persistor.removeItem(["settings"]);
    for (const leaf of flattenState(settings, ["settings"]))
      await persistor.setItem(leaf.key, JSON.stringify(leaf.value));
    await persistor.commitTransaction();
  } catch (error) {
    await persistor.rollbackTransaction();
    throw error;
  }
  await rename(marker, path.join(userData, "nyastra-import-complete.json"));
}
