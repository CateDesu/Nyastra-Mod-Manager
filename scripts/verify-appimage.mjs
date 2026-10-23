import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export async function verifyAppImage(image, template) {
  const directory = await mkdtemp(path.join(tmpdir(), "nyastra-appimage-"));
  try {
    await promisify(execFile)(image, ["--appimage-extract", "AppRun"], { cwd: directory });
    const actual = await readFile(path.join(directory, "squashfs-root/AppRun"), "utf8");
    const expected = (await readFile(template, "utf8")).replace(
      "{{.ExecutableName}}",
      "nyastra-mod-manager",
    );
    if (actual !== expected) {
      throw new Error("the packaged AppImage must use the safe search path launcher");
    }
    console.log("verified packaged AppImage search path launcher");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
