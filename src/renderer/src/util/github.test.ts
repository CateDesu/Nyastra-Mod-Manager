import { EventEmitter } from "node:events";

import { PROGRAM_NAME } from "@vortex/shared";
import { describe, expect, it, vi } from "vitest";

import github from "./github";

const http = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("https", () => ({ get: http.get }));

describe("program releases", () => {
  it("uses the own repository and release tags while retaining the full Linux version", async () => {
    const response = Object.assign(new EventEmitter(), {
      headers: {},
      statusCode: 200,
      setEncoding: vi.fn(),
    });
    http.get.mockImplementation((_options, receive) => {
      receive(response);
      const request = {
        on: () => request,
        end: () => {
          response.emit(
            "data",
            JSON.stringify([
              { tag_name: "v2.9.0-beta.2+linux.2", name: "Linux testing preview" },
              { tag_name: "not-a-version", name: "2.9.0" },
            ]),
          );
          response.emit("end");
        },
      };
      return request;
    });
    expect(await github.releases()).toMatchObject([{ name: "2.9.0-beta.2+linux.2" }]);
    expect(http.get).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "api.github.com",
        path: "/repos/CateDesu/Nyastra-Mod-Manager/releases",
        headers: { "User-Agent": PROGRAM_NAME },
      }),
      expect.any(Function),
    );
  });
});
