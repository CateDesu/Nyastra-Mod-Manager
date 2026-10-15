import fs from "fs";
import path from "path";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import type * as ReactReduxTypes from "react-redux";
import { describe, expect, it, vi } from "vitest";

import type { MixpanelEvent } from "@/extensions/analytics/mixpanel/MixpanelEvents";
import type { IToolbarAction } from "@/ui/components/toolbar/ToolbarGroup";

const { actions, emit } = vi.hoisted(() => ({
  actions: { current: [] as IToolbarAction[] },
  emit: vi.fn(),
}));

vi.mock("@/contexts", () => ({ useMainContext: () => ({ api: { events: { emit } } }) }));

vi.mock("react-redux", async () => ({
  ...(await vi.importActual<typeof ReactReduxTypes>("react-redux")),
  useDispatch: () => vi.fn(),
  useSelector: (selector: (state: unknown) => unknown) =>
    selector({ settings: { toolbars: {}, profiles: {} }, persistent: { profiles: {} } }),
}));

vi.mock("../../hooks/useModToolbarActions.hook", () => ({
  useModToolbarActions: () => actions.current,
}));

import { ModsToolbar } from "./ModsToolbar";

const t = ((key: string) => key) as never;

const trackedEvent = (): MixpanelEvent | undefined =>
  emit.mock.calls.find(([name]) => name === "analytics-track-mixpanel-event")?.[1];

describe("ModsToolbar", () => {
  it("reports a click on one of its buttons as use of the mods toolbar", async () => {
    // Unpinned actions report the overflow surface instead.
    actions.current = [{ label: "Deploy Mods", id: "deploy", pinned: true, onClick: vi.fn() }];
    render(<ModsToolbar t={t} />);

    expect(screen.getByTestId("mod-enable-controls")).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Deploy Mods" }));

    expect(trackedEvent()?.eventName).toBe("app_toolbar_action_clicked");
    expect(trackedEvent()?.properties).toEqual({
      action: "deploy",
      surface: "bar",
      toolbar: "mods",
    });
  });
});

// Source inspection checks absence beyond the paths a render test exercises.
describe("the classic toolbar", () => {
  it("has no tracking of its own", () => {
    const iconBar = fs.readFileSync(
      path.resolve(__dirname, "../../../../controls/IconBar.tsx"),
      "utf8",
    );

    expect(iconBar).not.toMatch(/analytics|ToolbarActionClicked|onActionClick/i);
  });
});
