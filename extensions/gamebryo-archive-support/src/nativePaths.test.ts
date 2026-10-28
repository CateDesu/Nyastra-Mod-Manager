import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { loadBA2 } from "./ba2";
import { loadBSA } from "./bsa";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "nyastra-archive-paths-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it.each([103, 104, 105])("extracts BSA v%s into native nested directories", async (version) => {
  const archive = await loadBSA(path.resolve(__dirname, "../test-data", `test-v${version}.bsa`));
  const expected = JSON.parse(
    await readFile(path.resolve(__dirname, "../test-data/expected-bsa.json"), "utf8"),
  )[`v${version}`].files;
  await archive.extractAll(directory);
  for (const [name, content] of Object.entries(expected)) {
    expect(await readFile(path.join(directory, ...name.split("\\")), "utf8")).toBe(content);
  }
  expect((await readdir(directory)).some((name) => name.includes("\\"))).toBe(false);
});

it.each([
  { type: "GNRL", name: "scripts\\quest\\main.pex", payloadOffset: 0, prefix: "" },
  { type: "DX10", name: "textures\\armor\\iron.dds", payloadOffset: 128, prefix: "DDS " },
])(
  "extracts $type BA2 into native nested directories",
  async ({ type, name, payloadOffset, prefix }) => {
    const content = Buffer.from("archive payload");
    const entry = Buffer.alloc(type === "GNRL" ? 36 : 48);
    const dataOffset = 24 + entry.length;
    if (type === "GNRL") {
      entry.writeBigUInt64LE(BigInt(dataOffset), 16);
      entry.writeUInt32LE(content.length, 28);
    } else {
      entry[13] = 1;
      entry.writeUInt16LE(24, 14);
      entry.writeUInt16LE(4, 16);
      entry.writeUInt16LE(4, 18);
      entry[20] = 1;
      entry[21] = 87;
      entry.writeBigUInt64LE(BigInt(dataOffset), 24);
      entry.writeUInt32LE(content.length, 36);
    }
    const header = Buffer.alloc(24);
    header.write("BTDX");
    header.writeUInt32LE(1, 4);
    header.write(type, 8);
    header.writeUInt32LE(1, 12);
    header.writeBigUInt64LE(BigInt(dataOffset + content.length), 16);
    const nameTable = Buffer.alloc(2 + name.length);
    nameTable.writeUInt16LE(name.length);
    nameTable.write(name, 2);
    const archivePath = path.join(directory, "input.ba2");
    await writeFile(archivePath, Buffer.concat([header, entry, content, nameTable]));
    const archive = await loadBA2(archivePath);
    const output = path.join(directory, "extracted");
    await archive.extractAll(output);
    const extracted = await readFile(path.join(output, ...name.split("\\")));
    expect(extracted.subarray(payloadOffset)).toEqual(content);
    expect(extracted.subarray(0, prefix.length).toString()).toBe(prefix);
    expect((await readdir(output)).some((filename) => filename.includes("\\"))).toBe(false);
  },
);
