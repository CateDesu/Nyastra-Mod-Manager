import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export function importLinuxProfile(sourceDirectory, configHome) {
  if (!path.isAbsolute(sourceDirectory)) {
    throw new Error("Choose an absolute profile directory");
  }
  const source = path.resolve(sourceDirectory);
  const destination = path.join(configHome, "NyastraModManager");
  if (existsSync(destination))
    throw new Error("The Nyastra profile already exists. Import requires a fresh profile.");
  const database = path.join(source, "state.v2");
  const lock = path.join(database, "LOCK");
  if (!existsSync(path.join(database, "CURRENT")) || !existsSync(lock)) {
    throw new Error("The selected directory does not contain a recognized Vortex profile");
  }
  const checkClosed = () => {
    const result = spawnSync("fuser", ["-s", lock], { timeout: 10000 });
    if (result.error || ![0, 1].includes(result.status)) {
      throw new Error("Profile import requires fuser from psmisc");
    }
    if (result.status === 0)
      throw new Error("Close the program using the source profile before importing it");
  };
  checkClosed();
  const staging = path.join(configHome, `.nyastra-import-${process.pid}`);
  const fluffy = path.join(configHome, "nyastra-mod-manager/fluffy.json");
  const oldFluffy = path.join(configHome, "vortex-native/fluffy.json");
  let copiedFluffy = false;
  let moved = false;
  const rollback = () => {
    let failure;
    for (const cleanup of [
      () => {
        if (moved) rmSync(destination, { recursive: true, force: true });
      },
      () => {
        if (copiedFluffy) rmSync(fluffy, { force: true });
      },
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
    for (const name of ["state.v2", "plugins"]) {
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
      JSON.stringify({ version: 1, source }),
      { mode: 0o600 },
    );
    checkClosed();
    renameSync(staging, destination);
    moved = true;
    if (!existsSync(fluffy) && existsSync(oldFluffy)) {
      if (lstatSync(oldFluffy).isSymbolicLink())
        throw new Error("Fluffy configuration must be a regular file");
      mkdirSync(path.dirname(fluffy), { recursive: true, mode: 0o700 });
      cpSync(oldFluffy, fluffy, { force: false, errorOnExist: true });
      copiedFluffy = true;
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
