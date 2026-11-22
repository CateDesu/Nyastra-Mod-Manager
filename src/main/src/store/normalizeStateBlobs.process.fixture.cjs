const path = require("node:path");
const { createRequire, Module } = require("node:module");

const [directory, extensionDirectory, compiled, dependencyBase, boundary, action] =
    process.argv.slice(2);
const dependencyRequire = createRequire(dependencyBase);
const duckdb = dependencyRequire("@duckdb/node-api");
const load = Module._load;
Module._load = function (request, parent, main) {
    if (request === "../logging") return { log: () => {} };
    if (request === "../getVortexPath") return { getVortexPath: () => extensionDirectory };
    if (request === "@vortex/shared") return { unknownToError: (error) => error };
    if (request === "@vortex/shared/errors") return { DataInvalid: Error, VortexError: Error };
    if (request === "@vortex/shared/state")
        return load.call(this, path.join(compiled, "sharedState.js"), parent, main);
    if (request === "@duckdb/node-api") return duckdb;
    return load.call(this, request, parent, main);
};

async function run() {
    const Singleton = require(path.join(compiled, "DuckDBSingleton.js")).default;
    const LevelPersist = require(path.join(compiled, "LevelPersist.js")).default;
    const { normalizeStateBlobs } = require(path.join(compiled, "normalizeStateBlobs.js"));
    const singleton = Singleton.getInstance();
    await singleton.initialize(extensionDirectory);
    const alias = singleton.nextAlias();
    const persist = new LevelPersist(await singleton.attachDatabase(directory, alias), alias);
    const cut = () => {
        require("node:fs").writeSync(1, boundary);
        process.kill(process.pid, "SIGKILL");
    };
    const runNative = persist.connection.run.bind(persist.connection);
    persist.connection.run = async (sql, ...args) => {
        const result = await runNative(sql, ...args);
        if (
            (boundary === "after-delete" && sql.startsWith("DELETE")) ||
            (boundary === "partial-reinsert" && sql.startsWith("INSERT")) ||
            (boundary === "after-commit" && sql === "COMMIT")
        )
            cut();
        return result;
    };
    if (action === "ancestor-remove") {
        await persist.removeItem(["persistent", "mods", "skyrimse", "retained"]);
    } else if (action === "ancestor-update") {
        await persist.setItem(
            ["persistent", "mods", "skyrimse", "retained", "attributes", "name"],
            JSON.stringify("Updated"),
        );
    } else {
        await normalizeStateBlobs(persist);
    }
    throw new Error("Normalization did not reach the requested process boundary");
}
run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
