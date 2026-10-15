import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { runDivineCore } from "./divineCore";

it("passes file names literally to the actual Linux process without shell substitution", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nyastra-divine-"));
  try {
    const executable = path.join(directory, "divine");
    await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    await chmod(executable, 0o700);
    const marker = path.join(directory, "unexpected");
    const source = `file $(touch '${marker}') with spaces.pak`;
    const output = await runDivineCore(executable, "list-package", { source });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(output.stdout.split("\n")).toContain(source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
