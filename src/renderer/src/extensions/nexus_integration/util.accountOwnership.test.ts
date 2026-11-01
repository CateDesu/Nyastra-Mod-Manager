import type Nexus from "@nexusmods/nexus-api";
import { NexusError } from "@nexusmods/nexus-api";
import { describe, expect, test, vi } from "vitest";

import { makeApiHarness, makeApiUserInfo, makeUserInfo } from "../../test-utils/builders";
import { ProcessCanceled } from "../../util/CustomErrors";
import { clearOAuthCredentials, setOAuthCredentials, setUserAPIKey } from "./actions/account";
import { setUserInfo } from "./actions/persistent";
import { userInfo } from "./selectors";
import { getUserInfo, updateKey, updateToken } from "./util";
import * as oauthSession from "./util/oauthSession";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(key = false) {
  const h = makeApiHarness();
  h.setState((state) => {
    state.confidential.account = { nexus: key ? { APIKey: "A" } : {} };
  });
  if (!key) h.api.store.dispatch(setOAuthCredentials("token-A", "refresh-A", "fingerprint-A"));
  const pending: ReturnType<typeof deferred<ReturnType<typeof makeApiUserInfo>>>[] = [];
  const read = vi.fn(() => {
    const p = deferred<ReturnType<typeof makeApiUserInfo>>();
    pending.push(p);
    return p.promise;
  });
  const nexus = {
    getUserInfo: read,
    validateKey: read,
    setTokenProvider: vi.fn().mockResolvedValue(undefined),
  } as unknown as Nexus;
  const didLogin = vi.fn();
  h.api.events.on("did-login", didLogin);
  return { h, nexus, read, pending, didLogin };
}

const failures = [
  ["server error", () => new NexusError("unavailable", 503, "http://127.0.0.1", "unavailable")],
  ["rate limit", () => Object.assign(new Error("limited"), { statusCode: 429 })],
  ["cancellation", () => new ProcessCanceled("cancelled")],
] as const;

function transition(h: ReturnType<typeof makeApiHarness>, name: string) {
  if (name === "logout") {
    h.api.store.dispatch(clearOAuthCredentials(null));
    h.api.store.dispatch(setUserAPIKey(undefined));
  }
  if (name === "OAuth replacement")
    h.api.store.dispatch(setOAuthCredentials("token-B", "refresh-B", "fingerprint-B"));
  if (name === "OAuth reuse") {
    const old = h.getState().confidential.account["nexus"].OAuthCredentials;
    h.api.store.dispatch(clearOAuthCredentials(null));
    h.api.store.dispatch(setOAuthCredentials(old.token, old.refreshToken, old.fingerprint));
  }
  if (name === "key replacement" || name === "key reuse") {
    h.api.store.dispatch(clearOAuthCredentials(null));
    h.api.store.dispatch(setUserAPIKey("B"));
    if (name === "key reuse") h.api.store.dispatch(setUserAPIKey("A"));
  }
  h.api.store.dispatch(setUserInfo(name === "logout" ? undefined : makeUserInfo({ userId: 99 })));
}

describe("account read ownership", () => {
  for (const entry of ["membership", "login"] as const) {
    for (const outcome of ["success", ...failures.map(([name]) => name)]) {
      test.each(["logout", "OAuth replacement", "OAuth reuse", "key replacement"])(
        `${entry} ignores ${outcome} after %s`,
        async (name) => {
          const { h, nexus, pending, didLogin } = setup();
          const credentials = h.getState().confidential.account["nexus"].OAuthCredentials;
          const operation =
            entry === "membership"
              ? getUserInfo(h.api, nexus)
              : updateToken(h.api, nexus, credentials);
          await vi.waitFor(() => expect(pending).toHaveLength(1));
          transition(h, name);
          const state = h.getState();
          if (outcome === "success") pending[0].resolve(makeApiUserInfo());
          else pending[0].reject(failures.find(([label]) => label === outcome)![1]());
          expect(await operation).toBe(entry === "membership" ? "failed" : false);
          expect(h.getState()).toBe(state);
          expect(h.notifications).toEqual([]);
          expect(h.errorNotifications).toEqual([]);
          expect(didLogin).not.toHaveBeenCalled();
        },
      );
    }
  }

  test("key A to B to A cannot revive membership work", async () => {
    const { h, nexus, pending } = setup(true);
    const read = getUserInfo(h.api, nexus);
    transition(h, "key reuse");
    const state = h.getState();
    pending[0].resolve(makeApiUserInfo());
    expect(await read).toBe("failed");
    expect(h.getState()).toBe(state);
  });

  test("the latest membership read owns success and failure effects", async () => {
    const { h, nexus, pending } = setup();
    const old = getUserInfo(h.api, nexus);
    const current = getUserInfo(h.api, nexus);
    pending[1].resolve({ ...makeApiUserInfo(), sub: "99" });
    expect(await current).toBe("updated");
    const state = h.getState();
    pending[0].reject(new Error("old failure"));
    expect(await old).toBe("failed");
    expect(h.getState()).toBe(state);
  });

  test("membership reads do not invalidate pending key validation or its SDK guard", async () => {
    const { h, nexus, pending } = setup(true);
    const key = deferred<Awaited<ReturnType<Nexus["setKey"]>>>();
    const setKey = vi.fn((_key: string, _owns?: () => boolean) => key.promise);
    Object.assign(nexus, { setKey });
    const validation = updateKey(h.api, nexus, "A");
    const membership = getUserInfo(h.api, nexus);
    expect(setKey.mock.calls[0][1]!()).toBe(true);
    key.resolve({
      key: "A",
      user_id: 99,
      name: "Key",
      email: "fixture@example.invalid",
      profile_url: "",
      is_premium: false,
      is_supporter: false,
    });
    expect(await validation).toBe(true);
    expect(setKey.mock.calls[0][1]!()).toBe(true);
    const state = h.getState();
    pending[0].resolve(makeApiUserInfo());
    expect(await membership).toBe("failed");
    expect(h.getState()).toBe(state);
    expect(userInfo(h.getState())?.userId).toBe(99);
  });

  test("starting login validation retires an older membership read", async () => {
    const { h, nexus, pending } = setup();
    const old = getUserInfo(h.api, nexus);
    const current = updateToken(
      h.api,
      nexus,
      h.getState().confidential.account["nexus"].OAuthCredentials,
    );
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1].resolve({ ...makeApiUserInfo(), sub: "99" });
    expect(await current).toBe(true);
    pending[0].resolve(makeApiUserInfo());
    expect(await old).toBe("failed");
    expect(userInfo(h.getState())?.userId).toBe(99);
  });

  test("does not start a stale login or mutate its SDK provider", async () => {
    const { h, nexus, read } = setup();
    const old = h.getState().confidential.account["nexus"].OAuthCredentials;
    transition(h, "OAuth replacement");
    expect(await updateToken(h.api, nexus, old)).toBe(false);
    expect(nexus.setTokenProvider).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  test("checks ownership again after priming the token provider", async () => {
    const { h, nexus, read } = setup();
    const provider = deferred<void>();
    vi.mocked(nexus.setTokenProvider).mockReturnValue(provider.promise as never);
    const operation = updateToken(
      h.api,
      nexus,
      h.getState().confidential.account["nexus"].OAuthCredentials,
    );
    transition(h, "logout");
    provider.resolve();
    expect(await operation).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  test("a refusal notification cannot clear a replacement account", async () => {
    const { h, nexus, pending, didLogin } = setup();
    vi.spyOn(h.api, "showErrorNotification").mockImplementation(() =>
      transition(h, "OAuth replacement"),
    );
    const operation = updateToken(
      h.api,
      nexus,
      h.getState().confidential.account["nexus"].OAuthCredentials,
    );
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].reject(new NexusError("refused", 403, "http://127.0.0.1", "refused"));
    expect(await operation).toBe(false);
    expect(h.getState().confidential.account["nexus"].OAuthCredentials.token).toBe("token-B");
    expect(userInfo(h.getState())?.userId).toBe(99);
    expect(didLogin).not.toHaveBeenCalled();
  });

  test("each store owns its own membership reads", async () => {
    const a = setup();
    const b = setup();
    const first = getUserInfo(a.h.api, a.nexus);
    const second = getUserInfo(b.h.api, b.nexus);
    a.pending[0].resolve(makeApiUserInfo());
    b.pending[0].resolve(makeApiUserInfo());
    expect(await first).toBe("updated");
    expect(await second).toBe("updated");
  });
});

test("keeps a legitimate token rotation owned through login validation", async () => {
  const { h, nexus, pending } = setup();
  const provider = vi
    .spyOn(oauthSession, "tokenProviderFor")
    .mockImplementation((api) => async () => {
      api.store.dispatch(setOAuthCredentials("token-B", "refresh-B", "fingerprint-B"));
      return "token-B";
    });
  vi.mocked(nexus.setTokenProvider).mockImplementation(async (getToken) => {
    expect(await getToken()).toBe("token-B");
    return undefined;
  });
  try {
    const operation = updateToken(
      h.api,
      nexus,
      h.getState().confidential.account["nexus"].OAuthCredentials,
    );
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].resolve(makeApiUserInfo());
    expect(await operation).toBe(true);
    expect(h.getState().confidential.account["nexus"].OAuthCredentials.token).toBe("token-B");
    expect(userInfo(h.getState())?.userId).toBe(7);
  } finally {
    provider.mockRestore();
  }
});

test("retired token refresh code cannot dispatch into a reused session", async () => {
  const { h, nexus } = setup();
  const gate = deferred<void>();
  const provider = vi
    .spyOn(oauthSession, "tokenProviderFor")
    .mockImplementation((api) => async () => {
      await gate.promise;
      api.store.dispatch(setOAuthCredentials("retired", "retired", "retired"));
      return "retired";
    });
  vi.mocked(nexus.setTokenProvider).mockImplementation(async (getToken) => {
    await getToken();
    return undefined;
  });
  try {
    const operation = updateToken(
      h.api,
      nexus,
      h.getState().confidential.account["nexus"].OAuthCredentials,
    );
    await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce());
    transition(h, "OAuth reuse");
    const state = h.getState();
    gate.resolve();
    expect(await operation).toBe(false);
    expect(h.getState()).toBe(state);
  } finally {
    gate.resolve();
    provider.mockRestore();
  }
});
