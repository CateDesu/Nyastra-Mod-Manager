const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { createRequire } = require("node:module");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { promisify } = require("node:util");

const downloadUrl = "https://www.fluffyquack.com/tools/ARCtool.rar";
const run = promisify(execFile);

async function hasHeader(filename, signatures) {
  let handle;
  try {
    handle = await fsp.open(filename, "r");
    const buffer = Buffer.alloc(8);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return signatures.some(
      (signature) =>
        bytesRead >= signature.length && buffer.subarray(0, signature.length).equals(signature),
    );
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

function isArchive(filename) {
  return hasHeader(filename, [
    Buffer.from("Rar!\x1a\x07", "binary"),
    Buffer.from("PK\x03\x04", "binary"),
  ]);
}

async function download(url, filename, timeoutMs = 15000) {
  const temporary = `${filename}.${randomUUID()}.partial`;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, { signal });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`ARCtool download returned HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("ARCtool download returned no content");
    await pipeline(
      Readable.fromWeb(response.body),
      fs.createWriteStream(temporary, { flags: "wx" }),
      { signal },
    );
    if (!(await isArchive(temporary)))
      throw new Error("ARCtool download is not a RAR or ZIP archive");
    await fsp.rename(temporary, filename);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

async function ensureArcTool({ root = __dirname, url = downloadUrl, timeoutMs = 15000 } = {}) {
  const output = path.join(root, "dist", "ARCtool.exe");
  if (await hasHeader(output, [Buffer.from("MZ")])) return output;
  const cache = path.join(root, "dl");
  const archive = path.join(cache, "ARCtool.rar");
  await fsp.mkdir(cache, { recursive: true });
  let stage;
  try {
    if (!(await isArchive(archive))) {
      await fsp.rm(archive, { force: true });
      await download(url, archive, timeoutMs);
    }
    stage = await fsp.mkdtemp(path.join(cache, ".arctool-"));
    const sevenzip = createRequire(require.resolve("node-7z"))("7z-bin");
    await run(sevenzip, ["e", archive, `-o${stage}`, "ARCtool.exe", "-y"], { timeout: 30000 });
    const extracted = path.join(stage, "ARCtool.exe");
    if (!(await hasHeader(extracted, [Buffer.from("MZ")]))) {
      throw new Error("ARCtool archive does not contain a Windows executable named ARCtool.exe");
    }
    await fsp.mkdir(path.dirname(output), { recursive: true });
    await fsp.rename(extracted, output);
    return output;
  } catch (error) {
    await fsp.rm(archive, { force: true });
    throw error;
  } finally {
    if (stage) await fsp.rm(stage, { recursive: true, force: true });
  }
}

module.exports = { download, ensureArcTool };

if (require.main === module) {
  ensureArcTool().catch((error) => {
    console.warn(
      `Optional ARCtool unavailable: ${error.message}. MT Framework ARC support is disabled. ` +
        `Download ${downloadUrl} and unpack ARCtool.exe into ${path.join(__dirname, "dist")} to enable it.`,
    );
  });
}
