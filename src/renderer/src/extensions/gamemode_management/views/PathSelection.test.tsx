import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import { setGameSearchPaths } from "../../../actions";
import { makeApiHarness } from "../../../test-utils/builders";
import { settingsReducer } from "../reducers/settings/settings";

vi.mock("react-i18next", () => ({
  withTranslation: () => (Component: React.ComponentType<Record<string, unknown>>) =>
    function Translated(props: Record<string, unknown>) {
      return <Component {...props} t={(key: string) => key} />;
    },
}));
vi.mock("../../../controls/Modal", () => {
  const Container = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  const Modal = ({ children, show }: React.PropsWithChildren<{ show: boolean }>) =>
    show ? <div role="dialog">{children}</div> : null;
  return {
    default: Object.assign(Modal, {
      Header: Container,
      Body: Container,
      Footer: Container,
      Title: Container,
    }),
  };
});
vi.mock("../../../controls/Icon", () => ({ default: () => null }));
vi.mock("../../../controls/TooltipControls", () => ({
  IconButton: ({ id, onClick }: { id?: string; onClick: React.MouseEventHandler }) => (
    <button data-testid={id} onClick={onClick} />
  ),
}));

import PathSelection from "./PathSelection";

function fixture(paths: string[] = [], visible = true) {
  const harness = makeApiHarness({}, [
    { path: ["settings", "gameMode"], reducer: settingsReducer },
  ]);
  harness.api.store.dispatch(setGameSearchPaths(paths));
  const properties = {
    onHide: vi.fn(),
    onScan: vi.fn(),
    onSelectPath: vi.fn(async (_basePath: string) => "/fixture/Chosen"),
  };
  const content = (visible: boolean) => (
    <Provider store={harness.api.store}>
      <PathSelection {...properties} visible={visible} />
    </Provider>
  );
  const view = render(content(visible));
  return { harness, ...properties, show: (visible: boolean) => view.rerender(content(visible)) };
}

describe("game scan paths", () => {
  it("uses drive paths populated after the hidden dialog mounted", () => {
    const f = fixture([], false);
    act(() => f.harness.api.store.dispatch(setGameSearchPaths(["/fixture/Games"])));
    f.show(true);

    expect(screen.getByRole("textbox")).toHaveValue("/fixture/Games");
  });

  it("passes edited paths to scanning and the real settings reducer", async () => {
    const f = fixture(["/fixture/Games"]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/fixture/Edited" } });

    await userEvent.click(screen.getByTestId("game-search-scan"));

    expect(f.onScan).toHaveBeenCalledExactlyOnceWith(["/fixture/Edited"]);
    expect(f.harness.api.getState().settings.gameMode.searchPaths).toEqual(["/fixture/Edited"]);
    expect(f.onHide).toHaveBeenCalledOnce();
  });

  it("reloads saved paths when reopening after canceling local edits", async () => {
    const f = fixture(["/fixture/Saved"]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/fixture/Unsaved" } });
    await userEvent.click(screen.getByTestId("game-search-cancel"));
    f.show(false);
    f.show(true);

    expect(screen.getByRole("textbox")).toHaveValue("/fixture/Saved");
    expect(f.harness.api.getState().settings.gameMode.searchPaths).toEqual(["/fixture/Saved"]);
    expect(f.onScan).not.toHaveBeenCalled();
    expect(f.onHide).toHaveBeenCalledOnce();
  });

  it("opens the current edited path in the directory picker", async () => {
    const f = fixture(["/fixture/Initial"]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/fixture/Current" } });

    await userEvent.click(screen.getByTestId("change-tool-path"));

    expect(f.onSelectPath).toHaveBeenCalledExactlyOnceWith("/fixture/Current");
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("/fixture/Chosen"));
  });
});
