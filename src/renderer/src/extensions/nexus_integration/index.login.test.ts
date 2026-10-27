import Nexus from "@nexusmods/nexus-api";
import Quota from "@nexusmods/nexus-api/lib/Quota";
import { afterEach, expect, vi } from "vitest";

import { test } from "@/test-utils/harnessTest";
import type { IExtensionContext } from "@/types/IExtensionContext";

import type * as NexusExtension from "./index";

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

afterEach(() => vi.restoreAllMocks());

test("restores a saved API key before the first download after startup", async ({ makeApi }) => {
  const harness = makeApi();
  harness.setState((state) => {
    state.confidential.account["nexus"] = { APIKey: "saved-test-key" };
    state.session.base = { networkConnected: true } as typeof state.session.base;
    state.settings["nexus"] = { associateNXM: true };
  });
  harness.api.registerProtocol = vi.fn().mockResolvedValue(false);
  harness.api.registerRepositoryLookup = vi.fn();
  harness.api.addMetaServer = vi.fn();
  harness.api.laterT = (text) => text;

  // Exercise real credential headers without network requests.
  vi.spyOn(Quota.prototype, "wait").mockResolvedValue(undefined);
  const transport = Nexus.prototype as unknown as {
    request: (url: string, args: { headers: Record<string, string> }) => Promise<unknown>;
  };
  const request = vi.spyOn(transport, "request").mockImplementation(async (url, args) => {
    if (url.endsWith("/users/validate")) {
      return { user_id: 7, name: "Astra", is_premium: true, is_supporter: false };
    }
    if (url.includes("/download_link")) {
      if (args.headers.APIKEY !== "saved-test-key") throw new Error("Missing API key");
      return [{ URI: "https://example.invalid/helldivers.7z" }];
    }
    return { version: "1.0.0" };
  });

  const startup: Array<() => void> = [];
  const context = new Proxy(
    {
      api: harness.api,
      once: (callback: () => void) => startup.push(callback),
    } as unknown as IExtensionContext,
    { get: (target, key) => Reflect.get(target, key) ?? vi.fn() },
  );
  const { default: init } = await vi.importActual<typeof NexusExtension>("./index");
  expect(init(context)).toBe(true);
  let nexus: Nexus;
  context["registerNexusIntegration"]((client: Nexus) => {
    nexus = client;
  });
  startup.forEach((callback) => callback());

  await expect(nexus.getDownloadURLs(845, 11899, undefined, undefined, "site")).resolves.toEqual([
    { URI: "https://example.invalid/helldivers.7z" },
  ]);
  expect(request.mock.calls.some(([url]) => url.endsWith("/users/validate"))).toBe(true);
  await vi.waitFor(() => {
    expect(harness.getState().persistent["nexus"].userInfo).toMatchObject({
      userId: 7,
      name: "Astra",
    });
  });
});
