import Nexus from "@nexusmods/nexus-api";
import { HTTPError } from "@nexusmods/nexus-api";
import Quota from "@nexusmods/nexus-api/lib/Quota";
import PromiseBB from "bluebird";
import { afterEach, beforeAll, expect, vi } from "vitest";

import { test } from "@/test-utils/harnessTest";
import type { IExtensionContext } from "@/types/IExtensionContext";
import * as fs from "@/util/fs";

import type * as NexusExtension from "./index";
import { getUserInfo } from "./util";

vi.mock("./util/tracking", () => ({
  default: class {
    attribute() {}
    once() {}
  },
}));
vi.mock("./util", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  retrieveNexusGames: vi.fn().mockResolvedValue([]),
}));

let init: typeof NexusExtension.default;

beforeAll(async () => {
  init = (await vi.importActual<typeof NexusExtension>("./index")).default;
});

afterEach(() => vi.restoreAllMocks());

test.for([
  { method: "validateKey", rejected: false, echo: false },
  { method: "validateKey", rejected: true, echo: false },
  { method: "validateKey", rejected: true, echo: true },
  { method: "setKey", rejected: false, echo: false },
  { method: "setKey", rejected: true, echo: false },
  { method: "setKey", rejected: true, echo: true },
])(
  "redacts $method credentials when rejected=$rejected and echo=$echo",
  async ({ method, rejected, echo }, { makeApi }) => {
    const key = "request-log-fixture-key";
    const harness = makeApi();
    harness.setState((state) => {
      state.confidential.account = { nexus: { APIKey: key } };
      state.session.base = { networkConnected: true } as typeof state.session.base;
      state.settings["nexus"] = { associateNXM: true };
    });
    harness.api.registerProtocol = vi.fn().mockResolvedValue(false);
    harness.api.registerRepositoryLookup = vi.fn();
    harness.api.addMetaServer = vi.fn();
    harness.api.laterT = (text) => text;

    const writes: string[] = [];
    vi.spyOn(fs, "writeFileAsync").mockImplementation((_filename, contents) => {
      writes.push(String(contents));
      return PromiseBB.resolve();
    });
    vi.spyOn(Quota.prototype, "wait").mockResolvedValue(undefined);
    const transport = Nexus.prototype as unknown as {
      request: (url: string, args: { headers: Record<string, string> }) => Promise<unknown>;
    };
    let rejectValidation = false;
    const failure = new HTTPError(
      503,
      `Fixture validation rejected${echo ? ` ${key} ${key}` : ""}`,
      echo ? key : undefined,
    );
    if (echo) Object.freeze(failure);
    vi.spyOn(transport, "request").mockImplementation(async (url, args) => {
      if (url.endsWith("/users/validate")) {
        expect(args.headers.APIKEY).toBe(key);
        if (rejectValidation) throw failure;
        return {
          key,
          user_id: 7,
          name: "Astra",
          email: "fixture@example.invalid",
          profile_url: "",
          is_premium: true,
          is_supporter: false,
        };
      }
      return { version: "1.0.0" };
    });

    const startup: Array<() => void> = [];
    const context = new Proxy(
      {
        api: harness.api,
        once: (callback: () => void) => startup.push(callback),
      } as unknown as IExtensionContext,
      { get: (target, name) => Reflect.get(target, name) ?? vi.fn() },
    );
    expect(init(context)).toBe(true);
    let nexus: Nexus;
    context["registerNexusIntegration"]((client: Nexus) => {
      nexus = client;
    });
    startup.forEach((callback) => callback());
    await vi.waitFor(() => {
      expect(harness.getState().persistent["nexus"].userInfo?.userId).toBe(7);
      expect(writes.join("\n")).toContain("setKey (");
    });
    writes.length = 0;
    rejectValidation = rejected;

    if (method === "validateKey") {
      await expect(getUserInfo(harness.api, nexus)).resolves.toBe(rejected ? "failed" : "updated");
    } else if (rejected) {
      const error = await nexus.setKey(key).catch((err: HTTPError) => err);
      expect(error).toBeInstanceOf(HTTPError);
      expect(error).toMatchObject({ statusCode: 503 });
      if (error instanceof HTTPError) {
        expect(error.message).not.toContain(key);
        expect(error.stack).not.toContain(key);
        expect(error.body ?? "").not.toContain(key);
      }
    } else {
      await expect(nexus.setKey(key)).resolves.toMatchObject({ user_id: 7 });
    }

    await vi.waitFor(() => expect(writes.join("\n")).toContain(`${method} (`));
    const output = writes.join("\n");
    expect(output).toMatch(
      new RegExp(`${rejected ? "failed" : "success"} - .* ${method} \\(\\) from`),
    );
    expect(output).not.toContain(key);
    if (rejected) expect(output).toContain("Fixture validation rejected");
    if (echo) expect(failure.message).toContain(key);
  },
);
