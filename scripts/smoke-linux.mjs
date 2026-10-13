import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const executable = path.resolve(process.argv[2] ?? "dist/linux-unpacked/nyastra-mod-manager");
const directory = await mkdtemp(path.join(tmpdir(), "nyastra-startup-"));
const profile = path.join(directory, "profile");
await mkdir(profile);
let output = "";
let exited = false;
const child = spawn(
  executable,
  ["--user-data", profile, "--disable-gpu", "--disable-dev-shm-usage"],
  {
    env: {
      ...process.env,
      NODE_OPTIONS: undefined,
      LD_PRELOAD: undefined,
      LD_LIBRARY_PATH: undefined,
      XDG_CURRENT_DESKTOP: "X-Generic",
      XDG_CONFIG_HOME: path.join(directory, "config"),
      XDG_DATA_HOME: path.join(directory, "data"),
      XDG_CACHE_HOME: path.join(directory, "cache"),
      XDG_STATE_HOME: path.join(directory, "state"),
    },
    detached: process.platform === "linux",
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});
child.on("exit", () => {
  exited = true;
});
child.on("error", (error) => {
  output += error.message;
  exited = true;
});

const fatal =
  /quitting with exception|renderer process crashed|error setting up renderer|uncaught exception|segmentation fault|failed to load the app/i;
try {
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline && !exited) {
    const log = await readFile(path.join(profile, "vortex.log"), "utf8").catch(() => "");
    if (fatal.test(log + output)) throw new Error("Packaged startup reported a fatal error");
    if (
      /startup complete|startup completed|startup finished|renderer ready|ready to show|render with language/i.test(
        log + output,
      )
    ) {
      ready = true;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready || exited || fatal.test(output))
    throw new Error("Packaged program did not finish startup");
  console.log("Packaged Linux startup passed with a disposable profile.");
} catch (error) {
  console.error(output.slice(-12000));
  throw error;
} finally {
  const stop = (signal) => {
    if (process.platform === "linux" && child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    } else if (!exited) child.kill(signal);
  };
  stop("SIGTERM");
  if (!exited) {
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (!exited) {
      stop("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
  await rm(directory, { recursive: true, force: true });
}
