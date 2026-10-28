// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { ICollectionManifest } from "@nexusmods/nexus-api";
import { createNexusV3Client, V3ApiError } from "@vortex/nexus-api-v3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { IExtensionApi } from "../../../types/IExtensionContext";
import type { VortexNexusV3ClientOptions } from "../nexusV3Client";
import { submitCollectionV3 } from "./submitCollectionV3";

const endpoint = vi.hoisted(() => ({ url: "" }));
vi.stubGlobal("window", {
  api: {
    app: {
      getName: async () => "test",
      getVersion: async () => "test",
      getVortexPaths: async () => ({}),
    },
    window: { getId: async () => 0 },
  },
});
vi.mock("../nexusV3Client", () => ({
  createVortexNexusV3Client: (_api: IExtensionApi, options?: VortexNexusV3ClientOptions) =>
    createNexusV3Client({ baseUrl: endpoint.url, ...options }),
}));
vi.mock("../../../logging", () => ({ log: vi.fn() }));
vi.mock("../selectors", () => ({ isLoggedIn: () => true }));

let server: Server;
let directory: string;
let filePath: string;
let requests: string[];
let respond: (request: IncomingMessage, response: ServerResponse) => void;
const transfer = vi.fn<() => Promise<void>>();
const manifest: ICollectionManifest = {
  info: { author: "Test", name: "Test", domainName: "skyrim" },
  mods: [],
};
const api = { getState: () => ({}) } as unknown as IExtensionApi;

function respondNormally(request: IncomingMessage, response: ServerResponse): void {
  const route = `${request.method} ${request.url}`;
  if (request.method === "PATCH") {
    response.writeHead(204);
    response.end();
    return;
  }
  const data =
    route === "POST /uploads"
      ? { id: "upload-1", presigned_url: `${endpoint.url}/storage`, state: "created" }
      : route === "POST /collections" || route.endsWith("/revisions")
        ? { id: "1", revision_id: "2", revision_number: 1, revision_status: "draft" }
        : { id: "upload-1", state: "available" };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ data }));
}

beforeEach(async () => {
  requests = [];
  respond = respondNormally;
  transfer.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("window", {
    api: { uploader: { file: transfer, getProgress: async () => null, cancel: async () => {} } },
  });
  directory = await mkdtemp(path.join(tmpdir(), "nyastra-submit-boundaries-"));
  filePath = path.join(directory, "collection.7z");
  await writeFile(filePath, "test archive");
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push(`${request.method} ${request.url}`);
      respond(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No HTTP address");
  endpoint.url = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

it("preserves an empty HTTP rejection and never submits the following revision", async () => {
  respond = (request, response) => {
    if (request.method === "PATCH") {
      response.writeHead(403, { "content-length": "0" });
      response.end();
    } else respondNormally(request, response);
  };

  const submission = submitCollectionV3(api, manifest, filePath, 5);

  await expect(submission).rejects.toBeInstanceOf(V3ApiError);
  await expect(submission).rejects.toMatchObject({ status: 403 });
  expect(requests).toEqual([
    "POST /uploads",
    "POST /uploads/upload-1/finalise",
    "GET /uploads/upload-1",
    "PATCH /collections/5",
  ]);
});

it("abandons an already canceled submission before contacting the API", async () => {
  await expect(
    submitCollectionV3(api, manifest, filePath, undefined, {
      abortSignal: AbortSignal.abort(),
    }),
  ).rejects.toMatchObject({ data: { kind: "user-canceled" } });

  expect(requests).toEqual([]);
  expect(transfer).not.toHaveBeenCalled();
});

it.each([
  "POST /uploads",
  "POST /uploads/upload-1/finalise",
  "GET /uploads/upload-1",
  "PATCH /collections/5",
])("cancels a submission waiting for %s without later API writes", async (target) => {
  let held: { request: IncomingMessage; response: ServerResponse } | undefined;
  respond = (request, response) => {
    if (`${request.method} ${request.url}` === target) held = { request, response };
    else respondNormally(request, response);
  };
  const controller = new AbortController();
  const submission = submitCollectionV3(
    api,
    manifest,
    filePath,
    target.startsWith("PATCH") ? 5 : undefined,
    {
      abortSignal: controller.signal,
    },
  );
  let settled = false;
  void submission.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  try {
    await vi.waitFor(() => expect(held).toBeDefined(), { timeout: 1000 });
    const atAbort = [...requests];
    controller.abort();
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 500 });
    await expect(submission).rejects.toMatchObject({ data: { kind: "user-canceled" } });
    await vi.waitFor(() => expect(held?.response.destroyed).toBe(true), { timeout: 500 });
    expect(requests).toEqual(atAbort);
    if (target === "POST /uploads") expect(transfer).not.toHaveBeenCalled();
  } finally {
    if (held) respondNormally(held.request, held.response);
    await submission.catch(() => undefined);
  }
});

it("cancels between availability polls and stops further requests", async () => {
  let polls = 0;
  respond = (request, response) => {
    if (request.method === "GET" && polls++ === 0) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { id: "upload-1", state: "created" } }));
    } else respondNormally(request, response);
  };
  const controller = new AbortController();
  const submission = submitCollectionV3(api, manifest, filePath, undefined, {
    abortSignal: controller.signal,
  });
  let settled = false;
  void submission.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  try {
    await vi.waitFor(() => expect(polls).toBe(1), { timeout: 1000 });
    controller.abort();
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 500 });
    await expect(submission).rejects.toMatchObject({ data: { kind: "user-canceled" } });
    expect(requests).toEqual([
      "POST /uploads",
      "POST /uploads/upload-1/finalise",
      "GET /uploads/upload-1",
    ]);
  } finally {
    await submission.catch(() => undefined);
  }
});

it("keeps another submission running when one is canceled", async () => {
  let held: { request: IncomingMessage; response: ServerResponse } | undefined;
  respond = (request, response) => {
    if (request.method === "POST" && request.url === "/uploads" && held === undefined) {
      held = { request, response };
    } else respondNormally(request, response);
  };
  const controller = new AbortController();
  const canceled = submitCollectionV3(api, manifest, filePath, undefined, {
    abortSignal: controller.signal,
  });
  let settled = false;
  void canceled.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await vi.waitFor(() => expect(held).toBeDefined(), { timeout: 1000 });
    const other = submitCollectionV3(api, manifest, filePath, undefined);
    controller.abort();
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 500 });
    await expect(canceled).rejects.toMatchObject({ data: { kind: "user-canceled" } });
    await expect(other).resolves.toMatchObject({ success: true });
    expect(transfer).toHaveBeenCalledOnce();
    expect(requests.filter((route) => route === "POST /collections")).toHaveLength(1);
  } finally {
    if (held) respondNormally(held.request, held.response);
    await canceled.catch(() => undefined);
  }
});
