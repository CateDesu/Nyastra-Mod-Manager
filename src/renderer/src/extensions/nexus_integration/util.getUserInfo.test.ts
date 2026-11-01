import { describe, expect, vi } from "vitest";

import { makeApiUserInfo } from "@/test-utils/builders";
import { test } from "@/test-utils/harnessTest";

import { setUserInfo } from "./actions/persistent";
import { userInfo } from "./selectors";
import { getUserInfo } from "./util";

const keyUserInfo = {
  key: "personal-test-key",
  user_id: 7,
  name: "Astra",
  email: "fixture@example.invalid",
  profile_url: "https://example.invalid/avatar.png",
  is_premium: true,
  is_supporter: false,
};

const makeNexus = () => ({
  validateKey: vi.fn().mockResolvedValue(keyUserInfo),
  getUserInfo: vi.fn().mockResolvedValue(makeApiUserInfo()),
});

describe("account refresh authentication", () => {
  test("refreshes a personal key account through key validation", async ({ makeApi }) => {
    const harness = makeApi();
    harness.setState((state) => {
      state.confidential.account = { nexus: { APIKey: "personal-test-key" } };
    });
    const nexus = makeNexus();

    expect(await getUserInfo(harness.api, nexus as never)).toBe("updated");

    expect(nexus.validateKey).toHaveBeenCalledExactlyOnceWith("personal-test-key");
    expect(nexus.getUserInfo).not.toHaveBeenCalled();
    expect(userInfo(harness.getState())).toEqual({
      userId: 7,
      name: "Astra",
      email: "fixture@example.invalid",
      profileUrl: "https://example.invalid/avatar.png",
      isPremium: true,
      isSupporter: false,
      isLifetime: false,
    });
  });

  test("keeps OAuth refresh when OAuth credentials are present", async ({ makeApi }) => {
    const harness = makeApi();
    harness.setState((state) => {
      state.confidential.account = {
        nexus: { ...state.confidential.account?.["nexus"], APIKey: "old-test-key" },
      };
    });
    const nexus = makeNexus();

    expect(await getUserInfo(harness.api, nexus as never)).toBe("updated");

    expect(nexus.getUserInfo).toHaveBeenCalledOnce();
    expect(nexus.validateKey).not.toHaveBeenCalled();
  });

  test.for([
    { statusCode: 503, outcome: "failed" },
    { statusCode: 429, outcome: "rate-limited" },
  ])(
    "preserves the account after a $statusCode response",
    async ({ statusCode, outcome }, { makeApi }) => {
      const harness = makeApi();
      harness.setState((state) => {
        state.confidential.account = { nexus: { APIKey: "personal-test-key" } };
      });
      const previous = userInfo(harness.getState());
      const nexus = makeNexus();
      nexus.validateKey.mockRejectedValue(
        Object.assign(new Error("Request failed"), { statusCode }),
      );

      expect(await getUserInfo(harness.api, nexus as never)).toBe(outcome);

      expect(userInfo(harness.getState())).toEqual(previous);
      expect(nexus.getUserInfo).not.toHaveBeenCalled();
    },
  );

  test.for([undefined, "replacement-test-key"])(
    "ignores a key response after the key changes to %s",
    async (nextKey, { makeApi }) => {
      const harness = makeApi();
      harness.setState((state) => {
        state.confidential.account = { nexus: { APIKey: "personal-test-key" } };
      });
      const nexus = makeNexus();

      const pending = getUserInfo(harness.api, nexus as never);
      harness.setState((state) => {
        state.confidential.account = { nexus: { APIKey: nextKey } };
      });
      harness.api.store.dispatch(setUserInfo(undefined));

      expect(await pending).toBe("failed");
      expect(userInfo(harness.getState())).toBeUndefined();
    },
  );
});
