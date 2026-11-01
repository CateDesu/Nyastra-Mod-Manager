import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import Nexus from "@nexusmods/nexus-api";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";

import { test } from "@/test-utils/harnessTest";

import { userInfo } from "./selectors";
import { getUserInfo } from "./util";

describe("account refresh with the Nexus transport", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T03:15:00Z"));
  });

  afterEach(() => vi.useRealTimers());

  test.for(["refresh", "another request"])(
    "respects a rate limit from %s and recovers next hour",
    async (firstRequest, { makeApi }) => {
      const key = "transport-fixture-key";
      const harness = makeApi();
      harness.setState((state) => {
        state.confidential.account = { nexus: { APIKey: key } };
      });
      const previous = userInfo(harness.getState());
      let limited = true;
      let requests = 0;
      const server = createServer((request, response) => {
        requests++;
        expect(request.headers.apikey).toBe(key);
        response.writeHead(limited ? 429 : 200, {
          "Content-Type": "application/json",
          "x-rl-hourly-remaining": limited ? "0" : "99",
          "x-rl-daily-remaining": limited ? "0" : "999",
        });
        response.end(
          JSON.stringify({
            user_id: 7,
            name: "Astra",
            email: "fixture@example.invalid",
            profile_url: "",
            is_premium: true,
            is_supporter: false,
          }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const nexus = new Nexus("Transport fixture", "0.0.0", "site", 100);
        Object.assign(nexus, {
          mBaseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        });
        if (firstRequest === "refresh") {
          expect(await getUserInfo(harness.api, nexus)).toBe("rate-limited");
        } else {
          limited = false;
          await nexus.setKey(key);
          limited = true;
          await expect(nexus.getGames()).rejects.toThrow();
        }
        const before = requests;
        for (let index = 0; index < 3; index++) {
          expect(await getUserInfo(harness.api, nexus)).toBe("rate-limited");
        }

        expect(requests).toBe(before);
        expect(userInfo(harness.getState())).toEqual(previous);

        limited = false;
        vi.setSystemTime(Date.now() + 60 * 60 * 1000);
        expect(await getUserInfo(harness.api, nexus)).toBe("updated");
        expect(requests).toBe(before + 1);
        expect(userInfo(harness.getState())).toMatchObject({ userId: 7, isPremium: true });
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );
      }
    },
  );
});
