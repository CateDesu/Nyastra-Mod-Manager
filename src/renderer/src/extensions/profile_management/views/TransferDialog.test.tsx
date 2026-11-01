import { act, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { Provider } from "react-redux";
import { expect, it, vi } from "vitest";

import { makeApiHarness, makeMod, makeProfile } from "../../../test-utils/builders";
import { setCreateTransfer } from "../actions/transferSetup";
import { profilesReducer } from "../reducers/profiles";
import transferSetupReducer from "../reducers/transferSetup";
import TransferDialog from "./TransferDialog";

vi.mock("../../../controls/Icon", () => ({ default: () => null }));

it.each([true, false])(
  "transfers enabled flags only when the option is selected as %s",
  async (transferEnabled) => {
    const h = makeApiHarness(
      {
        profiles: {
          source: makeProfile({
            id: "source",
            gameId: "game",
            modState: {
              a: { enabled: true, enabledTime: 1 },
              b: { enabled: false, enabledTime: 2 },
            },
          }),
          target: makeProfile({
            id: "target",
            gameId: "game",
            modState: {
              a: { enabled: false, enabledTime: 3 },
              b: { enabled: true, enabledTime: 4 },
            },
          }),
        },
        mods: { game: { a: makeMod({ id: "a" }), b: makeMod({ id: "b" }) } },
      },
      [
        { path: ["persistent", "profiles"], reducer: profilesReducer },
        { path: ["session", "profileTransfer"], reducer: transferSetupReducer },
      ],
    );
    render(
      <Provider store={h.api.store}>
        <TransferDialog />
      </Provider>,
    );
    act(() => {
      h.api.store.dispatch(setCreateTransfer("game", "source", "target"));
    });
    const checkbox = await screen.findByRole("checkbox");
    if (!transferEnabled) fireEvent.click(checkbox);
    expect(checkbox).toHaveProperty("checked", transferEnabled);
    fireEvent.click(screen.getAllByRole("button").at(-1));
    const modState = h.getState().persistent.profiles.target.modState;
    expect([modState.a.enabled, modState.b.enabled]).toEqual(
      transferEnabled ? [true, false] : [false, true],
    );
    expect(h.getState().session).toMatchObject({ profileTransfer: { dialog: undefined } });
  },
);
