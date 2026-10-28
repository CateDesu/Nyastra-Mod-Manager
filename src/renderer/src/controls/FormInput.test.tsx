import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import FilterBox from "../extensions/file_based_loadorder/views/FilterBox";
import FormInput from "./FormInput";

vi.mock("./Icon", () => ({ default: () => <span aria-hidden="true" /> }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("clears the load order filter and commits only the empty filter", async () => {
  const setFilter = vi.fn();
  render(<FilterBox currentFilterValue="active filter" setFilter={setFilter} />);
  const input = screen.getByRole("searchbox");
  fireEvent.change(input, { target: { value: "pending filter" } });
  expect(setFilter).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button"));
  expect(input).toHaveValue("");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(setFilter).toHaveBeenCalledTimes(1);
  expect(setFilter).toHaveBeenCalledWith("");
});

it.each([
  { value: "", clearable: true },
  { value: "value", clearable: false },
])("omits the clear control for $value with clearable=$clearable", (props) => {
  render(<FormInput {...props} onChange={vi.fn()} />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
