import { lstatSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";

export function canonicalDestination(destPath: string): string {
  try {
    return path.join(realpathSync(path.dirname(destPath)), path.basename(destPath));
  } catch {
    return path.resolve(destPath);
  }
}

export function isLinkedImportDirectory(directory: string): boolean {
  return (
    isImportedProfile(path.dirname(directory)) &&
    lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink() === true
  );
}

export function isImportedProfile(userData: string): boolean {
  return ["nyastra-import.json", "nyastra-import-complete.json"].some((marker) => {
    try {
      lstatSync(path.join(userData, marker));
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  });
}

/** Unresolved ownership must not turn an untracked copy into an enabled extension. */
export function hasUnresolvedExtensionImport(userData: string): boolean {
  try {
    const record = JSON.parse(
      readFileSync(path.join(userData, "nyastra-import-complete.json"), "utf8"),
    ) as {
      extensionPathsVersion?: number;
    };
    return record.extensionPathsVersion !== 2;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export function isProfileExtensionPath(userData: string, filename: string): boolean {
  try {
    const root = path.join(realpathSync(userData), "plugins");
    if (!lstatSync(root).isDirectory() || !lstatSync(filename).isDirectory()) return false;
    const destination = realpathSync(filename);
    const relative = path.relative(root, destination);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  } catch {
    return false;
  }
}
