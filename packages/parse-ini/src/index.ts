import { randomUUID } from "node:crypto";
import { readFile, realpath, stat, writeFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface IChanges {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface IIniFormat {
  read(filePath: string): Promise<object>;
  write(filePath: string, data: object, changes: IChanges): Promise<void>;
}

type IniData = Record<string, Record<string, string>>;

function flatten(data: object, prefix = ""): Record<string, unknown> {
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(data)) {
    const fullKey = prefix + key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(output, flatten(value, `${fullKey}###`));
    } else {
      output[fullKey] = value;
    }
  }
  return output;
}

export class IniFile<T extends object> {
  private stored: T;
  private mutable: T | undefined;

  constructor(data: T) {
    this.stored = data;
  }

  get data(): T {
    this.mutable ??= structuredClone(this.stored);
    return this.mutable;
  }

  set data(value: T) {
    this.mutable = value;
  }

  changes(): IChanges {
    const before = flatten(this.stored);
    const after = flatten(this.mutable ?? this.stored);
    return {
      added: Object.keys(after).filter((key) => !Object.hasOwn(before, key)),
      removed: Object.keys(before).filter((key) => !Object.hasOwn(after, key)),
      changed: Object.keys(after).filter(
        (key) => Object.hasOwn(before, key) && before[key] !== after[key],
      ),
    };
  }

  apply(): void {
    this.stored = structuredClone(this.mutable ?? this.stored);
  }
}

interface Document {
  lines: string[];
  newline: string;
  encoding: "utf8" | "utf16le" | "latin1";
  bom: Buffer;
}

async function document(filePath: string): Promise<Document> {
  const bytes = await readFile(filePath);
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  const utf8Bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const bom = bytes.subarray(0, utf16 ? 2 : utf8Bom ? 3 : 0);
  const content = bytes.subarray(bom.length);
  const encoding = utf16 ? "utf16le" : "utf8";
  // A fatal decode detects legacy byte encodings without replacing their text.
  let text: string;
  let selected: Document["encoding"] = encoding;
  try {
    text = utf16
      ? content.toString("utf16le")
      : new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    selected = "latin1";
    text = content.toString("latin1");
  }
  return {
    lines: text.split(/\r?\n/),
    newline: text.includes("\r\n") ? "\r\n" : "\n",
    encoding: selected,
    bom,
  };
}

function parse(lines: string[]): IniData {
  const data: IniData = Object.create(null);
  let section: string | undefined;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]/);
    if (header) {
      section =
        Object.keys(data).find((key) => key.toLowerCase() === header[1]!.toLowerCase()) ??
        header[1]!;
      data[section] ??= Object.create(null);
      continue;
    }
    if (!section || /^\s*[;#]/.test(line)) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim();
    if (!name) continue;
    const values = data[section]!;
    const key = Object.keys(values).find((key) => key.toLowerCase() === name.toLowerCase()) ?? name;
    if (!Object.hasOwn(values, key)) {
      const value = line.slice(separator + 1).trim();
      values[key] = /^(".*"|'.*')$/.test(value) ? value.slice(1, -1) : value;
    }
  }
  return data;
}

/** Edits game INI files on Linux while retaining comments, encoding and line endings. */
export class PortableIniFormat implements IIniFormat {
  async read(filePath: string): Promise<IniData> {
    return parse((await document(filePath)).lines);
  }

  async write(filePath: string, input: object, changes: IChanges): Promise<void> {
    if (![...changes.added, ...changes.changed, ...changes.removed].length) return;
    try {
      filePath = await realpath(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    let doc: Document;
    try {
      doc = await document(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      doc = { lines: [], newline: "\n", encoding: "utf8", bom: Buffer.alloc(0) };
    }
    const data = input as IniData;
    for (const fullKey of [...changes.removed, ...changes.changed, ...changes.added]) {
      const [section, key, ...rest] = fullKey.split("###");
      if (!section || !key || rest.length || /[\r\n\[\]]/.test(section) || /[\r\n=]/.test(key))
        throw new Error(`Invalid INI key: ${fullKey}`);
      const value = data[section]?.[key];
      if (value !== undefined && /[\r\n]/.test(String(value)))
        throw new Error(`Invalid multiline INI value: ${fullKey}`);
      let current = "";
      let sectionEnd = -1;
      let foundSection = false;
      let wrote = false;
      const output: string[] = [];
      for (const line of doc.lines) {
        const header = line.match(/^\s*\[([^\]]+)\]/);
        if (header) {
          if (current === section.toLowerCase()) sectionEnd = output.length;
          current = header[1]!.toLowerCase();
          if (current === section.toLowerCase()) foundSection = true;
        }
        const separator = line.indexOf("=");
        if (
          current === section.toLowerCase() &&
          !/^\s*[;#]/.test(line) &&
          separator >= 0 &&
          line.slice(0, separator).trim().toLowerCase() === key.toLowerCase()
        ) {
          if (value !== undefined && !wrote) {
            output.push(`${line.slice(0, separator + 1)}${String(value)}`);
            wrote = true;
          }
          continue;
        }
        output.push(line);
      }
      if (value !== undefined && !wrote) {
        if (!foundSection) {
          if (output.length && output.at(-1) !== "") output.push("");
          output.push(`[${section}]`, `${key}=${String(value)}`);
        } else {
          const at = sectionEnd < 0 ? output.length - (output.at(-1) === "" ? 1 : 0) : sectionEnd;
          output.splice(at, 0, `${key}=${String(value)}`);
        }
      }
      doc.lines = output;
    }
    if (doc.encoding === "latin1" && /[^\u0000-\u00ff]/.test(doc.lines.join("")))
      throw new Error("This INI encoding cannot represent the requested value");
    const temp = join(dirname(filePath), `.${basename(filePath)}-${randomUUID()}.tmp`);
    let mode = 0o600;
    try {
      mode = (await stat(filePath)).mode & 0o777;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    try {
      await writeFile(
        temp,
        Buffer.concat([doc.bom, Buffer.from(doc.lines.join(doc.newline), doc.encoding)]),
        { flag: "wx", mode },
      );
      await rename(temp, filePath);
    } finally {
      await rm(temp, { force: true });
    }
  }
}

// Older game extensions use this name for the game file format.
export { PortableIniFormat as WinapiFormat };

export default class IniParser {
  constructor(private format: IIniFormat) {}

  async read<T extends object>(filePath: string): Promise<IniFile<T>> {
    return new IniFile((await this.format.read(filePath)) as T);
  }

  async write<T extends object>(filePath: string, file: IniFile<T>): Promise<void> {
    await this.format.write(filePath, file.data, file.changes());
    file.apply();
  }
}
