import { render } from "@testing-library/react";
import React from "react";
import { describe, it, expect } from "vitest";

import { NexusBadge } from "./NexusBadge";

const getBadge = () => document.querySelector("svg");

describe("NexusBadge", () => {
  it("keeps the decorative mark hidden from assistive tech", () => {
    render(<NexusBadge />);

    expect(getBadge()).toHaveAttribute("aria-hidden", "true");
    expect(getBadge()).toHaveAttribute("role", "presentation");
  });

  it("is 16px by default, and merges a custom className", () => {
    render(<NexusBadge className="size-8" />);

    expect(getBadge()).toHaveClass("size-4", "shrink-0", "size-8");
  });
});
