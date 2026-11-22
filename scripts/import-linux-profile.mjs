import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

function entryExists(filename) {
  try {
    lstatSync(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function entryIdentity(filename) {
  const info = lstatSync(filename, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
}

function matchesIdentity(filename, expected) {
  const actual = entryIdentity(filename);
  return expected?.dev === actual.dev && expected?.ino === actual.ino;
}

export function recoverFluffyConfiguration(configHome, selected) {
  const directory = path.join(configHome, "nyastra-mod-manager");
  const saved = path.resolve(selected);
  const claim = path.dirname(saved);
  if (
    !path.isAbsolute(selected) ||
    path.dirname(claim) !== directory ||
    !/^\.fluffy-rollback-[a-zA-Z0-9]{6}$/.test(path.basename(claim)) ||
    path.basename(saved) !== "fluffy.json" ||
    !lstatSync(claim).isDirectory()
  ) {
    throw new Error("Choose a saved Fluffy configuration inside the configuration directory");
  }
  const info = lstatSync(saved);
  if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`Not a configuration: ${saved}`);
  // Keep the saved inode linked even if an open writer edits it later.
  linkSync(saved, path.join(directory, "fluffy.json"));
  console.log(`Fluffy configuration restored. Recovery copy retained at ${saved}`);
}

export function checkFluffyRecovery(configHome) {
  const directory = path.join(configHome, "nyastra-mod-manager");
  if (!entryExists(directory) || entryExists(path.join(directory, "fluffy.json"))) return;
  const saved = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\.fluffy-rollback-[a-zA-Z0-9]{6}$/.test(entry.name))
    .map((entry) => path.join(directory, entry.name, "fluffy.json"))
    .filter(entryExists);
  if (saved.length === 1) {
    const filename = saved[0];
    const claim = path.dirname(filename);
    let recognized = false;
    try {
      const record = JSON.parse(readFileSync(path.join(claim, "transaction.json"), "utf8"));
      recognized =
        record.version === 1 &&
        lstatSync(claim).isDirectory() &&
        matchesIdentity(claim, record.directory) &&
        matchesIdentity(filename, record.entry);
    } catch {
      // Older claims need an explicit selection instead of inferred ownership.
    }
    if (recognized) {
      recoverFluffyConfiguration(configHome, filename);
      return;
    }
  }
  if (saved.length > 0) {
    throw new Error(
      `Fluffy recovery is required before importing. Saved configurations: ${saved.join(", ")}. ` +
        "Run this installer with --recover-fluffy /absolute/path/to/saved/fluffy.json, then retry.",
    );
  }
}

function importSettingsOwnership(source, destination, staging) {
  const filename = path.join(source, "local-game-settings.json");
  let contents;
  try {
    if (!lstatSync(filename).isFile()) throw new Error("Game settings ownership must be a file");
    contents = readFileSync(filename, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const record = JSON.parse(contents);
  const validProfile = (profile) =>
    profile != null && typeof profile.id === "string" && typeof profile.gameId === "string";
  const validPath = (value) => typeof value === "string" && path.isAbsolute(value);
  const pending = record?.pending;
  if (
    record?.version !== 1 ||
    record.installed == null ||
    typeof record.installed !== "object" ||
    Array.isArray(record.installed) ||
    !Object.entries(record.installed).every(
      ([game, profile]) => validProfile(profile) && profile.gameId === game,
    ) ||
    (pending !== undefined &&
      (pending == null ||
        (pending.oldProfile !== undefined && !validProfile(pending.oldProfile)) ||
        (pending.newProfile !== undefined && !validProfile(pending.newProfile)) ||
        !Array.isArray(pending.steps) ||
        !Number.isInteger(pending.completed) ||
        pending.completed < 0 ||
        pending.completed > Math.max(0, pending.steps.length - 1) ||
        !pending.steps.every(
          (step) =>
            validPath(step?.sourcePath) &&
            validPath(step.destinationPath) &&
            ["GloPro", "BacGlo", "GloBac", "ProGlo"].includes(step.copyType) &&
            Array.isArray(step.files) &&
            step.files.every(
              (file) =>
                typeof file?.name === "string" &&
                file.name.length > 0 &&
                ![".", ".."].includes(file.name) &&
                path.basename(file.name) === file.name &&
                typeof file.optional === "boolean",
            ),
        )))
  ) {
    throw new Error(
      "Game settings ownership data is invalid. Keep the source profile for recovery.",
    );
  }
  const sourcePaths = [...new Set([source, realpathSync(source)])];
  const rebase = (value) => {
    for (const sourcePath of sourcePaths) {
      const relative = path.relative(sourcePath, value);
      if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        return path.join(destination, relative);
    }
    return value;
  };
  for (const step of pending?.steps ?? []) {
    step.sourcePath = rebase(step.sourcePath);
    step.destinationPath = rebase(step.destinationPath);
  }
  writeFileSync(path.join(staging, "local-game-settings.json"), JSON.stringify(record), {
    mode: 0o600,
  });
}

export function importLinuxProfile(sourceDirectory, configHome) {
  if (!path.isAbsolute(sourceDirectory)) {
    throw new Error("Choose an absolute profile directory");
  }
  if (!path.isAbsolute(configHome)) {
    throw new Error("Choose an absolute configuration directory");
  }
  const configRoot = path.resolve(configHome);
  checkFluffyRecovery(configRoot);
  const source = path.resolve(sourceDirectory);
  const destination = path.join(configHome, "NyastraModManager");
  if (existsSync(destination))
    throw new Error("The Nyastra profile already exists. Import requires a fresh profile.");
  const database = path.join(source, "state.v2");
  const lock = path.join(database, "LOCK");
  if (!existsSync(path.join(database, "CURRENT")) || !existsSync(lock)) {
    throw new Error("The selected directory does not contain a recognized Vortex profile");
  }
  const sourceCanonical = realpathSync(source);
  const checkClosed = () => {
    const result = spawnSync("fuser", ["-s", lock], { timeout: 10000 });
    if (result.error || ![0, 1].includes(result.status)) {
      throw new Error("Profile import requires fuser from psmisc");
    }
    if (result.status === 0)
      throw new Error("Close the program using the source profile before importing it");
  };
  checkClosed();
  const staging = path.resolve(configRoot, `.nyastra-import-${process.pid}`);
  const prefix = configRoot.endsWith(path.sep) ? configRoot : configRoot + path.sep;
  if (!staging.startsWith(prefix)) {
    throw new Error("Profile staging must stay inside the configuration directory");
  }
  const fluffy = path.join(configHome, "nyastra-mod-manager/fluffy.json");
  const oldFluffy = path.join(configHome, "vortex-native/fluffy.json");
  let copiedFluffy;
  const rollbackFluffy = () => {
    if (!copiedFluffy) return;
    const claimed = mkdtempSync(path.join(path.dirname(fluffy), ".fluffy-rollback-"));
    const saved = path.join(claimed, "fluffy.json");
    try {
      // Claim the entry before checking it. Later replacements keep their pathname.
      try {
        writeFileSync(
          path.join(claimed, "transaction.json"),
          JSON.stringify({
            version: 1,
            directory: entryIdentity(claimed),
            entry: entryIdentity(fluffy),
          }),
          { mode: 0o600, flag: "wx" },
        );
        renameSync(fluffy, saved);
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      let owned = false;
      try {
        const info = lstatSync(saved, { bigint: true });
        owned =
          info.isFile() &&
          String(info.dev) === copiedFluffy.dev &&
          String(info.ino) === copiedFluffy.ino &&
          readFileSync(saved).equals(copiedFluffy.bytes);
      } catch {
        // An entry we cannot inspect must be preserved.
      }
      if (!owned) {
        try {
          linkSync(saved, fluffy);
        } catch (error) {
          throw new Error(`Independent Fluffy configuration preserved at ${saved}`, {
            cause: error,
          });
        }
      }
      // A writer can still hold this inode after the comparison or restoration.
      console.warn(`Fluffy recovery copy retained at ${saved}`);
      copiedFluffy = undefined;
    } finally {
      if (!entryExists(saved)) rmSync(claimed, { recursive: true, force: true });
    }
  };
  let publishedProfile;
  const rollback = () => {
    let failure;
    for (const cleanup of [
      () => {
        if (!publishedProfile) return;
        if (entryExists(destination)) {
          if (!matchesIdentity(destination, publishedProfile))
            throw new Error(`Profile rollback preserved a replacement at ${destination}`);
          rmSync(destination, { recursive: true, force: true });
        }
        publishedProfile = undefined;
      },
      rollbackFluffy,
    ]) {
      try {
        cleanup();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  };
  mkdirSync(staging, { recursive: false, mode: 0o700 });
  try {
    const names = ["state.v2", "plugins"];
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Profile import does not copy symlinks");
      if (!entry.isDirectory() || names.includes(entry.name)) continue;
      const profiles = path.join(entry.name, "profiles");
      try {
        const stats = lstatSync(path.join(source, profiles));
        if (stats.isSymbolicLink()) throw new Error("Profile import does not copy symlinks");
        if (!stats.isDirectory()) continue;
        names.push(profiles);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        continue;
      }
      for (const backup of readdirSync(path.join(source, entry.name), { withFileTypes: true })) {
        if (!/\.ini$/i.test(backup.name)) continue;
        if (backup.isSymbolicLink()) throw new Error("Profile import does not copy symlinks");
        if (backup.isFile()) names.push(path.join(entry.name, backup.name));
      }
    }
    for (const name of names) {
      const filename = path.join(source, name);
      if (!existsSync(filename)) continue;
      cpSync(filename, path.join(staging, name), {
        recursive: true,
        dereference: false,
        force: false,
        errorOnExist: true,
        filter: (candidate) => {
          if (lstatSync(candidate).isSymbolicLink())
            throw new Error("Profile import does not copy symlinks");
          return true;
        },
      });
    }
    importSettingsOwnership(source, destination, staging);
    const startup = path.join(source, "startup.json");
    if (existsSync(startup)) {
      const original = JSON.parse(readFileSync(startup, "utf8"));
      const copied = Object.fromEntries(
        ["disableGPU", "maxMemory", "startMinimized", "storeVersion"]
          .filter((key) => original[key] !== undefined)
          .map((key) => [key, original[key]]),
      );
      writeFileSync(path.join(staging, "startup.json"), JSON.stringify(copied), { mode: 0o600 });
    }
    writeFileSync(
      path.join(staging, "nyastra-import.json"),
      JSON.stringify({ version: 1, source, sourceCanonical }),
      { mode: 0o600 },
    );
    checkClosed();
    const identity = entryIdentity(staging);
    renameSync(staging, destination);
    publishedProfile = identity;
    if (!entryExists(fluffy) && existsSync(oldFluffy)) {
      if (lstatSync(oldFluffy).isSymbolicLink())
        throw new Error("Fluffy configuration must be a regular file");
      mkdirSync(path.dirname(fluffy), { recursive: true, mode: 0o700 });
      const temporary = mkdtempSync(path.join(path.dirname(fluffy), ".fluffy-import-"));
      try {
        const candidate = path.join(temporary, "fluffy.json");
        cpSync(oldFluffy, candidate, { force: false, errorOnExist: true });
        const info = lstatSync(candidate, { bigint: true });
        const ownership = {
          dev: String(info.dev),
          ino: String(info.ino),
          bytes: readFileSync(candidate),
        };
        linkSync(candidate, fluffy);
        copiedFluffy = ownership;
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
    return {
      profile: destination,
      rollback,
    };
  } catch (error) {
    try {
      rollback();
    } catch (recoveryError) {
      console.error(`Profile recovery failed: ${recoveryError.message}`);
    }
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
