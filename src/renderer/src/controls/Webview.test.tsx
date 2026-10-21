import { EventEmitter } from "node:events";

import { act, fireEvent, render, waitFor } from "@testing-library/react";
import * as React from "react";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcRenderer: new EventEmitter() }));
vi.mock("../webview", () => ({
  makeBrowserView: vi.fn(),
  closeBrowserView: vi.fn(async () => undefined),
  positionBrowserView: vi.fn(async () => undefined),
  updateViewURL: vi.fn(async () => undefined),
}));

import { ipcRenderer } from "electron";

import { closeBrowserView, makeBrowserView, updateViewURL } from "../webview";
import { WebviewEmbed, WebviewOverlay } from "./Webview";

beforeEach(() => {
  vi.clearAllMocks();
  ipcRenderer.removeAllListeners();
});

it("closes a view that finishes creation after its component unmounts", async () => {
  let finish!: (id: string) => void;
  vi.mocked(makeBrowserView).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const component = render(<WebviewOverlay src="https://example.com" />);
  component.unmount();
  await act(async () => finish("late-view"));
  expect(closeBrowserView).toHaveBeenCalledWith("late-view");
  expect(ipcRenderer.listenerCount("view-late-view-did-start-loading")).toBe(0);
});

it("uses the latest URL when props change during creation", async () => {
  let finish!: (id: string) => void;
  vi.mocked(makeBrowserView).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const component = render(<WebviewOverlay src="https://example.com/first" />);
  component.rerender(<WebviewOverlay src="https://example.com/next" />);
  await act(async () => finish("ready-view"));
  expect(updateViewURL).toHaveBeenCalledWith("ready-view", "https://example.com/next");
});

it("registers one popup listener across navigations and removes it on unmount", async () => {
  const component = render(<WebviewEmbed src="https://example.com" />);
  const node = component.container.querySelector("webview")!;
  Object.assign(node, { getWebContentsId: () => 12 });
  Object.assign(ipcRenderer, { send: vi.fn() });
  fireEvent(node, new Event("dom-ready"));
  fireEvent(node, new Event("dom-ready"));
  expect(ipcRenderer.listenerCount("webview-open-url")).toBe(1);
  component.unmount();
  await waitFor(() => expect(ipcRenderer.listenerCount("webview-open-url")).toBe(0));
});
