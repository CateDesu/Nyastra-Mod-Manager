import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const mainRequire = createRequire(new URL("../src/main/package.json", import.meta.url));
const rendererRequire = createRequire(new URL("../src/renderer/package.json", import.meta.url));
const nexusPath = mainRequire.resolve("@nexusmods/nexus-api");
const Nexus = mainRequire("@nexusmods/nexus-api").default;

test("the renderer SVG sanitizer is available from the program runtime", () => {
  const createDOMPurify = mainRequire("dompurify");
  assert.equal(typeof createDOMPurify, "function");
  assert.ok(createDOMPurify.version);
});

test("QuickBMS requires HTTPS and rejects redirects and failed downloads before extraction", async (t) => {
  const source = await readFile(
    new URL("../extensions/quickbms-support/download_dependencies.js", import.meta.url),
    "utf8",
  );
  let status = 200;
  let redirected = 0;
  const server = createServer((request, response) => {
    if (request.url === "/redirected") redirected++;
    response.writeHead(status, status === 302 ? { location: "/redirected" } : {});
    response.end("archive fixture");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const quickRequire = createRequire(
    new URL("../extensions/quickbms-support/package.json", import.meta.url),
  );
  const fetch = quickRequire("cross-fetch");

  for (const scenario of [
    "success",
    "http error",
    "redirect",
    "body error",
    "write error",
    "extract error",
  ]) {
    status = scenario === "http error" ? 403 : scenario === "redirect" ? 302 : 200;
    const process = {};
    const writes = [];
    const extracted = [];
    const removed = [];
    const warnings = [];
    const fs = {
      promises: {
        stat: async () => {
          throw Object.assign(new Error("absent"), { code: "ENOENT" });
        },
        writeFile: async (...args) => {
          if (scenario === "write error") throw new Error("write fixture");
          writes.push(args);
        },
        rm: async (...args) => removed.push(args),
      },
    };
    await runInNewContext(source, {
      Buffer,
      console: { log() {}, error() {}, warn: (message) => warnings.push(message) },
      process,
      require(name) {
        if (name === "fs") return fs;
        if (name === "path") return path;
        if (name === "cross-fetch")
          return async (url, options) => {
            assert.equal(url, "https://aluigi.altervista.org/papers/quickbms.zip");
            assert.equal(options.redirect, "error");
            if (scenario === "body error")
              return {
                ok: true,
                arrayBuffer: async () => {
                  throw new Error("body fixture");
                },
              };
            return fetch(`http://127.0.0.1:${server.address().port}/download`, options);
          };
        if (name === "node-7z")
          return class {
            async extract(...args) {
              extracted.push(args);
              if (scenario === "extract error") throw new Error("extract fixture");
            }
          };
        throw new Error(`Unexpected dependency: ${name}`);
      },
    });
    assert.equal(
      process.exitCode,
      ["success", "http error"].includes(scenario) ? undefined : 1,
      scenario,
    );
    assert.equal(warnings.length, scenario === "http error" ? 1 : 0, scenario);
    assert.equal(
      extracted.length,
      ["success", "extract error"].includes(scenario) ? 1 : 0,
      scenario,
    );
    assert.equal(writes.length, ["success", "extract error"].includes(scenario) ? 1 : 0, scenario);
    assert.equal(removed.length, ["http error", "redirect"].includes(scenario) ? 0 : 1, scenario);
    if (scenario === "success") {
      assert.equal(writes[0][0], "quickbms.zip");
      assert.equal(writes[0][1].toString(), "archive fixture");
      assert.equal(extracted[0][0], "quickbms.zip");
      assert.equal(extracted[0][1], "dist");
    }
  }
  assert.equal(redirected, 0);
});

test("runtime audit rejects contradictory, incomplete and failing registry responses", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "nyastra-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pnpm");
  await writeFile(
    executable,
    `#!${process.execPath}\nprocess.stdout.write(process.env.AUDIT_FIXTURE);\nprocess.exit(Number(process.env.AUDIT_STATUS));\n`,
  );
  await chmod(executable, 0o700);
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  const response = (advisories = {}, vulnerabilities = counts) => ({
    advisories,
    metadata: { vulnerabilities },
  });
  const cases = [
    ["clean", response(), 0, true],
    ["failing command", response(), 1, false],
    ["count without advisory", response({}, { ...counts, high: 1 }), 0, false],
    ["advisory without findings", response({ fixture: { findings: [] } }), 0, false],
    ["missing severity counts", response({}, { high: 0 }), 0, false],
    ["string count", response({}, { ...counts, high: "0" }), 0, false],
    ["negative count", response({}, { ...counts, high: -1 }), 0, false],
    ["invalid advisory collection", response([]), 0, false],
    ["missing metadata", {}, 0, false],
  ];
  for (const [label, fixture, status, succeeds] of cases) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./audit-runtime.mjs", import.meta.url))],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}${path.delimiter}${process.env.PATH}`,
          AUDIT_FIXTURE: JSON.stringify(fixture),
          AUDIT_STATUS: String(status),
        },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status === 0, succeeds, `${label}: ${result.stderr}`);
  }
});

test("the pinned Nexus client has no shipped request imports", async () => {
  const directory = path.dirname(nexusPath);
  const files = (await readdir(directory)).filter((file) => file.endsWith(".js"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = await readFile(path.join(directory, file), "utf8");
    assert.doesNotMatch(source, /(?:require\s*\(|from\s*)["']request["']/, file);
  }
  const lockfile = await readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  assert.doesNotMatch(lockfile, /^  request@/m);
});

test("the Nexus caller preserves local GET and POST requests and rejects redirects", async (t) => {
  const calls = [];
  let redirect = false;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url: request.url, body });
    if (redirect) {
      response.writeHead(302, { location: "https://127.0.0.1:1/private" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.method === "GET" ? [{ id: 1 }] : { message: "tracked" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new Nexus("Nyastra test", "1.0.0", "skyrim", 1000);
  client.mBaseURL = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await client.getGames(), [{ id: 1 }]);
  assert.deepEqual(await client.trackMod(42), { message: "tracked" });
  assert.equal(calls[0].url, "/games");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].url, "/user/tracked_mods");
  assert.deepEqual(JSON.parse(calls[1].body), { domain_name: "skyrim", mod_id: 42 });
  redirect = true;
  await assert.rejects(client.getGames(), (error) => error.statusCode === 302);
  assert.equal(calls.length, 3);
});

test("UUID stays callable from CommonJS and rejects undersized buffers", () => {
  const { v4, v5, validate } = mainRequire("uuid");
  assert.ok(validate(v4()));
  assert.throws(() => v5("fixture", v5.DNS, new Uint8Array(1)), RangeError);
});

test("the arc renderer keeps its CommonJS API", () => {
  const { arc } = rendererRequire("d3-shape");
  const result = arc().innerRadius(5).outerRadius(10).startAngle(0).endAngle(Math.PI)();
  assert.match(result, /^M/);
  assert.doesNotMatch(result, /NaN/);
});

test("the chart color parser handles long malformed input promptly", () => {
  const chartRequire = createRequire(rendererRequire.resolve("recharts"));
  const vendorRequire = createRequire(chartRequire.resolve("victory-vendor/package.json"));
  const interpolateRequire = createRequire(vendorRequire.resolve("d3-interpolate"));
  const colorUrl = pathToFileURL(interpolateRequire.resolve("d3-color")).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { color } from ${JSON.stringify(colorUrl)};
    if (color("rgb(" + "1".repeat(50000) + "!")) process.exit(1);
    if (color("hsl(" + " ".repeat(50000) + "!")) process.exit(1);
    if (color("red").formatHex() !== "#ff0000") process.exit(1);
  `,
    ],
    { timeout: 2000, encoding: "utf8" },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
