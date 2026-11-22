import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { flattenState } from "./store/flattenState";
import type LevelPersist from "./store/LevelPersist";
import { writeStateRows } from "./store/stateRows";
import { insertStateValue, orderStateRows } from "./store/stateTree";

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
  const completedMarker = path.join(userData, "nyastra-import-complete.json");
  let initialImport = true;
  let contents: string;
  try {
    contents = await readFile(marker, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    initialImport = false;
    try {
      contents = await readFile(completedMarker, "utf8");
    } catch (completedError) {
      if ((completedError as NodeJS.ErrnoException).code === "ENOENT") return;
      throw completedError;
    }
  }
  const record = JSON.parse(contents) as {
    version: number;
    source: string;
    sourceCanonical?: string;
    extensionPathsVersion?: number;
  };
  if (!initialImport && record.extensionPathsVersion === 2) return;
  if (
    ![1, 2].includes(record.version) ||
    typeof record.source !== "string" ||
    !path.isAbsolute(record.source) ||
    path.resolve(record.source) === path.resolve(userData)
  ) {
    throw new Error("Invalid profile import record");
  }
  const canonical = record.sourceCanonical;
  if (
    canonical !== undefined &&
    (!path.isAbsolute(canonical) || path.resolve(canonical) === path.resolve(userData))
  ) {
    throw new Error("Invalid profile import source identity");
  }
  // A legacy alias's current target does not establish its identity at import time.
  const sources = [
    ...new Set([record.source, canonical].filter((value): value is string => value !== undefined)),
  ];
  const entries = await persistor.getAllKVs();
  const asRecord = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : (Object.create(null) as Record<string, unknown>);
  const root = Object.create(null) as Record<string, unknown>;
  const needed = [
    ["app", "extensions"],
    ...(initialImport
      ? [["settings"], ["persistent", "mods"], ["persistent", "nexus"]]
      : [["settings", "gameMode", "discovered"]]),
  ];
  // Legacy databases can store an entire subtree in one ancestor row.
  const relevant = entries.filter(
    ({ key }) =>
      key.length > 0 &&
      needed.some((prefix) => prefix.every((part, i) => i >= key.length || key[i] === part)),
  );
  for (const { key, value } of orderStateRows(relevant)) {
    insertStateValue(root, key, value === "" ? "" : JSON.parse(value));
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
  let pathsResolved = canonical !== undefined;
  const rebaseExtensionPath = async (value: unknown): Promise<unknown> => {
    if (typeof value !== "string" || !path.isAbsolute(value)) return value;
    const relative = sources
      .map((source) => path.relative(path.join(source, "plugins"), value))
      .find(
        (relative) =>
          relative &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative),
      );
    if (relative === undefined) return value;
    const destination = path.join(userData, "plugins", relative);
    try {
      const plugins = path.join(await realpath(userData), "plugins");
      if (!(await lstat(plugins)).isDirectory() || !(await lstat(destination)).isDirectory()) {
        pathsResolved = false;
        return value;
      }
      const contained = path.relative(plugins, await realpath(destination));
      if (
        contained &&
        contained !== ".." &&
        !contained.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(contained)
      )
        return destination;
      pathsResolved = false;
      return value;
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        pathsResolved = false;
        return value;
      }
      throw error;
    }
  };
  let pathsChanged = false;
  await persistor.beginTransaction();
  try {
    const extensions = read(["app", "extensions"]);
    for (const value of Object.values(extensions)) {
      const extension = asRecord(value);
      const rebased = await rebaseExtensionPath(extension.path);
      if (rebased !== extension.path) {
        extension.path = rebased;
        pathsChanged = true;
      }
    }
    if (pathsChanged) {
      // A legacy app row may be the only copy of the other catalog fields.
      const prefix = ["app", "extensions"];
      const rows = writeStateRows(extensions, prefix);
      await persistor.removeItem(prefix);
      for (const row of rows) await persistor.setItem(row.key, row.value);
    }
    const discovered = read(["settings", "gameMode", "discovered"]);
    for (const [gameId, value] of Object.entries(discovered)) {
      const game = asRecord(value);
      const rebased = await rebaseExtensionPath(game.extensionPath);
      if (rebased !== game.extensionPath) {
        pathsChanged = true;
        game.extensionPath = rebased;
        await persistor.setItem(
          ["settings", "gameMode", "discovered", gameId, "extensionPath"],
          JSON.stringify(rebased),
        );
      }
    }
    // Existing imports only need path repair. Their current credentials and mod paths stay intact.
    if (initialImport) {
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
    }
    await persistor.commitTransaction();
  } catch (error) {
    await persistor.rollbackTransaction();
    throw error;
  }
  if (
    !initialImport &&
    record.version === 2 &&
    canonical === undefined &&
    !pathsChanged &&
    record.extensionPathsVersion === undefined
  )
    return;
  const temporary = completedMarker + ".tmp";
  await writeFile(
    temporary,
    JSON.stringify({
      ...record,
      version: 2,
      sourceCanonical: canonical,
      extensionPathsVersion: pathsResolved ? 2 : undefined,
    }),
    { mode: 0o600 },
  );
  await rename(temporary, completedMarker);
  if (initialImport) await rm(marker);
}
