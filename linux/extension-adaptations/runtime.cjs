"use strict";

const nodeFs = require("node:fs");
const os = require("node:os");
const nodePath = require("node:path");

function configPath(util) {
    const configHome = process.env.XDG_CONFIG_HOME;
    const root =
        configHome && nodePath.isAbsolute(configHome)
            ? configHome
            : nodePath.join(os.homedir(), ".config");
    return nodePath.join(
        root || nodePath.join(os.homedir(), ".config"),
        "nyastra-mod-manager",
        "fluffy.json",
    );
}

function readConfig(util) {
    const filename = configPath(util);
    try {
        const config = JSON.parse(nodeFs.readFileSync(filename, "utf8"));
        if (!config || typeof config !== "object" || Array.isArray(config))
            throw new Error("Expected an object");
        if (
            config.sharedFluffyRoot !== undefined &&
            (typeof config.sharedFluffyRoot !== "string" ||
                !nodePath.isAbsolute(config.sharedFluffyRoot))
        ) {
            throw new Error("sharedFluffyRoot must be an absolute path");
        }
        if (
            config.launcher !== undefined &&
            (!config.launcher ||
                typeof config.launcher.path !== "string" ||
                !nodePath.isAbsolute(config.launcher.path) ||
                (config.launcher.parameters !== undefined &&
                    (!Array.isArray(config.launcher.parameters) ||
                        config.launcher.parameters.some((value) => typeof value !== "string"))))
        ) {
            throw new Error("launcher requires an absolute path and string parameters");
        }
        return config;
    } catch (error) {
        if (error.code === "ENOENT") return {};
        throw new util.SetupError(
            `Cannot read Fluffy configuration at ${filename}: ${error.message}`,
        );
    }
}

function createFluffyIntegration({ fs, util, path }) {
    function sharedFluffyInstalled() {
        const root = readConfig(util).sharedFluffyRoot;
        if (!root) return false;
        try {
            return fs.statSync(path.join(root, "Modmanager.exe")).isFile();
        } catch (_) {
            return false;
        }
    }

    function fluffyModPath(relativePath) {
        if (!sharedFluffyInstalled() || path.isAbsolute(relativePath)) return relativePath;
        return path.join(readConfig(util).sharedFluffyRoot, relativePath);
    }

    function fluffyTarget(gamePath, relativePath) {
        const destination = fluffyModPath(relativePath);
        return path.isAbsolute(destination) ? destination : path.join(gamePath, destination);
    }

    function configuredLauncher() {
        return readConfig(util).launcher;
    }

    function linuxFluffyTool(api, gameId, fluffyId, definition) {
        const discovery = util.getSafe(
            api.getState(),
            ["settings", "gameMode", "discovered", gameId],
            {},
        );
        const discovered = discovery.tools?.[fluffyId];
        const launcher = configuredLauncher();
        const configured = discovered?.custom
            ? discovered
            : launcher
              ? { id: fluffyId, ...launcher, parameters: launcher.parameters || [] }
              : discovered;
        try {
            if (
                (discovered?.custom || launcher) &&
                configured?.path &&
                fs.statSync(configured.path).isFile()
            ) {
                return { discovery, definition, configured };
            }
        } catch (_) {
            // Report the unavailable runner below.
        }
        throw new util.SetupError(
            "Configure a working Fluffy Mod Manager tool on the Dashboard, or set launcher in " +
                configPath(util) +
                ". An existing Linux, Proton or Wine runner is required.",
        );
    }

    return {
        sharedFluffyInstalled,
        fluffyModPath,
        fluffyTarget,
        configuredLauncher,
        linuxFluffyTool,
    };
}

module.exports = { configPath, readConfig, createFluffyIntegration };
