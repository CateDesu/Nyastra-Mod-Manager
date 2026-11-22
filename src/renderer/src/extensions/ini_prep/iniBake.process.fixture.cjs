const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");
const { randomUUID } = require("node:crypto");

const repo = path.resolve(__dirname, "../../../../..");
const req = createRequire(path.join(repo, "src/renderer/package.json"));
const PromiseBB = req("bluebird");
const native = PromiseBB.promisifyAll(req("fs-extra"));
const { default: IniParser, IniFile, WinapiFormat } = req("vortex-parse-ini");
const names = [
    "completeSettingsOperations",
    "cleanupIniBake",
    "withIniBakeTemporary",
    "snapshotIni",
    "recoverIniBake",
    "publishIniBake",
    "genIniFormat",
    "missingOptionalFile",
    "getBaseFile",
    "bakeSettings",
    "purgeChanges",
];
const [operation, boundary, directory, sourceFile] = process.argv.slice(2);
const code = fs.readFileSync(sourceFile, "utf8");
const file = path.join(directory, "Skyrim.ini");
const record = file + ".baked.cleanup";
const die = () => process.kill(process.pid, "SIGKILL");
const isLiveTemporary = (destination) =>
    destination.startsWith(file + ".baked.") && destination.endsWith(".live.tmp");
const api = {
    ...native,
    forcePerm: (_t, fn) => fn(),
    makeFileWritableAsync: (name) => native.chmodAsync(name, 0o600),
    openAsync: async (...args) => {
        const result = await native.openAsync(...args);
        if (boundary === "marker-created" && args[0] === record) die();
        return result;
    },
    mkdirAsync: async (...args) => {
        const result = await native.mkdirAsync(...args);
        if (boundary === "marker-created" && args[0] === record + ".init") die();
        return result;
    },
    writeFileAsync: async (destination, ...args) => {
        if (
            (destination === record || destination === path.join(record + ".init", "owner")) &&
            boundary === "marker-partial"
        ) {
            await fsp.writeFile(destination, "12345678", {
                flag: fs.existsSync(destination) ? "r+" : "wx",
            });
            die();
        }
        return native.writeFileAsync(destination, ...args);
    },
    copyAsync: async (src, dest, options) => {
        if (boundary === "partial-staging" && (isLiveTemporary(dest) || dest === file)) {
            await fsp.writeFile(dest, "[General]\nowner=");
            die();
        }
        const result = await native.copyAsync(src, dest, options);
        if (boundary === "before-replace" && dest === file) die();
        if (boundary === "after-replace" && dest === file) die();
        return result;
    },
    renameAsync: async (src, dest) => {
        if (boundary === "before-replace" && dest === file && isLiveTemporary(src)) die();
        const result = await native.renameAsync(src, dest);
        if (boundary === "after-replace" && dest === file && isLiveTemporary(src)) die();
        if (boundary === "marker-published" && dest === record) die();
        return result;
    },
};
if (boundary === "live-unlink") {
    const graceful = createRequire(req.resolve("fs-extra"))("graceful-fs");
    const unlink = graceful.unlink;
    graceful.unlink = (destination, callback) =>
        unlink(destination, (error) => {
            if (!error && destination === file) die();
            callback(error);
        });
}
const bindings = {
    PromiseBB,
    fs: api,
    path,
    randomUUID,
    log: () => {},
    IniParser,
    IniFile,
    WinapiFormat,
    iniFiles: () => [file],
    iniFormat: () => "winapi",
    optionalIniFiles: () => [],
    installPathForGame: () => directory,
    INI_TWEAKS_PATH: "INI Tweaks",
    setdefault: () => {
        throw new Error("Unexpected tweak");
    },
    getSafe: () => [],
    deepMerge: (left, right) => ({ ...left, ...right }),
};
const functions = Function(
    ...Object.keys(bindings),
    code + "\nreturn {" + names.join(",") + "};",
)(...Object.values(bindings));
(async () => {
    if (operation === "recover") await functions.recoverIniBake(file);
    else if (operation === "purge") await functions.purgeChanges(() => {}, "skyrimse", {});
    else
        await functions.bakeSettings(
            () => {},
            "skyrimse",
            {},
            [],
            {},
            async (_name, ini) => {
                ini.data.General ??= {};
                ini.data.General.owner = "new";
            },
            operation === "optional" ? [path.basename(file)] : [],
        );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
