import { describe, expect, it } from "vitest";

import { HashWorkerPool } from "./host";
import type { HashWorker } from "./host";
import type { HashJob, HashResult } from "./protocol";

// A worker stand-in whose responses the test drives explicitly. postMessage
// records the job; the emit* helpers fire the events the pool listens for.
class FakeWorker implements HashWorker {
  readonly posted: HashJob[] = [];
  terminated = false;
  readonly #messageListeners: Array<(result: HashResult) => void> = [];
  readonly #errorListeners: Array<(err: Error) => void> = [];
  readonly #exitListeners: Array<(code: number) => void> = [];

  postMessage(message: HashJob): void {
    this.posted.push(message);
  }

  on(event: "message", listener: (result: HashResult) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  on(
    event: "message" | "error" | "exit",
    listener: ((result: HashResult) => void) | ((err: Error) => void) | ((code: number) => void),
  ): void {
    if (event === "message") {
      this.#messageListeners.push(listener as (result: HashResult) => void);
    } else if (event === "error") {
      this.#errorListeners.push(listener as (err: Error) => void);
    } else {
      this.#exitListeners.push(listener as (code: number) => void);
    }
  }

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }

  unref(): void {
    // no-op: nothing to unref for a fake
  }

  emitMessage(result: HashResult): void {
    for (const listener of this.#messageListeners) {
      listener(result);
    }
  }

  emitError(err: Error): void {
    for (const listener of this.#errorListeners) {
      listener(err);
    }
  }

  emitExit(code: number): void {
    for (const listener of this.#exitListeners) listener(code);
  }

  get lastJob(): HashJob {
    return this.jobAt(this.posted.length - 1);
  }

  jobAt(index: number): HashJob {
    const job = this.posted[index];
    if (job === undefined) {
      throw new Error(`worker has no job at index ${index}`);
    }
    return job;
  }
}

function nthWorker(workers: FakeWorker[], index: number): FakeWorker {
  const worker = workers[index];
  if (worker === undefined) {
    throw new Error(`no worker at index ${index}`);
  }
  return worker;
}

function trackingFactory(): { factory: () => HashWorker; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  return {
    workers,
    factory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  };
}

describe("HashWorkerPool", () => {
  it("spawns the pool lazily and resolves a job with the worker's result", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 2);

    const result = pool.hashFile("md5", "/a");
    expect(workers).toHaveLength(2);

    const worker = nthWorker(workers, 0);
    worker.emitMessage({ id: worker.lastJob.id, hash: "abc", numBytes: 10 });

    await expect(result).resolves.toEqual({ hash: "abc", numBytes: 10 });
  });

  it("queues jobs beyond the pool size and dispatches them as workers free up", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 2);

    const p1 = pool.hashFile("md5", "/1");
    const p2 = pool.hashFile("md5", "/2");
    const p3 = pool.hashFile("md5", "/3");

    // Two workers, three jobs: two dispatched, one queued.
    expect(workers.flatMap((w) => w.posted)).toHaveLength(2);

    const w0 = nthWorker(workers, 0);
    const w1 = nthWorker(workers, 1);
    w0.emitMessage({ id: w0.lastJob.id, hash: "h1", numBytes: 1 });
    // Freeing w0 pulls the queued third job onto it.
    expect(w0.posted).toHaveLength(2);
    expect(w0.jobAt(1).filePath).toBe("/3");

    w0.emitMessage({ id: w0.lastJob.id, hash: "h3", numBytes: 3 });
    w1.emitMessage({ id: w1.lastJob.id, hash: "h2", numBytes: 2 });

    await expect(p1).resolves.toEqual({ hash: "h1", numBytes: 1 });
    await expect(p2).resolves.toEqual({ hash: "h2", numBytes: 2 });
    await expect(p3).resolves.toEqual({ hash: "h3", numBytes: 3 });
  });

  it("rejects only the crashed worker's job and replaces it on new demand", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 2);

    const p1 = pool.hashFile("md5", "/1");
    const p2 = pool.hashFile("md5", "/2");

    const w0 = nthWorker(workers, 0);
    const w1 = nthWorker(workers, 1);
    w0.emitError(new Error("boom"));

    await expect(p1).rejects.toThrow("boom");
    expect(workers).toHaveLength(2);

    // The other in-flight job is unaffected.
    w1.emitMessage({ id: w1.lastJob.id, hash: "h2", numBytes: 2 });
    await expect(p2).resolves.toEqual({ hash: "h2", numBytes: 2 });

    const next = pool.hashFile("md5", "/3");
    expect(workers).toHaveLength(3);
    w1.emitMessage({ id: w1.lastJob.id, hash: "h3", numBytes: 3 });
    await expect(next).resolves.toEqual({ hash: "h3", numBytes: 3 });
  });

  it("rejects the job and drops it from the queue when a worker cannot be spawned", async () => {
    const workers: FakeWorker[] = [];
    let calls = 0;
    const factory = (): HashWorker => {
      calls += 1;
      if (calls === 1) {
        throw new Error("spawn failed");
      }
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    };
    const pool = new HashWorkerPool(factory, 1);

    await expect(pool.hashFile("md5", "/first")).rejects.toThrow("spawn failed");

    // The second call spawns successfully; the first job must not linger in the
    // queue and run on this worker, or it would hash for an already-rejected
    // promise.
    const p2 = pool.hashFile("md5", "/second");
    const worker = nthWorker(workers, 0);
    expect(worker.posted).toHaveLength(1);
    expect(worker.jobAt(0).filePath).toBe("/second");

    worker.emitMessage({ id: worker.lastJob.id, hash: "ok", numBytes: 1 });
    await expect(p2).resolves.toEqual({ hash: "ok", numBytes: 1 });
  });

  it("ignores unexpected replies while retaining the active job", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 1);
    const first = pool.hashFile("md5", "/1");
    const second = pool.hashFile("md5", "/2");
    const worker = nthWorker(workers, 0);
    const firstId = worker.lastJob.id;
    worker.emitMessage({ id: firstId + 999, hash: "stray", numBytes: 0 });
    expect(worker.posted).toHaveLength(1);
    worker.emitMessage({ id: firstId, hash: "one", numBytes: 1 });
    await expect(first).resolves.toEqual({ hash: "one", numBytes: 1 });
    worker.emitMessage({ id: worker.lastJob.id, hash: "two", numBytes: 2 });
    await expect(second).resolves.toEqual({ hash: "two", numBytes: 2 });
  });

  it("replaces a worker after a clean exit", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 1);
    const first = pool.hashFile("md5", "/1");
    const rejected = expect(first).rejects.toThrow("exit code 0");
    const second = pool.hashFile("md5", "/2");
    nthWorker(workers, 0).emitExit(0);
    expect(workers).toHaveLength(2);
    const replacement = nthWorker(workers, 1);
    replacement.emitMessage({ id: replacement.lastJob.id, hash: "two", numBytes: 2 });
    await rejected;
    await expect(second).resolves.toEqual({ hash: "two", numBytes: 2 });
  });

  it("ignores an exit and late reply from an already failed worker", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 1);
    const first = pool.hashFile("md5", "/1");
    const rejected = expect(first).rejects.toThrow("boom");
    const second = pool.hashFile("md5", "/2");
    const failed = nthWorker(workers, 0);
    failed.emitError(new Error("boom"));
    failed.emitExit(1);
    failed.emitMessage({ id: failed.lastJob.id, hash: "late", numBytes: 1 });
    expect(workers).toHaveLength(2);
    const replacement = nthWorker(workers, 1);
    replacement.emitMessage({ id: replacement.lastJob.id, hash: "two", numBytes: 2 });
    await rejected;
    await expect(second).resolves.toEqual({ hash: "two", numBytes: 2 });
  });

  it("rejects queued work if replacement creation fails", async () => {
    const worker = new FakeWorker();
    let calls = 0;
    const pool = new HashWorkerPool(() => {
      if (++calls > 1) throw new Error("replacement failed");
      return worker;
    }, 1);
    const first = pool.hashFile("md5", "/1");
    const second = pool.hashFile("md5", "/2");
    const firstRejected = expect(first).rejects.toThrow("boom");
    const secondRejected = expect(second).rejects.toThrow("replacement failed");
    expect(() => worker.emitError(new Error("boom"))).not.toThrow();
    await firstRejected;
    await secondRejected;
  });

  it("settles active and queued jobs and terminates every worker on shutdown", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 3);

    const pending = Promise.allSettled(
      ["1", "2", "3", "4"].map((file) => pool.hashFile("md5", file)),
    );
    expect(workers).toHaveLength(3);

    const shutdown = pool.shutdown();
    await expect(pool.hashFile("md5", "during shutdown")).rejects.toThrow("shut down");
    await shutdown;
    expect((await pending).every((result) => result.status === "rejected")).toBe(true);
    expect(workers.every((w) => w.terminated)).toBe(true);
    const restarted = pool.hashFile("md5", "later");
    const fresh = nthWorker(workers, 3);
    fresh.emitMessage({ id: fresh.lastJob.id, hash: "ok", numBytes: 1 });
    await expect(restarted).resolves.toEqual({ hash: "ok", numBytes: 1 });
    await pool.shutdown();
  });

  it("stops replacing failed workers once queued work has settled", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 1);
    const results = Promise.allSettled([pool.hashFile("md5", "/1"), pool.hashFile("md5", "/2")]);
    nthWorker(workers, 0).emitExit(0);
    nthWorker(workers, 1).emitExit(0);
    expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(workers).toHaveLength(2);

    const next = pool.hashFile("md5", "/3");
    const recovered = nthWorker(workers, 2);
    recovered.emitMessage({ id: recovered.lastJob.id, hash: "ok", numBytes: 3 });
    await expect(next).resolves.toEqual({ hash: "ok", numBytes: 3 });
    await pool.shutdown();
  });

  it("does not replace an idle worker that exits", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 1);
    const result = pool.hashFile("md5", "/1");
    const worker = nthWorker(workers, 0);
    worker.emitMessage({ id: worker.lastJob.id, hash: "ok", numBytes: 1 });
    await result;
    worker.emitExit(0);
    expect(workers).toHaveLength(1);
    await pool.shutdown();
  });

  it("accepts legacy error replies and reuses the worker for queued work", async () => {
    const { factory, workers } = trackingFactory();
    const pool = new HashWorkerPool(factory, 1);
    const failed = pool.hashFile("md5", "/missing");
    const rejected = expect(failed).rejects.toMatchObject({
      message: "legacy file error",
      data: { kind: "setup-error", component: "hash-worker" },
    });
    const next = pool.hashFile("md5", "/valid");
    const worker = nthWorker(workers, 0);
    worker.emitMessage({ id: worker.lastJob.id, error: "legacy file error" });
    worker.emitMessage({ id: worker.lastJob.id, hash: "valid", numBytes: 5 });
    await rejected;
    await expect(next).resolves.toEqual({ hash: "valid", numBytes: 5 });
    expect(workers).toHaveLength(1);
    await pool.shutdown();
  });
});
