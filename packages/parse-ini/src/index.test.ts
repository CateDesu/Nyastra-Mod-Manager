import { mkdtemp, readFile, writeFile, rm, symlink, lstat, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import IniParser, { PortableIniFormat } from "./index";

type Data = Record<string, Record<string, string>>;
let directory: string;
let filePath: string;
const parser = new IniParser(new PortableIniFormat());
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "nyastra-ini-"));
  filePath = join(directory, "game.ini");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("Linux game INI editing", () => {
  it("handles long lines without separators and preserves key spacing", async () => {
    const padding = " ".repeat(100000);
    await writeFile(filePath, `[Game]\n${padding}no separator\n  Enabled  =1\nName=a=b\n`);
    const ini = await parser.read<Data>(filePath);
    expect(ini.data.Game).toEqual({ Enabled: "1", Name: "a=b" });
    ini.data.Game!.Enabled = "2";
    await parser.write(filePath, ini);
    expect(await readFile(filePath, "utf8")).toBe(
      `[Game]\n${padding}no separator\n  Enabled  =2\nName=a=b\n`,
    );
  });

  it("updates and removes keys while preserving comments, casing and unrelated sections", async () => {
    await writeFile(
      filePath,
      "; game settings\r\n[Display]\r\nbEnabled=1\r\n; retained comment\r\niRemove=2\r\n\r\n[Audio]\r\nfVolume=0.5\r\n",
    );
    const ini = await parser.read<Data>(filePath);
    ini.data.Display!.bEnabled = "0";
    delete ini.data.Display!.iRemove;
    ini.data.Display!.iNew = "3";
    await parser.write(filePath, ini);
    const output = await readFile(filePath, "utf8");
    expect(output).toBe(
      "; game settings\r\n[Display]\r\nbEnabled=0\r\n; retained comment\r\n\r\niNew=3\r\n[Audio]\r\nfVolume=0.5\r\n",
    );
    expect(ini.changes()).toEqual({ added: [], changed: [], removed: [] });
  });

  it("preserves external edits to untouched keys made after reading", async () => {
    await writeFile(filePath, "[Game]\nselected=old\nuntouched=before\n");
    const ini = await parser.read<Data>(filePath);
    ini.data.Game!.selected = "new";
    await writeFile(filePath, "[Game]\nselected=old\nuntouched=external\n");
    await parser.write(filePath, ini);
    expect(await readFile(filePath, "utf8")).toContain("untouched=external");
    expect(await readFile(filePath, "utf8")).toContain("selected=new");
  });

  it("reads section and key names without case duplicates and removes stale duplicate values", async () => {
    await writeFile(filePath, "[Game]\nEnabled=1\nenabled=stale\n[GAME]\nOther=2\n");
    const ini = await parser.read<Data>(filePath);
    expect(ini.data).toEqual({ Game: { Enabled: "1", Other: "2" } });
    ini.data.Game!.Enabled = "0";
    await parser.write(filePath, ini);
    expect(await readFile(filePath, "utf8")).toBe("[Game]\nEnabled=0\n[GAME]\nOther=2\n");
  });

  it("preserves a UTF-16LE BOM and Windows line endings for Proton games", async () => {
    await writeFile(
      filePath,
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('[Game]\r\nName="Astra"\r\n', "utf16le"),
      ]),
    );
    const ini = await parser.read<Data>(filePath);
    expect(ini.data.Game!.Name).toBe("Astra");
    ini.data.Game!.Name = "Nyastra";
    await parser.write(filePath, ini);
    const bytes = await readFile(filePath);
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(bytes.subarray(2).toString("utf16le")).toBe("[Game]\r\nName=Nyastra\r\n");
  });

  it("preserves UTF-8 BOM and non-ASCII text", async () => {
    await writeFile(
      filePath,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("[Game]\nName=猫\nOther=1\n")]),
    );
    const ini = await parser.read<Data>(filePath);
    ini.data.Game!.Other = "2";
    await parser.write(filePath, ini);
    const bytes = await readFile(filePath);
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(bytes.toString()).toContain("Name=猫");
  });

  it("preserves legacy encoded bytes when changing ASCII values", async () => {
    const original = Buffer.from("[Game]\nName=caf\xe9\nOther=1\n", "latin1");
    await writeFile(filePath, original);
    const ini = await parser.read<Data>(filePath);
    ini.data.Game!.Other = "2";
    await parser.write(filePath, ini);
    expect(await readFile(filePath)).toEqual(
      Buffer.from("[Game]\nName=caf\xe9\nOther=2\n", "latin1"),
    );
  });

  it("writes through a Proton configuration symlink without replacing it", async () => {
    const target = join(directory, "actual.ini");
    await writeFile(target, "[Game]\nEnabled=1\n", { mode: 0o640 });
    await symlink(target, filePath);
    const ini = await parser.read<Data>(filePath);
    ini.data.Game!.Enabled = "0";
    await parser.write(filePath, ini);
    expect((await lstat(filePath)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toContain("Enabled=0");
    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });

  it("creates a new section without changing existing settings", async () => {
    await writeFile(filePath, "[Game]\nEnabled=1\n");
    const ini = await parser.read<Data>(filePath);
    ini.data.New = { Name: "Astra" };
    await parser.write(filePath, ini);
    expect((await parser.read<Data>(filePath)).data).toEqual({
      Game: { Enabled: "1" },
      New: { Name: "Astra" },
    });
  });

  it("rejects injected lines and leaves the original file and pending changes intact", async () => {
    const original = "[Game]\nEnabled=1\n";
    await writeFile(filePath, original);
    const ini = await parser.read<Data>(filePath);
    ini.data.Game!.Enabled = "2\nInjected=3";
    await expect(parser.write(filePath, ini)).rejects.toThrow("multiline");
    expect(await readFile(filePath, "utf8")).toBe(original);
    expect(ini.changes().changed).toEqual(["Game###Enabled"]);
  });

  it("does not change a file when there are no edits", async () => {
    await writeFile(filePath, "[Game]\nEnabled = '1'\n");
    const before = await stat(filePath);
    await parser.write(filePath, await parser.read(filePath));
    expect((await stat(filePath)).ino).toBe(before.ino);
  });
});
