// @vitest-environment jsdom
import * as fs from "fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { installIconSet } from "./Icon";

vi.mock("fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("../util/log", () => ({ log: vi.fn() }));

beforeEach(() => {
  window.__iconSetPromises = new Map();
  document.body.innerHTML = '<div id="icon-sets"></div>';
  vi.clearAllMocks();
});

describe("extension icon sets", () => {
  it("keeps SVG symbols while removing scripts, event handlers and HTML", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(
      Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
        <script>alert(1)</script>
        <symbol id="icon-cat" viewBox="0 0 24 24">
          <path d="M0 0h24v24z" onclick="alert(2)"/>
          <use href="javascript:alert(3)"/>
          <foreignObject><img src="missing" onerror="alert(4)"></foreignObject>
        </symbol>
      </svg>
    `),
    );
    expect(await installIconSet("fixture", "/fixture/icons.svg")).toEqual(new Set(["icon-cat"]));
    const container = document.getElementById("iconset-fixture")!;
    expect(container.querySelector("symbol")?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(container.querySelector("path")?.getAttribute("d")).toBe("M0 0h24v24z");
    expect(
      container.querySelector("script, foreignObject, img, [onload], [onclick], [onerror]"),
    ).toBeNull();
    expect(container.innerHTML).not.toContain("javascript:");
  });

  it("shares one sanitized icon set between concurrent requests", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('<svg><symbol id="icon-cat"/></svg>'));
    const first = installIconSet("fixture", "/fixture/icons.svg");
    expect(installIconSet("fixture", "/fixture/icons.svg")).toBe(first);
    await first;
    expect(fs.readFile).toHaveBeenCalledOnce();
    expect(document.querySelectorAll("#iconset-fixture")).toHaveLength(1);
  });
});
