import { NexusError } from "@nexusmods/nexus-api";
import { describe, expect, vi } from "vitest";

import { test } from "@/test-utils/harnessTest";
import { UserCanceled } from "@/util/CustomErrors";

import { setUserAPIKey } from "./actions/account";
import { userInfo } from "./selectors";
import { onCancelLoginImpl, requestLogin, updateKey } from "./util";

describe("personal key registration testing", () => {
  test("waits for validation and fills the account before completing login", async ({
    makeApi,
  }) => {
    const { api, getState } = makeApi();
    const callback = vi.fn();
    const nexus = {
      setKey: vi.fn().mockResolvedValue({
        user_id: 7,
        name: "Astra",
        email: "fixture@example.invalid",
        profile_url: "",
        is_premium: true,
        is_supporter: false,
      }),
    };
    await requestLogin(nexus as never, api, callback);
    expect(callback).not.toHaveBeenCalled();
    api.store.dispatch(setUserAPIKey("personal-test-key"));
    expect(await updateKey(api, nexus as never, "personal-test-key")).toBe(true);
    expect(userInfo(getState())).toMatchObject({
      userId: 7,
      name: "Astra",
      isPremium: true,
    });
    expect(callback).toHaveBeenCalledExactlyOnceWith(null);
  });

  test("cancels once without leaving a callback for the next login", async ({ makeApi }) => {
    const { api } = makeApi();
    const callback = vi.fn();
    await requestLogin({} as never, api, callback);
    onCancelLoginImpl(api);
    expect(callback).toHaveBeenCalledExactlyOnceWith(expect.any(UserCanceled));
    api.events.emit("did-login", null);
    expect(callback).toHaveBeenCalledOnce();
  });

  test("reports a refused key instead of completing login", async ({ makeApi }) => {
    const { api, getState } = makeApi();
    const error = new NexusError("Unauthorized", 401, "https://api.nexusmods.com", "unauthorized");
    const nexus = { setKey: vi.fn().mockRejectedValue(error) };
    const callback = vi.fn();
    await requestLogin(nexus as never, api, callback);
    api.store.dispatch(setUserAPIKey("refused-test-key"));
    expect(await updateKey(api, nexus as never, "refused-test-key")).toBe(false);
    expect(userInfo(getState())).toBeUndefined();
    expect(callback).toHaveBeenCalledExactlyOnceWith(error);
  });

  test("does not restore an account after logout during validation", async ({ makeApi }) => {
    const { api, getState } = makeApi();
    const nexus = { setKey: vi.fn().mockResolvedValue({ user_id: 7, name: "Astra" }) };
    api.store.dispatch(setUserAPIKey("previous-test-key"));
    const pending = updateKey(api, nexus as never, "previous-test-key");
    api.store.dispatch(setUserAPIKey(undefined));
    expect(await pending).toBe(false);
    expect(userInfo(getState())).toBeUndefined();
  });
});
