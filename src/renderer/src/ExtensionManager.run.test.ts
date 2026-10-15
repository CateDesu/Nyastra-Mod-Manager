import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import Bluebird from "bluebird";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ExtensionManager from "./ExtensionManager";
import { makeNxmHarness } from "./test-utils/builders";
import type { IRunParameters } from "./types/IExtensionContext";

vi.mock("./IPCDownloadAdapter", () => ({ IPCDownloadAdapter: class {} }));
vi.mock("fs-extra", async (importOriginal) => {
  const actual = await importOriginal<{ default: object }>();
  return { ...actual.default, ...actual, readdirSync: vi.fn(() => []) };
});
vi.mock("./views/layout/ToastContainer", () => ({ isToastSystemDisabled: () => true }));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nyastra-launch-"));
  const prototype = ExtensionManager.prototype as unknown as {
    prepareExtensions: () => [];
    initExtensions: () => void;
  };
  vi.spyOn(prototype, "prepareExtensions").mockReturnValue([]);
  vi.spyOn(prototype, "initExtensions").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function manager() {
  const harness = makeNxmHarness();
  const result = new ExtensionManager({}, harness.api.events);
  const api = result.getApi();
  api.store = harness.api.store;
  api.getState = harness.api.getState;
  return result;
}

describe("real Linux executable launches", () => {
  it.each([true, undefined])(
    "treats shell executable filenames literally with shell=%s",
    async (shell) => {
      const api = manager().getApi();
      const executable = path.join(root, 'Tool\'s "$(touch shell-expanded)".sh');
      const output = path.join(root, "output.txt");
      await writeFile(executable, '#!/bin/sh\nprintf done > "$OUTPUT_FILE"\n', { mode: 0o700 });

      const error = await api
        .runExecutable(executable, [], {
          cwd: root,
          shell,
          detach: false,
          expectSuccess: true,
          env: { OUTPUT_FILE: output },
        })
        .then(
          () => undefined,
          (failure: unknown) => failure,
        );

      await expect(readFile(path.join(root, "shell-expanded"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(error).toBeUndefined();
      expect(await readFile(output, "utf8")).toBe("done");
    },
  );

  it("keeps explicitly quoted shell arguments working", async () => {
    const api = manager().getApi();
    const executable = path.join(root, "capture.sh");
    const output = path.join(root, "output.txt");
    await writeFile(executable, '#!/bin/sh\nprintf "%s" "$1" > "$OUTPUT_FILE"\n', { mode: 0o700 });
    await api.runExecutable(executable, ['"two words"'], {
      shell: true,
      detach: false,
      expectSuccess: true,
      env: { OUTPUT_FILE: output },
    });
    expect(await readFile(output, "utf8")).toBe("two words");
  });

  it("preserves quotes inside direct arguments and accepts legacy enclosing quotes", async () => {
    const api = manager().getApi();
    const helper = path.join(root, "capture.cjs");
    const output = path.join(root, "output.json");
    await writeFile(
      helper,
      'require("node:fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify(process.argv.slice(2)));',
    );
    await api.runExecutable(
      process.execPath,
      [helper, '{"key":"value"}', 'embedded"quote', '"two words"'],
      {
        shell: false,
        detach: false,
        expectSuccess: true,
        env: { OUTPUT_FILE: output },
      },
    );
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual([
      '{"key":"value"}',
      'embedded"quote',
      "two words",
    ]);
  });

  it("uses the final hook working directory and environment", async () => {
    const instance = manager();
    const initial = path.join(root, "initial");
    const final = path.join(root, "final");
    await mkdir(initial);
    await mkdir(final);
    const output = path.join(root, "output.json");
    const helper = path.join(root, "capture.cjs");
    await writeFile(
      helper,
      'require("node:fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({cwd: process.cwd(), value: process.env.LAUNCH_VALUE}));',
    );
    const hooks = instance as unknown as {
      mStartHooks: Array<{
        priority: number;
        id: string;
        hook: (input: IRunParameters) => Bluebird<IRunParameters>;
      }>;
    };
    hooks.mStartHooks.push({
      priority: 100,
      id: "test-environment",
      hook: (input) =>
        Bluebird.resolve({
          ...input,
          options: {
            ...input.options,
            cwd: final,
            env: { OUTPUT_FILE: output, LAUNCH_VALUE: "final" },
          },
        }),
    });
    await instance.getApi().runExecutable(process.execPath, [helper], {
      cwd: initial,
      env: { OUTPUT_FILE: output, LAUNCH_VALUE: "initial" },
      shell: false,
      detach: false,
      expectSuccess: true,
    });
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ cwd: final, value: "final" });
  });
});
