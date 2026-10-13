import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TFunction } from "i18next";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { LoginDialog } from "./LoginDialog";

vi.mock("../../../controls/Icon", () => ({ default: () => <svg /> }));
vi.mock("../../../controls/Modal", async () => {
  const { Modal } = await import("react-bootstrap");
  return {
    default: Object.assign(({ children }: React.PropsWithChildren) => <div>{children}</div>, {
      Body: Modal.Body,
    }),
  };
});
vi.mock("../../../controls/CopyClipboardInput", () => ({
  default: ({ inputValue }: { inputValue: string }) => (
    <input aria-label="API access address" value={inputValue} readOnly />
  ),
}));

describe("registration testing login", () => {
  it("saves a personal key without treating it as an OAuth authorization token", async () => {
    const onSetAPIKey = vi.fn();
    const onReceiveCode = vi.fn();
    const onHide = vi.fn();
    render(
      <LoginDialog
        t={((key: string) => key) as TFunction}
        i18n={undefined}
        tReady
        visible
        onReceiveCode={onReceiveCode}
        onHide={onHide}
        onCancelLogin={vi.fn()}
        userInfo={undefined}
        loginId={undefined}
        loginError={undefined}
        oauthPending={undefined}
        onSetAPIKey={onSetAPIKey}
        onShowLoginError={vi.fn()}
        onResetLoginId={vi.fn()}
        onResetOauthPending={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("API access address")).toHaveValue(
      "https://www.nexusmods.com/users/myaccount?tab=api+access",
    );
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    const key = screen.getByLabelText("Personal API key");
    expect(key).toHaveAttribute("type", "password");
    fireEvent.change(key, { target: { value: "personal-test-key" } });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(onSetAPIKey).toHaveBeenCalledWith("personal-test-key");
    expect(onReceiveCode).not.toHaveBeenCalled();
    expect(onHide).toHaveBeenCalledOnce();
  });
});
