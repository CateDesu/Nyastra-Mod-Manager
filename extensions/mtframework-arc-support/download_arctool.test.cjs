const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const { download, ensureArcTool } = require("./download_arctool.js");

async function fixture(t, handler) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "vortex-arctool-"));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    return { root, url: `http://127.0.0.1:${server.address().port}/ARCtool.rar` };
}

test("HTTP errors and invalid content never become cached archives", async (t) => {
    for (const [status, content] of [
        [404, "missing"],
        [200, "<html>error</html>"],
        [200, ""],
    ]) {
        const { root, url } = await fixture(t, (_, response) => {
            response.writeHead(status);
            response.end(content);
        });
        await assert.rejects(
            download(url, path.join(root, "ARCtool.rar")),
            /HTTP 404|not a RAR or ZIP/,
        );
        assert.deepEqual(await fsp.readdir(root), []);
    }
});

test("the deadline covers a response that stalls while sending its body", async (t) => {
    const { root, url } = await fixture(t, (_, response) => {
        response.writeHead(200);
        response.write(Buffer.from("Rar!\x1a\x07", "binary"));
    });
    const started = Date.now();
    await assert.rejects(download(url, path.join(root, "ARCtool.rar"), 100), /abort|timeout/i);
    assert.ok(Date.now() - started < 3000);
    assert.deepEqual(await fsp.readdir(root), []);
});

test("download and extraction complete before success and reuse valid offline output", async (t) => {
    const payload = Buffer.from("MZfixture executable header only. Never executed.");
    let requests = 0;
    let archive;
    const { root, url } = await fixture(t, (_, response) => {
        requests++;
        response.end(archive);
    });
    const source = path.join(root, "source");
    await fsp.mkdir(source);
    await fsp.writeFile(path.join(source, "ARCtool.exe"), payload);
    const input = path.join(root, "fixture.zip");
    const sevenzip = createRequire(require.resolve("node-7z"))("7z-bin");
    await promisify(execFile)(sevenzip, ["a", "-tzip", input, "ARCtool.exe"], { cwd: source });
    archive = await fsp.readFile(input);
    await fsp.mkdir(path.join(root, "dl"));
    await fsp.writeFile(path.join(root, "dl", "ARCtool.rar"), "");
    const output = await ensureArcTool({ root, url });
    assert.deepEqual(await fsp.readFile(output), payload);
    assert.equal(requests, 1);
    assert.deepEqual(await fsp.readdir(path.join(root, "dl")), ["ARCtool.rar"]);
    assert.equal(await ensureArcTool({ root, url: "http://127.0.0.1:1/unavailable" }), output);
    assert.equal(requests, 1);
});

test("an archive missing ARCtool.exe fails and discards the unusable cache", async (t) => {
    let archive;
    const { root, url } = await fixture(t, (_, response) => response.end(archive));
    const source = path.join(root, "unrelated.txt");
    await fsp.writeFile(source, "fixture");
    const input = path.join(root, "fixture.zip");
    const sevenzip = createRequire(require.resolve("node-7z"))("7z-bin");
    await promisify(execFile)(sevenzip, ["a", "-tzip", input, source]);
    archive = await fsp.readFile(input);
    await assert.rejects(ensureArcTool({ root, url }), /does not contain a Windows executable/);
    assert.deepEqual(await fsp.readdir(path.join(root, "dl")), []);
    await assert.rejects(fsp.stat(path.join(root, "dist", "ARCtool.exe")), { code: "ENOENT" });
});
