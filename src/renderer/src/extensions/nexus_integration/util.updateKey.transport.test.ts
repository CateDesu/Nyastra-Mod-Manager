import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import Nexus from "@nexusmods/nexus-api";
import jwt from "jsonwebtoken";
import { describe, expect, test, vi } from "vitest";

import { makeApiHarness, makeUserInfo } from "../../test-utils/builders";
import { setOAuthCredentials, setUserAPIKey } from "./actions/account";
import { setUserInfo } from "./actions/persistent";
import { userInfo } from "./selectors";
import { updateKey } from "./util";

const response = (id: number) => ({
  key: "fixture",
  user_id: id,
  name: `Account ${id}`,
  email: "fixture@example.invalid",
  profile_url: "",
  is_premium: true,
  is_supporter: false,
});

async function loopback() {
  const held: ServerResponse[] = [];
  const requests: { url: string; key: string | string[] | undefined }[] = [];
  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "x-rl-hourly-remaining": "99",
      "x-rl-daily-remaining": "999",
    });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    requests.push({ url: req.url!, key: req.headers.apikey });
    if (req.headers.apikey === "old-fixture-key") {
      held.push(res);
      return;
    }
    reply(
      res,
      req.headers.apikey === "refused-fixture-key" ? 401 : 200,
      req.url === "/games"
        ? []
        : req.headers.apikey === "refused-fixture-key"
          ? { message: "fixture refused" }
          : response(99),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const nexus = new Nexus("Validation fixture", "0.0.0", "site", 1000);
  Object.assign(nexus, { mBaseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  await nexus.getGames();
  return {
    nexus,
    held,
    reply,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

function harness() {
  const h = makeApiHarness();
  h.setState((state) => {
    state.confidential.account = { nexus: { APIKey: "old-fixture-key" } };
  });
  const didLogin = vi.fn();
  h.api.events.on("did-login", didLogin);
  return { h, didLogin };
}

describe("API key ownership with the primed native SDK", () => {
  test.each([200, 401, 503])(
    "ignores the old HTTP %s after the replacement validates",
    async (status) => {
      const fixture = await loopback();
      const { nexus, held, reply } = fixture;
      const { h, didLogin } = harness();
      try {
        const old = updateKey(h.api, nexus, "old-fixture-key");
        await vi.waitFor(() => expect(held).toHaveLength(1));
        h.api.store.dispatch(setUserAPIKey("new-fixture-key"));
        expect(await updateKey(h.api, nexus, "new-fixture-key")).toBe(true);
        expect(userInfo(h.getState())?.userId).toBe(99);
        expect(nexus.getValidationResult()?.user_id).toBe(99);
        const state = h.getState();
        const validation = nexus.getValidationResult();
        reply(held[0], status, status === 200 ? response(7) : { message: "old fixture failed" });
        expect(await old).toBe(false);
        expect(h.getState()).toBe(state);
        expect(nexus.getValidationResult()).toBe(validation);
        expect(didLogin.mock.calls).toEqual([[null]]);
        expect(h.notifications).toEqual([]);
        expect(h.errorNotifications).toEqual([]);
        expect(fixture.requests).toEqual([
          { url: "/games", key: undefined },
          { url: "/users/validate", key: "old-fixture-key" },
          { url: "/users/validate", key: "new-fixture-key" },
        ]);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each(["logout", "OAuth", "key reuse"])(
    "protects the SDK result after %s even without a replacement setKey",
    async (transition) => {
      const fixture = await loopback();
      const { nexus, held, reply } = fixture;
      const { h, didLogin } = harness();
      try {
        const old = updateKey(h.api, nexus, "old-fixture-key");
        await vi.waitFor(() => expect(held).toHaveLength(1));
        if (transition === "OAuth") {
          const token = jwt.sign(
            { user: { id: 99, username: "OAuth fixture", membership_roles: ["premium"] } },
            "synthetic-test-secret",
          );
          h.api.store.dispatch(setOAuthCredentials(token, "fixture-refresh", "fixture"));
          await nexus.setTokenProvider(async () => token);
        } else {
          h.api.store.dispatch(
            setUserAPIKey(transition === "logout" ? undefined : "intermediate-fixture-key"),
          );
          if (transition === "key reuse") h.api.store.dispatch(setUserAPIKey("old-fixture-key"));
        }
        h.api.store.dispatch(setUserInfo(makeUserInfo({ userId: 99 })));
        const state = h.getState();
        const validation = nexus.getValidationResult();
        reply(held[0], 200, response(7));
        expect(await old).toBe(false);
        expect(h.getState()).toBe(state);
        expect(nexus.getValidationResult()).toBe(validation);
        expect(didLogin).not.toHaveBeenCalled();
        expect(h.notifications).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
  );

  test("keeps the current refusal visible in Redux and the SDK", async () => {
    const fixture = await loopback();
    const { h, didLogin } = harness();
    try {
      h.api.store.dispatch(setUserAPIKey("new-fixture-key"));
      expect(await updateKey(h.api, fixture.nexus, "new-fixture-key")).toBe(true);
      h.api.store.dispatch(setUserAPIKey("refused-fixture-key"));
      expect(await updateKey(h.api, fixture.nexus, "refused-fixture-key")).toBe(false);
      expect(userInfo(h.getState())).toBeUndefined();
      expect(fixture.nexus.getValidationResult()).toBeNull();
      expect(h.notifications.length + h.errorNotifications.length).toBe(1);
      expect(didLogin).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.close();
    }
  });

  test.each([200, 503])(
    "guards SDK setKey callers without the renderer callback for old HTTP %s",
    async (status) => {
      const fixture = await loopback();
      const { nexus, held, reply } = fixture;
      try {
        const old = nexus.setKey("old-fixture-key").then(
          (value) => value,
          (error) => error,
        );
        await vi.waitFor(() => expect(held).toHaveLength(1));
        await nexus.setKey("new-fixture-key");
        const validation = nexus.getValidationResult();
        reply(held[0], status, status === 200 ? response(7) : { message: "old fixture failed" });
        await old;
        expect(nexus.getValidationResult()).toBe(validation);
        expect(validation.user_id).toBe(99);
      } finally {
        await fixture.close();
      }
    },
  );

  test.each([200, 503])("keeps revalidation from republishing old HTTP %s", async (status) => {
    const fixture = await loopback();
    const { nexus, held, reply } = fixture;
    try {
      const initial = nexus.setKey("old-fixture-key");
      await vi.waitFor(() => expect(held).toHaveLength(1));
      reply(held[0], 200, response(7));
      await initial;
      const old = nexus.revalidate().then(
        (value) => value,
        (error) => error,
      );
      await vi.waitFor(() => expect(held).toHaveLength(2));
      await nexus.setKey("new-fixture-key");
      const validation = nexus.getValidationResult();
      reply(held[1], status, status === 200 ? response(7) : { message: "old fixture failed" });
      await old;
      expect(nexus.getValidationResult()).toBe(validation);
      expect(validation.user_id).toBe(99);
    } finally {
      await fixture.close();
    }
  });

  test("rejects an obsolete SDK mutation before changing headers or sending a request", async () => {
    const fixture = await loopback();
    try {
      expect(await fixture.nexus.setKey("new-fixture-key", () => false)).toBeNull();
      await fixture.nexus.getGames();
      expect(fixture.requests).toEqual([
        { url: "/games", key: undefined },
        { url: "/games", key: undefined },
      ]);
      expect(fixture.nexus.getValidationResult()).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
});
