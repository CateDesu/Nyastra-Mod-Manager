import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { Chunker, DownloadCheckpoint } from "@vortex/shared/download";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DownloadManager } from "./manager";
import { urlResolver } from "./resolver";
import { createTestServer, serveFile, type TestServer } from "./test-server";

const body = Buffer.from("first completed range|second completed range|remaining archive payload");
const prefixSize = 20;
let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server.close();
});

describe("checkpoint file contents", () => {
  for (const chunked of [false, true]) {
    const chunker: Chunker<URL> = chunked
      ? (size) => [
          { index: 0, range: { start: 0, end: prefixSize - 1 } },
          { index: 1, range: { start: prefixSize, end: size - 1 } },
        ]
      : () => [];

    for (const localSize of [0, prefixSize - 5, prefixSize]) {
      it(`restores exact bytes with ${localSize} local bytes and chunked=${chunked}`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "download-checkpoint-file-"));
        using route = server.route(serveFile({ body, acceptRanges: true, etag: '"same-file"' }));
        const manager = new DownloadManager({ concurrency: 1 });
        const dest = path.join(root, "partial");
        try {
          await writeFile(dest, body.subarray(0, localSize));
          const checkpoint: DownloadCheckpoint<URL> = {
            downloadId: "restored-download",
            resource: route.url,
            dest,
            etag: '"same-file"',
            completedRanges: [{ start: 0, end: prefixSize - 1 }],
          };

          const handle = manager.resume(checkpoint, urlResolver, chunker);
          await handle.promise;

          expect(await readFile(dest)).toEqual(body);
          expect(handle.getState().status).toBe("completed");
          const gets = route.requests.filter((request) => request.method === "GET");
          expect(gets.length).toBeGreaterThan(0);
          expect(gets[0]?.range).toEqual(
            localSize === prefixSize || chunked
              ? {
                  kind: "bounded",
                  start: localSize === prefixSize ? prefixSize : 0,
                  end: localSize === prefixSize || !chunked ? body.length - 1 : prefixSize - 1,
                }
              : null,
          );
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  }
});
