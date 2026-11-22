import type { Worker as NodeWorker } from "node:worker_threads";

import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ workers: [] as NodeWorker[] }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<{ Worker: typeof NodeWorker }>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor() {
        super(
          `const { parentPort } = require("node:worker_threads");
          parentPort.on("message", job => {
            if (job.oldPath === "crash") throw new Error("fixture worker crash");
            if (job.oldPath === "exit-clean") process.exit(0);
            parentPort.postMessage(job.oldPath === "bad-patch"
              ? { id: job.id, error: "invalid patch" }
              : { id: job.id });
            if (job.oldPath === "exit-idle") parentPort.close();
          });`,
          { eval: true },
        );
        fixture.workers.push(this);
      }
    },
  };
});

import { diffFiles, patchFiles, shutdownBsdiffWorker } from "./host";

afterEach(async () => {
  await shutdownBsdiffWorker();
  await Promise.all(fixture.workers.splice(0).map((worker) => worker.terminate()));
});

it("can retry immediately after a real worker emits an error and exits", async () => {
  await expect(diffFiles("crash", "new", "patch")).rejects.toThrow("fixture worker crash");
  await expect(diffFiles("old", "new", "patch")).resolves.toBeUndefined();
  expect(fixture.workers).toHaveLength(2);
});

it("keeps the real worker available after a job reports an ordinary patch error", async () => {
  await expect(patchFiles("bad-patch", "out", "patch")).rejects.toThrow("invalid patch");
  await expect(patchFiles("old", "out", "patch")).resolves.toBeUndefined();
  expect(fixture.workers).toHaveLength(1);
});

it("rejects every job on a crashed worker and accepts work on its replacement", async () => {
  const crashed = expect(diffFiles("crash", "new", "patch")).rejects.toThrow(
    "fixture worker crash",
  );
  const other = expect(patchFiles("old", "out", "patch")).rejects.toThrow("fixture worker crash");
  await Promise.all([crashed, other]);
  await expect(patchFiles("old", "out", "patch")).resolves.toBeUndefined();
  expect(fixture.workers).toHaveLength(2);
});

it("settles pending jobs on shutdown and can start a new worker afterward", async () => {
  const pending = expect(diffFiles("old", "new", "patch")).rejects.toThrow(
    "bsdiff worker shut down",
  );
  await shutdownBsdiffWorker();
  await pending;
  await expect(diffFiles("old", "new", "patch")).resolves.toBeUndefined();
  expect(fixture.workers).toHaveLength(2);
});

it("rejects pending jobs after an unexpected clean exit and recovers on retry", async () => {
  const first = diffFiles("exit-clean", "new", "patch");
  const second = patchFiles("old", "out", "patch");
  const results = Promise.allSettled([first, second]);
  await new Promise<void>((resolve) => fixture.workers[0]!.once("exit", () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    results,
    new Promise<"unsettled">((resolve) => {
      timer = setTimeout(() => resolve("unsettled"), 100);
    }),
  ]);
  clearTimeout(timer);
  expect(outcome).not.toBe("unsettled");
  if (outcome === "unsettled") throw new Error("Worker jobs did not settle");
  for (const result of outcome) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(String(result.reason)).toContain("exit code 0");
  }
  await expect(diffFiles("old", "new", "patch")).resolves.toBeUndefined();
  expect(fixture.workers).toHaveLength(2);
});

it("replaces a worker that exits cleanly while idle", async () => {
  const job = diffFiles("exit-idle", "new", "patch");
  const exited = new Promise<void>((resolve) => fixture.workers[0]!.once("exit", () => resolve()));
  await expect(job).resolves.toBeUndefined();
  await exited;
  await expect(patchFiles("old", "out", "patch")).resolves.toBeUndefined();
  expect(fixture.workers).toHaveLength(2);
});
