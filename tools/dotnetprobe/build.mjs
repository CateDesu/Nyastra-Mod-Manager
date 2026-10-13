import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import * as process from "node:process";

try {
  // Check if dotnet is available
  execFileSync("dotnet", ["--version"], { stdio: "pipe" });

  if (process.platform !== "linux") throw new Error("The program supports Linux only");
  const runtimeIdentifier = "linux-x64";

  for (const directory of ["bin", "obj", "dist"]) {
    rmSync(resolve(import.meta.dirname, directory), { recursive: true, force: true });
  }
  execFileSync(
    "dotnet",
    [
      "publish",
      "-r",
      runtimeIdentifier,
      "-o",
      "dist",
      "-p:DebugType=None",
      "-p:DebugSymbols=false",
    ],
    {
      cwd: import.meta.dirname,
      stdio: "inherit",
    },
  );
} catch (err) {
  // Fail loudly: a silently-missing dotnetprobe binary makes the Vortex
  // renderer crash at runtime, which surfaces as random e2e test failures.
  console.error("Error building dotnetprobe:", err.message);
  process.exit(1);
}
