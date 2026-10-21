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
            parentPort.postMessage(job.oldPath === "bad-patch"
              ? { id: job.id, error: "invalid patch" }
              : { id: job.id });
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
