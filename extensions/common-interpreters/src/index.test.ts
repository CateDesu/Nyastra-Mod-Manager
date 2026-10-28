import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { types } from "@nexusmods/vortex-api";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@nexusmods/vortex-api", () => ({ log: vi.fn(), util: { MissingInterpreter: Error } }));
afterEach(() => vi.unstubAllEnvs());

it.each([{ names: ["python3"] }, { names: ["python"] }, { names: ["python3", "python"] }])(
  "discovers native Python from PATH: $names",
  async ({ names }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "nyastra-interpreters-"));
    try {
      for (const name of names)
        await writeFile(path.join(directory, name), "#!/bin/sh\n", { mode: 0o700 });
      vi.stubEnv("PATH", directory);
      vi.resetModules();
      const { default: init } = await import("./index");
      const registerInterpreter = vi.fn<types.IExtensionContext["registerInterpreter"]>();
      init({ registerInterpreter } as unknown as types.IExtensionContext);
      const python = registerInterpreter.mock.calls.find(([extension]) => extension === ".py")![1];
      const result = python({ executable: "script.py", args: ["--option"], options: {} });
      expect(result.executable).toBe(
        path.join(directory, names.includes("python3") ? "python3" : "python"),
      );
      expect(result.args).toEqual(["script.py", "--option"]);
      expect(registerInterpreter.mock.calls.some(([extension]) => extension === ".vbs")).toBe(
        false,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("discovers native Java from PATH without JAVA_HOME", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nyastra-java-"));
  try {
    await writeFile(path.join(directory, "java"), "#!/bin/sh\n", { mode: 0o700 });
    vi.stubEnv("JAVA_HOME", undefined);
    vi.stubEnv("PATH", directory);
    vi.resetModules();
    const { default: init } = await import("./index");
    const registerInterpreter = vi.fn<types.IExtensionContext["registerInterpreter"]>();
    init({ registerInterpreter } as unknown as types.IExtensionContext);
    const java = registerInterpreter.mock.calls.find(([extension]) => extension === ".jar")![1];
    const options = { cwd: directory };
    expect(java({ executable: "tool.jar", args: ["--option"], options })).toEqual({
      executable: path.join(directory, "java"),
      args: ["-jar", "tool.jar", "--option"],
      options,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves JAVA_HOME precedence over PATH", async () => {
  vi.stubEnv("JAVA_HOME", "/configured-jvm");
  vi.stubEnv("PATH", "");
  vi.resetModules();
  const { default: init } = await import("./index");
  const registerInterpreter = vi.fn<types.IExtensionContext["registerInterpreter"]>();
  init({ registerInterpreter } as unknown as types.IExtensionContext);
  const java = registerInterpreter.mock.calls.find(([extension]) => extension === ".jar")![1];
  expect(java({ executable: "tool.jar", args: [], options: {} }).executable).toBe(
    "/configured-jvm/bin/java",
  );
});

it("reports missing Java when neither JAVA_HOME nor PATH provides it", async () => {
  vi.stubEnv("JAVA_HOME", undefined);
  vi.stubEnv("PATH", "");
  vi.resetModules();
  const { default: init } = await import("./index");
  const registerInterpreter = vi.fn<types.IExtensionContext["registerInterpreter"]>();
  init({ registerInterpreter } as unknown as types.IExtensionContext);
  const java = registerInterpreter.mock.calls.find(([extension]) => extension === ".jar")![1];
  expect(() => java({ executable: "tool.jar", args: [], options: {} })).toThrow(
    "Java isn't installed",
  );
});
