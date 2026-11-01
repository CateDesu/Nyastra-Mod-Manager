import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import Nexus from "@nexusmods/nexus-api";
import jwt from "jsonwebtoken";
import { afterEach, expect, test, vi } from "vitest";

import { makeApiHarness, makeUserInfo } from "../../test-utils/builders";
import { clearOAuthCredentials, setOAuthCredentials, setUserAPIKey } from "./actions/account";
import { setUserInfo } from "./actions/persistent";
import { onOAuthTokenChanged, onRefreshUserInfo } from "./eventHandlers";
import { userInfo } from "./selectors";
import { updateKey, updateToken } from "./util";
import * as oauthSession from "./util/oauthSession";

const oauthUser = (id: number) => ({
  sub: String(id),
  name: `OAuth ${id}`,
  email: "fixture@example.invalid",
  avatar: "",
  membership_roles: ["premium"],
  preferences: {},
});

async function fixture() {
  const h = makeApiHarness();
  h.setState((state) => {
    state.confidential.account = { nexus: {} };
  });
  const token = jwt.sign(
    { user: { id: 7, username: "OAuth 7", membership_roles: ["premium"] } },
    "disposable-fixture",
  );
  h.api.store.dispatch(setOAuthCredentials(token, "fake-refresh", "fixture"));
  h.api.store.dispatch(setUserInfo(makeUserInfo({ userId: 7 })));
  const credentials = h.getState().confidential.account["nexus"].OAuthCredentials;
  const held: ServerResponse[] = [];
  const requests: string[] = [];
  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "x-rl-hourly-remaining": "99",
      "x-rl-daily-remaining": "999",
    });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    requests.push(req.url!);
    if (req.url === "/oauth/userinfo") held.push(res);
    else
      reply(
        res,
        200,
        req.url === "/games"
          ? []
          : {
              user_id: 99,
              name: "Key 99",
              email: "fixture@example.invalid",
              profile_url: "",
              is_premium: false,
              is_supporter: false,
            },
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const nexus = new Nexus("Ownership fixture", "0.0.0", "site", 1000);
  Object.assign(nexus, { mBaseURL: root, mUserServiceBaseURL: root });
  const transport = nexus as unknown as { request: (target: string, args: unknown) => unknown };
  const request = transport.request.bind(nexus);
  transport.request = (target, args) => {
    if (!target.startsWith(root + "/")) throw new Error("Refusing non-loopback transport");
    return request(target, args);
  };
  vi.spyOn(nexus, "getPreferences").mockResolvedValue({});
  await nexus.getGames();
  await nexus.setTokenProvider(async () => token);
  return {
    h,
    nexus,
    token,
    credentials,
    held,
    requests,
    reply,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

afterEach(() => vi.restoreAllMocks());

for (const entry of ["public refresh", "login validation"] as const) {
  test.each(["logout", "replacement key", "OAuth replacement", "OAuth reuse"])(
    `${entry} ignores an old response after %s`,
    async (transition) => {
      const f = await fixture();
      const { h, nexus, held, reply, credentials, token } = f;
      try {
        const pending =
          entry === "public refresh"
            ? onRefreshUserInfo(nexus, h.api)()
            : updateToken(h.api, nexus, credentials);
        await vi.waitFor(() => expect(held).toHaveLength(1));
        h.api.store.dispatch(clearOAuthCredentials(null));
        onOAuthTokenChanged(h.api, nexus)(credentials, undefined);
        if (transition === "replacement key") {
          h.api.store.dispatch(setUserAPIKey("new-fixture-key"));
          expect(await updateKey(h.api, nexus, "new-fixture-key")).toBe(true);
        }
        if (transition.startsWith("OAuth")) {
          h.api.store.dispatch(setOAuthCredentials("replacement", "replacement", "replacement"));
          if (transition === "OAuth reuse")
            h.api.store.dispatch(setOAuthCredentials(token, "fake-refresh", "fixture"));
          h.api.store.dispatch(setUserInfo(makeUserInfo({ userId: 99 })));
        }
        const state = h.getState();
        const validation = nexus.getValidationResult();
        reply(held[0], 200, oauthUser(7));
        await pending;
        expect(h.getState()).toBe(state);
        expect(userInfo(h.getState())?.userId).toBe(transition === "logout" ? undefined : 99);
        expect(nexus.getValidationResult()).toBe(validation);
        expect(h.errorNotifications).toEqual([]);
        expect(
          f.requests.every((url) => ["/games", "/oauth/userinfo", "/users/validate"].includes(url)),
        ).toBe(true);
      } finally {
        await f.close();
      }
    },
  );
}

test("a retired native SDK provider cannot overwrite a newer validated OAuth session", async () => {
  const f = await fixture();
  const { h, nexus, credentials, token, held, reply } = f;
  let release!: (token: string) => void;
  const oldToken = new Promise<string>((resolve) => {
    release = resolve;
  });
  const newToken = jwt.sign(
    { user: { id: 99, username: "OAuth 99", membership_roles: [] } },
    "disposable-fixture",
  );
  const providers = vi.spyOn(oauthSession, "tokenProviderFor").mockImplementation((api) => {
    const captured = api.getState().confidential.account["nexus"].OAuthCredentials.token;
    return async () => (captured === token ? oldToken : captured);
  });
  try {
    const old = updateToken(h.api, nexus, credentials);
    await vi.waitFor(() => expect(providers).toHaveBeenCalledOnce());
    h.api.store.dispatch(setOAuthCredentials(newToken, "new-refresh", "new-fingerprint"));
    const current = updateToken(
      h.api,
      nexus,
      h.getState().confidential.account["nexus"].OAuthCredentials,
    );
    await vi.waitFor(() => expect(held).toHaveLength(1));
    reply(held[0], 200, oauthUser(99));
    expect(await current).toBe(true);
    const state = h.getState();
    const validation = nexus.getValidationResult();
    expect(validation?.user_id).toBe(99);
    release(token);
    expect(await old).toBe(false);
    expect(h.getState()).toBe(state);
    expect(nexus.getValidationResult()).toBe(validation);
  } finally {
    release(token);
    await f.close();
  }
});

test("a retired native SDK provider cannot overwrite a validated key account", async () => {
  const f = await fixture();
  const { h, nexus, credentials, token } = f;
  let release!: (token: string) => void;
  const oldToken = new Promise<string>((resolve) => {
    release = resolve;
  });
  const providers = vi.spyOn(oauthSession, "tokenProviderFor").mockImplementation((api) => {
    const captured = api.getState().confidential.account["nexus"].OAuthCredentials;
    return async () => (captured === undefined ? undefined : oldToken);
  });
  try {
    const old = updateToken(h.api, nexus, credentials);
    await vi.waitFor(() => expect(providers).toHaveBeenCalledOnce());
    h.api.store.dispatch(clearOAuthCredentials(null));
    h.api.store.dispatch(setUserAPIKey("new-fixture-key"));
    expect(await updateKey(h.api, nexus, "new-fixture-key")).toBe(true);
    const state = h.getState();
    const validation = nexus.getValidationResult();
    expect(validation?.user_id).toBe(99);
    release(token);
    expect(await old).toBe(false);
    expect(h.getState()).toBe(state);
    expect(nexus.getValidationResult()).toBe(validation);
  } finally {
    release(token);
    await f.close();
  }
});
