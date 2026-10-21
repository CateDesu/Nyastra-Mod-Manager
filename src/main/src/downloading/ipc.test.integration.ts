import { access, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { WireDownloadCheckpoint, WireResolvedResource } from "@vortex/shared/ipc";
import { expect, it, vi } from "vitest";

import { init } from "./ipc";
import { DownloadManager } from "./manager";
import { urlResolver } from "./resolver";
import { createTestServer, serveFile, withHooks } from "./test-server";

const { handlers, resolveResource } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  resolveResource: vi.fn(),
}));
vi.mock("../ipc", () => ({
  betterIpcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    callback: resolveResource,
  },
}));

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  Promise.resolve(handlers.get(channel)!({ sender: {} }, ...args) as T);

it("cancels a queued transfer without waiting for another transfer's slot", async () => {
  const server = await createTestServer();
  const directory = await mkdtemp(path.join(tmpdir(), "nyastra-queued-cancel-"));
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const route = server.route(
    withHooks(serveFile({ body: Buffer.alloc(256 * 1024), chunkSize: 64 * 1024 }), {
      beforeChunk: async (_ctx, { index }) => {
        if (index === 1) await gate;
      },
    }),
  );
  const manager = new DownloadManager({ concurrency: 1 });
  const blocker = manager.download(route.url, path.join(directory, "blocker"), urlResolver);
  let cancellation: Promise<unknown> | undefined;
  try {
    await vi.waitFor(() => expect(blocker.getState().bytesWritten).toBeGreaterThan(0));
    resolveResource.mockResolvedValue({ probeEndpoint: { url: route.url.href } });
    handlers.clear();
    init(manager);
    const destination = path.join(directory, "queued");
    const { downloadId } = await invoke<{ downloadId: string }>("download:start", destination, 0);
    expect(manager.getState(downloadId)?.status).toBe("queued");
    let canceled = false;
    cancellation = invoke("download:cancel", downloadId).then(() => {
      canceled = true;
    });
    await vi.waitFor(() => expect(canceled).toBe(true), { timeout: 1000 });
    expect(blocker.getState().status).toBe("running");
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    release();
    blocker.cancel();
    await blocker.promise.catch(() => undefined);
    await cancellation;
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("waits for a paused transfer to close its real file before cancellation responds", async () => {
  const server = await createTestServer();
  const directory = await mkdtemp(path.join(tmpdir(), "nyastra-pausing-cancel-"));
  const destination = path.join(directory, "partial");
  const route = server.route(serveFile({ body: Buffer.alloc(4096), acceptRanges: true }));
  const manager = new DownloadManager({ concurrency: 1, bytesPerSecond: 1024 });
  const openFiles = async () => {
    const descriptors = await readdir("/proc/self/fd");
    const targets = await Promise.all(
      descriptors.map((fd) => readlink(`/proc/self/fd/${fd}`).catch(() => "")),
    );
    return targets.filter((target) => target === destination).length;
  };
  let downloadId: string | undefined;
  let pausing: Promise<unknown> | undefined;
  let cancellation: Promise<unknown> | undefined;
  try {
    resolveResource.mockResolvedValue({ probeEndpoint: { url: route.url.href } });
    handlers.clear();
    init(manager);
    ({ downloadId } = await invoke<{ downloadId: string }>("download:start", destination, 0));
    await vi.waitFor(() => expect(manager.getState(downloadId!)?.bytesReceived).toBeGreaterThan(0));
    expect(await openFiles()).toBe(1);
    pausing = invoke("download:pause", downloadId);
    expect(manager.getState(downloadId)?.status).toBe("paused");
    let canceled = false;
    cancellation = invoke("download:cancel", downloadId).then(() => {
      canceled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(canceled).toBe(false);
    await cancellation;
    expect(await openFiles()).toBe(0);
    await pausing;
    expect(manager.numRunning).toBe(0);
    await expect(access(destination)).resolves.toBeUndefined();
    expect(manager.getState(downloadId)?.status).toBe("paused");
  } finally {
    const handle = downloadId === undefined ? undefined : manager.get(downloadId);
    handle?.cancel();
    await Promise.allSettled([handle?.promise, pausing, cancellation]);
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const paused of [false, true]) {
  it(`cancellation releases only an active transfer's partial file with paused=${paused}`, async () => {
    const server = await createTestServer();
    const directory = await mkdtemp(path.join(tmpdir(), "nyastra-cancel-ipc-"));
    const destination = path.join(directory, "partial");
    const body = Buffer.alloc(256 * 1024, 0x61);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const route = server.route(
      withHooks(serveFile({ body, acceptRanges: true, chunkSize: 64 * 1024 }), {
        beforeChunk: async (_ctx, { index }) => {
          if (index === 1) await gate;
        },
      }),
    );
    const manager = new DownloadManager({ concurrency: 1 });
    let downloadId: string | undefined;
    try {
      resolveResource.mockResolvedValue({ probeEndpoint: { url: route.url.href } });
      handlers.clear();
      init(manager);
      ({ downloadId } = await invoke<{ downloadId: string }>("download:start", destination, 0));
      await vi.waitFor(() =>
        expect(manager.getState(downloadId!)?.bytesWritten).toBeGreaterThan(0),
      );
      if (paused) await invoke("download:pause", downloadId);
      await invoke("download:cancel", downloadId);
      if (paused) {
        expect((await readFile(destination)).length).toBeGreaterThan(0);
        expect(manager.getState(downloadId)?.status).toBe("paused");
      } else {
        await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
        expect(manager.getState(downloadId)?.status).toBe("canceled");
      }
    } finally {
      release();
      const handle = downloadId === undefined ? undefined : manager.get(downloadId);
      handle?.cancel();
      await handle?.promise.catch(() => undefined);
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const chunked of [false, true]) {
  it(`preserves resolved headers and endpoints across a serialized checkpoint with chunked=${chunked}`, async () => {
    const server = await createTestServer();
    const directory = await mkdtemp(path.join(tmpdir(), "nyastra-download-ipc-"));
    const body = Buffer.alloc(chunked ? 12 * 1024 * 1024 : 256 * 1024, 0x61);
    const destination = path.join(directory, "archive");
    const referer = "https://mods.example/download";
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resumed = false;
    const file = serveFile({ body, acceptRanges: true, chunkSize: 64 * 1024, etag: '"fixture"' });
    const route = server.route(
      withHooks(file, {
        beforeChunk: async (ctx, { index }) => {
          if (resumed) return;
          if (chunked ? ctx.range?.kind === "bounded" && ctx.range.start > 0 : index === 1)
            await gate;
        },
      }),
    );
    const probe = chunked
      ? server.route(async (ctx) => {
          if (ctx.req.method === "HEAD") await file(ctx);
          else {
            ctx.res.writeHead(405);
            ctx.res.end();
          }
        })
      : route;
    const removeMiddleware = server.use(async (ctx, next) => {
      if (ctx.req.headers.referer !== referer) {
        ctx.res.writeHead(403);
        ctx.res.end();
        return;
      }
      await next();
    });
    const resource: WireResolvedResource = {
      probeEndpoint: { url: probe.url.href, headers: { Referer: referer } },
      ...(chunked
        ? {
            chunkEndpoints: Array.from({ length: 4 }, () => ({
              url: route.url.href,
              headers: { Referer: referer },
            })),
          }
        : {}),
    };
    const manager = new DownloadManager({ concurrency: 1 });
    let restored: DownloadManager | undefined;
    let downloadId: string | undefined;
    try {
      resolveResource.mockResolvedValue(resource);
      handlers.clear();
      init(manager);
      ({ downloadId } = await invoke<{ downloadId: string }>("download:start", destination, 0));
      await vi.waitFor(() => {
        expect(manager.getState(downloadId!)?.bytesWritten).toBeGreaterThan(
          chunked ? 3 * 1024 * 1024 - 1 : 0,
        );
      });
      const checkpoint = JSON.parse(
        JSON.stringify(await invoke("download:pause", downloadId)),
      ) as WireDownloadCheckpoint;
      expect(checkpoint.completedRanges.length).toBeGreaterThan(0);
      resumed = true;
      release();
      restored = new DownloadManager({ concurrency: 1 });
      handlers.clear();
      init(restored);
      await invoke("download:resume", checkpoint);
      const outcome = await restored.get(downloadId)!.promise.then(
        () => "completed",
        (error: Error) => error.message,
      );
      expect(outcome).toBe("completed");
      expect(Buffer.compare(await readFile(destination), body)).toBe(0);
      expect(route.requests.filter((request) => request.method === "GET").length).toBeGreaterThan(
        1,
      );
    } finally {
      resumed = true;
      release();
      for (const active of [manager, restored]) {
        const handle = downloadId === undefined ? undefined : active?.get(downloadId);
        handle?.cancel();
        await handle?.promise.catch(() => undefined);
      }
      removeMiddleware();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

it("resumes a persisted checkpoint from before resolved endpoints were stored", async () => {
  const server = await createTestServer();
  const directory = await mkdtemp(path.join(tmpdir(), "nyastra-legacy-checkpoint-"));
  const body = Buffer.alloc(8192, 0x62);
  const route = server.route(serveFile({ body, acceptRanges: true }));
  const destination = path.join(directory, "archive");
  const manager = new DownloadManager({ concurrency: 1 });
  const downloadId = "legacy";
  try {
    await writeFile(destination, body.subarray(0, 1024));
    handlers.clear();
    init(manager);
    await invoke("download:resume", {
      downloadId,
      resource: route.url.href,
      dest: destination,
      completedRanges: [{ start: 0, end: 1023 }],
      etag: undefined,
    } satisfies WireDownloadCheckpoint);
    await manager.get(downloadId)!.promise;
    expect(Buffer.compare(await readFile(destination), body)).toBe(0);
  } finally {
    const handle = manager.get(downloadId);
    handle?.cancel();
    await handle?.promise.catch(() => undefined);
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
