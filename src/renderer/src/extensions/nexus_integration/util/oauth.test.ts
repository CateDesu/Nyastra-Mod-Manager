import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import https from "node:https";
import { createServer, type AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import OAuth from "./oauth";

vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof https>();
  const request = vi.fn(actual.request);
  return { ...actual, request, default: { ...actual, request } };
});
vi.mock("../../../util/getVortexPath", async () => {
  const { resolve } = await import("node:path");
  return { default: () => resolve(__dirname, "../../../../../../assets") };
});

beforeEach(async () => {
  const actual = await vi.importActual<typeof https>("node:https");
  vi.mocked(https.request).mockImplementation(actual.request);
});

const sessions: OAuth[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session["stopServer"]();
  vi.restoreAllMocks();
});

function session(baseUrl: string) {
  const oauth = new OAuth({
    baseUrl,
    clientId: "local-test-client",
    redirectUrl: "http://127.0.0.1:PORT",
    getRedirectUrl: (port) => `http://127.0.0.1:${port}`,
  });
  sessions.push(oauth);
  return oauth;
}

function localRequest(url: URL, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("OAuth token exchange", () => {
  it.each(["unknown", "constructor", "__proto__"])(
    "ignores an unknown callback state %s without contacting the token server",
    async (state) => {
      const oauth = session("https://local.test");
      vi.mocked(https.request).mockImplementation(() => {
        throw new Error("Unexpected token request");
      });
      await expect(oauth.receiveCode("unused-code", state)).resolves.toBeUndefined();
      expect(https.request).not.toHaveBeenCalled();
    },
  );

  it("finishes with an error when the actual TLS connection is reset", async () => {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const oauth = session(`https://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const received = vi.fn();
      let authorize: URL;
      await oauth.sendRequest(received, (url) => (authorize = new URL(url)));
      const callback = new URL(authorize!.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "test-code");
      callback.searchParams.set("state", authorize!.searchParams.get("state")!);
      expect((await localRequest(callback, "OPTIONS")).status).toBe(405);
      expect(received).not.toHaveBeenCalled();
      const response = await localRequest(callback);
      expect(response.status).toBe(400);
      expect(response.body).toContain("was unable to log in");
      await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
      expect(received.mock.calls[0]![0]).toBeInstanceOf(Error);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("keeps each overlapping authorization request paired with its own PKCE verifier", async () => {
    const posted: URLSearchParams[] = [];
    vi.mocked(https.request).mockImplementation(((
      _options: unknown,
      onResponse: (response: EventEmitter) => void,
    ) => {
      const request = new EventEmitter() as EventEmitter & {
        write: (body: string) => void;
        end: () => void;
      };
      request.write = (body) => posted.push(new URLSearchParams(body));
      request.end = () => {
        const response = Object.assign(new EventEmitter(), { statusCode: 200 });
        onResponse(response);
        response.emit("data", JSON.stringify({ access_token: "token", refresh_token: "refresh" }));
        response.emit("end");
        request.emit("close");
      };
      return request;
    }) as typeof https.request);
    const oauth = session("https://local.test");
    const authorize: URL[] = [];
    const callbacks = [vi.fn(), vi.fn()];
    await Promise.all(
      callbacks.map((callback) =>
        oauth.sendRequest(callback, (url) => authorize.push(new URL(url))),
      ),
    );
    for (const url of authorize) {
      await oauth.receiveCode("test-code", url.searchParams.get("state")!);
    }
    expect(posted).toHaveLength(2);
    for (const [index, request] of posted.entries()) {
      const verifier = request.get("code_verifier")!;
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
      expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
        authorize[index]!.searchParams.get("code_challenge"),
      );
      expect(callbacks[index]).toHaveBeenCalledOnce();
    }
    expect(posted[0]!.get("code_verifier")).not.toBe(posted[1]!.get("code_verifier"));
  });
});
