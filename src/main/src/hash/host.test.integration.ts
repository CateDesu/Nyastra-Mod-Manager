import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";

import { getErrorCode, type VortexError } from "@vortex/shared";
import { rolldown } from "rolldown";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { HashWorkerPool } from "./host";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
  },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) =>
      structuredClone(
        await handlers.get(channel)!({ senderFrame: null }, ...structuredClone(args)),
      ),
  },
}));
vi.mock("../logging", () => ({ log: vi.fn() }));

import { betterIpcMain } from "../ipc";

let root: string;
let workerScript: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nyastra-hash-boundary-"));
  await symlink(
    path.resolve(__dirname, "../../node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  workerScript = path.join(root, "hash-worker.cjs");
  const bundle = await rolldown({
    input: path.join(__dirname, "worker.ts"),
    platform: "node",
    external: (id) => !id.startsWith(".") && !path.isAbsolute(id),
  });
  try {
    await bundle.write({ file: workerScript, format: "cjs" });
  } finally {
    await bundle.close();
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

it.each(["missing-script", "clean-exit"])(
  "bounds asynchronous worker failure and recovers on demand: %s",
  async (mode) => {
    const workers: Worker[] = [];
    const exits: Promise<void>[] = [];
    let healthy = false;
    const pool = new HashWorkerPool(() => {
      const worker = healthy
        ? new Worker(workerScript, { execArgv: [] })
        : mode === "missing-script"
          ? new Worker(path.join(root, "absent.cjs"), { execArgv: [] })
          : new Worker("process.exit(0)", { eval: true, execArgv: [] });
      workers.push(worker);
      exits.push(new Promise((resolve) => worker.once("exit", () => resolve())));
      return worker;
    }, 1);
    try {
      const results = await Promise.allSettled([
        pool.hashFile("md5", "/1"),
        pool.hashFile("md5", "/2"),
      ]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      await delay(150);
      expect(workers).toHaveLength(2);
      await Promise.all(exits);

      healthy = true;
      const file = path.join(root, mode + ".txt");
      await writeFile(file, "recovered");
      await expect(pool.hashFile("md5", file)).resolves.toEqual({
        hash: createHash("md5").update("recovered").digest("hex"),
        numBytes: 9,
      });
    } finally {
      await pool.shutdown();
      await Promise.all(workers.map((worker) => worker.terminate()));
      await Promise.all(exits);
    }
  },
);

it("preserves file error identity through a real worker and main/preload IPC", async () => {
  const preloadPath = path.resolve(__dirname, "../../../preload/src/ipc.ts");
  const { rendererInvoke } = (await import(preloadPath)) as {
    rendererInvoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  };
  const pool = new HashWorkerPool(() => new Worker(workerScript, { execArgv: [] }), 1);
  betterIpcMain.handle("hash:compute", (_event, algorithm, file) => pool.hashFile(algorithm, file));
  try {
    const missing = path.join(root, "missing.txt");
    const error = (await rendererInvoke("hash:compute", "md5", missing).catch(
      (err: unknown) => err,
    )) as VortexError;
    expect(error).toBeInstanceOf(Error);
    expect(getErrorCode(error)).toBe("ENOENT");
    expect(error.data).toMatchObject({
      kind: "fs:not-found",
      originalCode: "ENOENT",
      path: missing,
      syscall: "open",
    });
    expect(error.data).toHaveProperty("errno", expect.any(Number));

    await expect(rendererInvoke("hash:compute", "md5", root)).rejects.toSatisfy(
      (err: unknown) => getErrorCode(err) === "EISDIR",
    );
    const file = path.join(root, "valid.txt");
    await writeFile(file, "valid");
    await expect(rendererInvoke("hash:compute", "md5", file)).resolves.toEqual({
      hash: createHash("md5").update("valid").digest("hex"),
      numBytes: 5,
    });
  } finally {
    await pool.shutdown();
    handlers.clear();
  }
});
