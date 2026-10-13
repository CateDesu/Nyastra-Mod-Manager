import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readdir, stat, statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function enableDirectoryCasefold(directory: string): Promise<boolean> {
  if (process.platform !== "linux" || process.env.FLATPAK_ID) return false;
  let probe: string | undefined;
  try {
    if (!(await lstat(directory)).isDirectory() || (await readdir(directory)).length !== 0)
      return false;
    if ((await statfs(directory)).type !== 0xef53) return false;
    await execute("chattr", ["+F", directory], { timeout: 10000 });
    probe = path.join(directory, `.NYASTRA_CASE_${randomUUID()}`);
    await writeFile(probe, "", { flag: "wx", mode: 0o600 });
    const [actual, folded] = await Promise.all([
      stat(probe),
      stat(path.join(directory, path.basename(probe).toLowerCase())),
    ]);
    return actual.dev === folded.dev && actual.ino === folded.ino;
  } catch {
    return false;
  } finally {
    if (probe) await unlink(probe).catch(() => undefined);
  }
}
