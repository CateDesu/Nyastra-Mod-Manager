import type Nexus from "@nexusmods/nexus-api";
import { NexusError, TimeoutError, type IValidateKeyResponse } from "@nexusmods/nexus-api";
import { describe, expect, test, vi } from "vitest";

import { makeApiHarness, makeUserInfo } from "../../test-utils/builders";
import { ProcessCanceled } from "../../util/CustomErrors";
import { RateLimitExceeded } from "../../util/github";
import { clearOAuthCredentials, setOAuthCredentials, setUserAPIKey } from "./actions/account";
import { setUserInfo } from "./actions/persistent";
import { userInfo } from "./selectors";
import { updateKey } from "./util";

function deferred() {
  let resolve!: (value: IValidateKeyResponse) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<IValidateKeyResponse>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const response = (id: number): IValidateKeyResponse => ({
  key: "fixture",
  user_id: id,
  name: `Account ${id}`,
  email: "fixture@example.invalid",
  profile_url: "",
  is_premium: true,
  is_supporter: false,
});

const failures = [
  ["timeout", () => new TimeoutError("fixture timeout")],
  ["401", () => new NexusError("refused", 401, "http://127.0.0.1", "unauthorized")],
  ["503", () => new NexusError("unavailable", 503, "http://127.0.0.1", "unavailable")],
  ["cancel", () => new ProcessCanceled("fixture cancellation")],
  ["generic", () => new Error("fixture failure")],
  [
    "socket timeout",
    () => Object.assign(new Error("fixture failure"), { code: "ESOCKETTIMEDOUT" }),
  ],
] as const;

function setup() {
  const h = makeApiHarness();
  h.setState((state) => {
    state.confidential.account = { nexus: { APIKey: "A" } };
  });
  const pending: ReturnType<typeof deferred>[] = [];
  const setKey = vi.fn(() => {
    const operation = deferred();
    pending.push(operation);
    return operation.promise;
  });
  const nexus = { setKey } as unknown as Nexus;
  const didLogin = vi.fn();
  h.api.events.on("did-login", didLogin);
  const errors = vi.spyOn(h.api, "showErrorNotification");
  return { h, nexus, pending, setKey, didLogin, errors };
}

describe("API key validation ownership", () => {
  test.each(failures)(
    "ignores an old %s after the replacement succeeds",
    async (_label, failure) => {
      const { h, nexus, pending, didLogin, errors } = setup();
      const old = updateKey(h.api, nexus, "A");
      h.api.store.dispatch(setUserAPIKey("B"));
      const current = updateKey(h.api, nexus, "B");
      pending[1].resolve(response(99));
      expect(await current).toBe(true);
      const state = h.getState();
      pending[0].reject(failure());
      expect(await old).toBe(false);
      expect(h.getState()).toBe(state);
      expect(userInfo(h.getState())?.userId).toBe(99);
      expect(h.notifications).toEqual([]);
      expect(errors).not.toHaveBeenCalled();
      expect(didLogin.mock.calls).toEqual([[null]]);
    },
  );

  test.each(failures)(
    "keeps current %s reporting and permits its retry",
    async (label, failure) => {
      const { h, nexus, pending, setKey, didLogin, errors } = setup();
      const current = updateKey(h.api, nexus, "A");
      const error = failure();
      pending[0].reject(error);
      expect(await current).toBe(false);
      expect(userInfo(h.getState())).toBeUndefined();
      expect(didLogin.mock.calls).toEqual([[error]]);
      const generic = label === "generic" || label === "socket timeout";
      expect(h.notifications).toHaveLength(generic ? 0 : 1);
      expect(errors).toHaveBeenCalledTimes(generic ? 1 : 0);
      const action = generic
        ? errors.mock.calls[0][2]!.actions![0].action
        : h.notifications[0].actions![0].action;
      const dismiss = vi.fn();
      action(dismiss);
      expect(dismiss).toHaveBeenCalledOnce();
      expect(setKey).toHaveBeenCalledTimes(2);
      pending[1].resolve(response(7));
      await vi.waitFor(() => expect(userInfo(h.getState())?.userId).toBe(7));
    },
  );

  test("does not publish an old success over a later key", async () => {
    const { h, nexus, pending, didLogin } = setup();
    const old = updateKey(h.api, nexus, "A");
    h.api.store.dispatch(setUserAPIKey("B"));
    const current = updateKey(h.api, nexus, "B");
    pending[1].resolve(response(99));
    expect(await current).toBe(true);
    const state = h.getState();
    pending[0].resolve(response(7));
    expect(await old).toBe(false);
    expect(h.getState()).toBe(state);
    expect(didLogin.mock.calls).toEqual([[null]]);
  });

  test.each(["success", "failure"])(
    "does not revive an old %s after A to B to A without another validation",
    async (outcome) => {
      const { h, nexus, pending, didLogin } = setup();
      const old = updateKey(h.api, nexus, "A");
      h.api.store.dispatch(setUserAPIKey("B"));
      h.api.store.dispatch(setUserAPIKey("A"));
      const state = h.getState();
      if (outcome === "success") pending[0].resolve(response(7));
      else pending[0].reject(new TimeoutError("obsolete"));
      expect(await old).toBe(false);
      expect(h.getState()).toBe(state);
      expect(h.notifications).toEqual([]);
      expect(didLogin).not.toHaveBeenCalled();
    },
  );

  test("makes the latest operation own repeated validation of the same key", async () => {
    const { h, nexus, pending, didLogin } = setup();
    const old = updateKey(h.api, nexus, "A");
    const latest = updateKey(h.api, nexus, "A");
    pending[1].resolve(response(99));
    expect(await latest).toBe(true);
    pending[0].resolve(response(7));
    expect(await old).toBe(false);
    expect(userInfo(h.getState())?.userId).toBe(99);
    expect(didLogin.mock.calls).toEqual([[null]]);
  });

  test.each(["logout", "OAuth", "OAuth removed", "OAuth replaced"])(
    "rejects completion after %s",
    async (transition) => {
      const { h, nexus, pending, didLogin } = setup();
      const old = updateKey(h.api, nexus, "A");
      if (transition === "logout") h.api.store.dispatch(setUserAPIKey(undefined));
      else h.api.store.dispatch(setOAuthCredentials("fixture-token", "fixture-refresh", "fixture"));
      if (transition === "OAuth removed") h.api.store.dispatch(clearOAuthCredentials(null));
      if (transition === "OAuth replaced")
        h.api.store.dispatch(setOAuthCredentials("new-token", "new-refresh", "new-fixture"));
      h.api.store.dispatch(setUserInfo(makeUserInfo({ userId: 99 })));
      const state = h.getState();
      pending[0].resolve(response(7));
      expect(await old).toBe(false);
      expect(h.getState()).toBe(state);
      expect(didLogin).not.toHaveBeenCalled();
    },
  );

  test.each(failures)(
    "an old %s retry never mutates the SDK after account replacement or reuse",
    async (label, failure) => {
      const { h, nexus, pending, setKey, errors, didLogin } = setup();
      const old = updateKey(h.api, nexus, "A");
      pending[0].reject(failure());
      await old;
      const generic = label === "generic" || label === "socket timeout";
      const action = generic
        ? errors.mock.calls[0][2]!.actions![0].action
        : h.notifications[0].actions![0].action;
      h.api.store.dispatch(setUserAPIKey("B"));
      h.api.store.dispatch(setUserAPIKey("A"));
      const state = h.getState();
      const dismiss = vi.fn();
      action(dismiss);
      expect(setKey).toHaveBeenCalledOnce();
      expect(dismiss).not.toHaveBeenCalled();
      expect(h.getState()).toBe(state);
      expect(didLogin).toHaveBeenCalledOnce();
    },
  );

  test.each(["different key", "OAuth", "logout"])(
    "refuses an obsolete start for %s before setKey",
    async (transition) => {
      const { h, nexus, setKey } = setup();
      if (transition === "different key") h.api.store.dispatch(setUserAPIKey("B"));
      if (transition === "logout") h.api.store.dispatch(setUserAPIKey(undefined));
      if (transition === "OAuth")
        h.api.store.dispatch(setOAuthCredentials("fixture", "fixture", "fixture"));
      expect(await updateKey(h.api, nexus, "A")).toBe(false);
      expect(setKey).not.toHaveBeenCalled();
    },
  );

  test.each([false, true])(
    "preserves the current GitHub quota exception with obsolete=%s",
    async (obsolete) => {
      const { h, nexus, pending, didLogin } = setup();
      const operation = updateKey(h.api, nexus, "A");
      if (obsolete) h.api.store.dispatch(setUserAPIKey("B"));
      const state = h.getState();
      pending[0].reject(new RateLimitExceeded());
      expect(await operation).toBe(!obsolete);
      expect(h.getState()).toBe(state);
      expect(didLogin).not.toHaveBeenCalled();
      expect(h.notifications).toEqual([]);
    },
  );

  test("rechecks ownership between dispatch and completion event", async () => {
    const { h, nexus, pending, didLogin } = setup();
    h.api.onStateChange(["persistent", "nexus", "userInfo"], () => {
      h.api.store.dispatch(setUserAPIKey("B"));
    });
    const operation = updateKey(h.api, nexus, "A");
    pending[0].resolve(response(7));
    expect(await operation).toBe(false);
    expect(didLogin).not.toHaveBeenCalled();
  });
});
