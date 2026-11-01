import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { adapt, helperName, marker } from "./adapt.mjs";
import { applyExtensions } from "./apply.mjs";

const outputRoot = import.meta.dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(outputRoot, "manifest.json"), "utf8"));
manifest.plugins = manifest.plugins.filter((plugin) => plugin.game !== "helldivers2");
const sourceFlag = process.argv.indexOf("--source-plugins");
const sourceRoot = path.resolve(
  sourceFlag < 0 ? path.join(outputRoot, "local", "originals") : process.argv[sourceFlag + 1],
);
const sharedRoot = "/fixture/Fluffy";
const helperSource = fs.readFileSync(path.join(outputRoot, "runtime.cjs"), "utf8");
const temporaryRoots = [];
let checks = 0;

function equal(actual, expected, message) {
  const normalize = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  assert.deepEqual(normalize(actual), normalize(expected), message);
  checks++;
}

function harness(plugin, sharedExists, configured = true) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-native-extension-"));
  temporaryRoots.push(temporaryRoot);
  const temporaryGame = path.join(temporaryRoot, "game");
  fs.mkdirSync(temporaryGame);
  for (const filename of ["re4.exe", "re9.exe", "re_chunk_000.pak", "modmanager.exe"]) {
    fs.writeFileSync(path.join(temporaryGame, filename), "fixture only\n");
  }
  const configHome = path.join(temporaryRoot, "config");
  const configDirectory = path.join(configHome, "nyastra-mod-manager");
  fs.mkdirSync(configDirectory, { recursive: true });
  if (configured)
    fs.writeFileSync(
      path.join(configDirectory, "fluffy.json"),
      JSON.stringify({
        sharedFluffyRoot: sharedRoot,
        launcher: { path: "/usr/bin/lutris", parameters: ["fixture:existing-fluffy"] },
      }),
    );
  const platformPath = path.posix;
  const gamePath = temporaryGame;
  const launches = [];
  const starterCalls = [];
  const ensured = [];
  const notifications = [];
  const stat = (filename) => {
    if (filename === "/usr/bin/lutris") return { isFile: () => true };
    if (filename === path.posix.join(sharedRoot, "Modmanager.exe")) {
      if (sharedExists) return { isFile: () => true };
    } else if (filename.startsWith(`${temporaryGame}/`)) {
      return fs.statSync(filename);
    }
    const error = new Error(`ENOENT fixture: ${filename}`);
    error.code = "ENOENT";
    throw error;
  };
  const state = {
    settings: { gameMode: { discovered: {} } },
    persistent: { mods: {} },
  };
  const getSafe = (input, keys, fallback) =>
    keys.reduce((value, key) => value?.[key], input) ?? fallback;
  const api = {
    getState: () => state,
    store: { getState: () => state },
    runExecutable: async (filename, args, options) => {
      launches.push({ filename, args, options });
    },
    showErrorNotification: (...args) => {
      notifications.push(args);
    },
    sendNotification: () => {},
    events: {
      emit: () => {
        throw new Error("Unexpected download or deployment during fixture verification");
      },
    },
    ext: {},
  };
  const vortexApi = {
    actions: {},
    fs: {
      statSync: stat,
      statAsync: async (filename) => stat(filename),
      ensureDirWritableAsync: async (directory) => {
        ensured.push(directory);
      },
    },
    util: {
      getSafe,
      getVortexPath: () => path.join(configHome, "NyastraModManager"),
      GameStoreHelper: { findByAppId: async () => ({ gamePath }) },
      getGame: () => game,
      SetupError: class SetupError extends Error {},
      StarterInfo: class StarterInfo {
        constructor(game, discovery, definition, configured) {
          this.game = game;
          this.discovery = discovery;
          this.definition = definition;
          this.configured = configured;
        }
        static async run(starter) {
          starterCalls.push(starter);
        }
      },
    },
    selectors: {
      downloadPathForGame: () => path.join(temporaryRoot, "downloads"),
      installPathForGame: () => path.join(temporaryRoot, "staging"),
    },
    log: () => {},
  };
  const sandbox = {
    module: { exports: {} },
    process: { platform: "linux", env: { XDG_CONFIG_HOME: configHome } },
    __dirname: path.join(sourceRoot, plugin.directory),
    __testApi: api,
    require: (id) => {
      if (id === "vortex-api") return vortexApi;
      if (id === "path") return platformPath;
      if (id === "./" + helperName) return helperModule.exports;
      if (id === "string-template")
        return (pattern, values) => pattern.replace(/\{([^}]+)\}/g, (_, key) => values[key]);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  const helperModule = { exports: {} };
  const helperSandbox = {
    module: helperModule,
    process: sandbox.process,
    require: (id) => {
      if (id === "node:fs") return fs;
      if (id === "node:os") return os;
      if (id === "node:path") return path;
      throw new Error(`Unexpected helper require: ${id}`);
    },
  };
  vm.runInNewContext(helperSource, helperSandbox);
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(sourceRoot, plugin.directory, "index.js"), "utf8");
  new vm.Script(adapt(source, plugin.game), { filename: plugin.directory }).runInContext(sandbox);
  let game;
  const modTypes = [];
  sandbox.module.exports.default({
    api,
    registerGame: (value) => {
      game = value;
    },
    registerModType: (id, priority, condition, destination, test, options) => {
      modTypes.push({ id, destination, options });
    },
    registerInstaller: () => {},
    registerAction: () => {},
    once: () => {},
  });
  const fluffTool = game.supportedTools.find((tool) => tool.name === "Fluffy Mod Manager");
  const refType = modTypes.find((type) => type.options.name === "REFramework");
  state.settings.gameMode.discovered[game.id] = {
    path: gamePath,
    tools: { [fluffTool.id]: { path: platformPath.join(gamePath, "modmanager.exe") } },
  };
  state.persistent.mods[game.id] = { framework: { type: refType.id } };
  return {
    sandbox,
    game,
    gamePath,
    api,
    state,
    modTypes,
    fluffTool,
    launches,
    starterCalls,
    ensured,
    notifications,
  };
}

try {
  for (const configHome of [undefined, "relative/path", "/fixture/xdg"]) {
    const helperModule = { exports: {} };
    vm.runInNewContext(helperSource, {
      module: helperModule,
      process: { platform: "linux", env: { XDG_CONFIG_HOME: configHome } },
      require: (id) => {
        if (id === "node:fs") return fs;
        if (id === "node:path") return path;
        if (id === "node:os") return { homedir: () => "/fixture/home" };
        throw new Error(`Unexpected helper require: ${id}`);
      },
    });
    equal(
      helperModule.exports.configPath({ getVortexPath: () => "/custom/user/data" }),
      path.join(
        configHome === "/fixture/xdg" ? configHome : "/fixture/home/.config",
        "nyastra-mod-manager",
        "fluffy.json",
      ),
      "Fluffy configuration follows XDG independently of custom Vortex user data",
    );
  }
  for (const plugin of manifest.plugins) {
    const isRe4 = plugin.game === "re4";
    const folder = isRe4 ? "RE4R" : "RE9";
    const linux = harness(plugin, true);
    const mods = path.posix.join(sharedRoot, "Games", folder, "Mods");
    const presets = path.posix.join(sharedRoot, "Games", folder, "Presets");
    equal(linux.game.queryModPath(linux.gamePath), mods, "Default native deployment path");
    for (const type of linux.modTypes) {
      if (["Fluffy Mod", "Fluffy Pak Mod"].includes(type.options.name)) {
        equal(type.destination(linux.game), mods, `Shared ${type.options.name} destination`);
      } else if (type.options.name === "Fluffy Preset") {
        equal(type.destination(linux.game), presets, "Shared preset destination");
      } else if (["Binaries / Root Folder", "REFramework"].includes(type.options.name)) {
        equal(
          type.destination(linux.game),
          linux.gamePath,
          `Game-local ${type.options.name} destination`,
        );
      }
    }
    equal(await linux.fluffTool.queryPath(), "/usr/bin", "Native launcher discovery directory");
    equal(linux.fluffTool.executable(), "lutris", "Native launcher executable");
    equal(linux.fluffTool.requiredFiles, ["lutris"], "Native launcher required file");
    equal(linux.fluffTool.parameters, ["fixture:existing-fluffy"], "Native launcher parameters");
    equal(linux.fluffTool.relative, false, "Native launcher is outside the game");
    equal(
      vm.runInContext("isFluffyInstalled(__testApi, spec)", linux.sandbox),
      true,
      "Existing shared manager prevents a duplicate download",
    );
    await linux.game.setup({ path: linux.gamePath });
    assert.ok(linux.ensured.includes(mods));
    assert.ok(linux.ensured.includes(presets));
    checks += 2;
    for (const type of linux.modTypes.filter((type) => type.options.name === "Fluffy Mod")) {
      equal(type.destination(linux.game), mods, "No duplicate absolute prefix after setup");
    }
    await vm.runInContext("runFluffy(__testApi)", linux.sandbox);
    equal(linux.starterCalls.length, 1, "Notification uses the Dashboard StarterInfo route");
    equal(
      linux.starterCalls[0].configured.path,
      "/usr/bin/lutris",
      "Explicit per-user launcher is selected",
    );
    equal(
      linux.starterCalls[0].configured.parameters,
      ["fixture:existing-fluffy"],
      "Explicit per-user arguments are selected",
    );
    equal(linux.launches.length, 0, "Notification does not bypass StarterInfo");
    equal(linux.notifications.length, 0, "Successful native launcher has no error");

    const unconfigured = harness(plugin, false, false);
    equal(unconfigured.fluffTool.executable(), "", "No default Linux runner is invented");
    equal(
      await unconfigured.fluffTool.queryPath(),
      "",
      "No default Linux runner directory is invented",
    );
    await assert.rejects(
      unconfigured.game.setup({ path: unconfigured.gamePath }),
      /Configure a working Fluffy Mod Manager tool/,
    );
    checks++;
    equal(unconfigured.ensured, [], "Missing config blocks setup before writes");

    const absent = harness(plugin, false, false);
    equal(
      absent.game.queryModPath(absent.gamePath),
      path.posix.join("Games", folder, "Mods"),
      "Absent shared manager retains a game-local destination for an explicitly configured runner",
    );
    equal(
      vm.runInContext("isFluffyInstalled(__testApi, spec)", absent.sandbox),
      false,
      "Absent shared manager retains installer check",
    );
    await assert.rejects(
      absent.game.setup({ path: absent.gamePath }),
      /Configure a working Fluffy Mod Manager tool/,
    );
    checks++;
    equal(absent.ensured, [], "Missing runner blocks setup before directory changes");
    await vm.runInContext("runFluffy(__testApi)", absent.sandbox);
    equal(
      absent.starterCalls.length,
      0,
      "Absent manager does not launch the unrelated default tool",
    );
    equal(absent.launches.length, 0, "Absent manager does not launch Lutris directly");
    equal(absent.notifications.length, 1, "Absent manager produces an actionable error");
    assert.match(absent.notifications[0][1].message, /Configure a working Fluffy Mod Manager tool/);
    checks++;

    for (const sharedExists of [false, true]) {
      const customized = harness(plugin, sharedExists, sharedExists);
      const customTool = {
        id: customized.fluffTool.id,
        path: path.posix.join(customized.gamePath, "modmanager.exe"),
        parameters: ["--profile", 'custom "quoted" profile'],
        environment: { CUSTOM_FLUFFY: "enabled" },
        workingDirectory: customized.gamePath,
        custom: true,
        shell: false,
        detach: false,
        onStart: "hide",
      };
      const customDiscovery = customized.state.settings.gameMode.discovered[customized.game.id];
      customDiscovery.tools[customized.fluffTool.id] = customTool;
      customDiscovery.store = "steam";
      await customized.game.setup({ path: customized.gamePath });
      equal(
        customized.notifications.length,
        0,
        "Configured runner setup does not download a duplicate manager",
      );
      await vm.runInContext("runFluffy(__testApi)", customized.sandbox);
      equal(customized.starterCalls.length, 1, "Customized runner uses StarterInfo");
      equal(
        customized.starterCalls[0].configured,
        customTool,
        "Custom arguments, environment, shell and window settings are preserved",
      );
      equal(
        customized.starterCalls[0].discovery.store,
        "steam",
        "Steam store is passed through for Proton handling",
      );
      equal(customized.launches.length, 0, "Custom runner does not use the fixed Lutris launch");

      customTool.path = path.posix.join(customized.gamePath, "missing.exe");
      await vm.runInContext("runFluffy(__testApi)", customized.sandbox);
      equal(customized.starterCalls.length, 1, "Missing customized runner is not launched");
      equal(
        customized.notifications.length,
        1,
        "Missing customized runner produces an actionable error",
      );
    }

    console.log(
      `PASS ${plugin.directory}: native paths, StarterInfo launch, custom settings, missing-runner errors`,
    );
  }
  await verifyInstaller();
  console.log(`${checks} assertions passed. Real game, Fluffy and Lutris operations were stubbed.`);
} finally {
  for (const temporaryRoot of temporaryRoots)
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

async function verifyInstaller() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-extensions-install-"));
  temporaryRoots.push(userData);
  const plugins = path.join(userData, "plugins");
  for (const plugin of manifest.plugins) {
    const directory = path.join(plugins, plugin.directory);
    fs.mkdirSync(directory, { recursive: true });
    for (const filename of ["index.js", "info.json"]) {
      fs.copyFileSync(
        path.join(sourceRoot, plugin.directory, filename),
        path.join(directory, filename),
      );
    }
  }
  equal(
    (await applyExtensions({ userData, dryRun: true })).adapted.length,
    2,
    "Dry run prepares both recipes",
  );
  equal(
    fs.existsSync(path.join(userData, "extension-backups")),
    false,
    "Dry run does not create backups",
  );
  const result = await applyExtensions({ userData });
  equal(result.adapted.length, 2, "Installer applies both known versions");
  for (const plugin of manifest.plugins) {
    equal(
      fs.readFileSync(path.join(result.backupRoot, plugin.directory, "index.js"), "utf8"),
      fs.readFileSync(path.join(sourceRoot, plugin.directory, "index.js"), "utf8"),
      "Original source is preserved",
    );
    assert.ok(
      fs.readFileSync(path.join(plugins, plugin.directory, "index.js"), "utf8").includes(marker),
    );
    checks++;
    equal(
      fs.readFileSync(path.join(plugins, plugin.directory, helperName), "utf8"),
      helperSource,
      "Maintained helper is installed exactly",
    );
  }
  equal((await applyExtensions({ userData })).adapted.length, 0, "Repeat install is idempotent");
  equal(
    fs.readdirSync(path.join(userData, "extension-backups")).length,
    1,
    "Repeat install creates no extra backups",
  );
  for (const plugin of manifest.plugins) {
    fs.copyFileSync(
      path.join(sourceRoot, plugin.directory, "index.js"),
      path.join(plugins, plugin.directory, "index.js"),
    );
    fs.rmSync(path.join(plugins, plugin.directory, helperName));
  }
  const originalRename = fsp.rename;
  let indexReplacements = 0;
  fsp.rename = async (from, to) => {
    if (to.endsWith(path.sep + "index.js") && ++indexReplacements === 2)
      throw new Error("Fixture replacement failure");
    return originalRename(from, to);
  };
  try {
    await assert.rejects(applyExtensions({ userData }), /Fixture replacement failure/);
    checks++;
  } finally {
    fsp.rename = originalRename;
  }
  for (const plugin of manifest.plugins) {
    equal(
      fs.readFileSync(path.join(plugins, plugin.directory, "index.js"), "utf8"),
      fs.readFileSync(path.join(sourceRoot, plugin.directory, "index.js"), "utf8"),
      "Failed transaction restores original source",
    );
    equal(
      fs.existsSync(path.join(plugins, plugin.directory, helperName)),
      false,
      "Failed transaction removes the new helper",
    );
  }
  const first = manifest.plugins[0];
  const info = path.join(plugins, first.directory, "info.json");
  const metadata = JSON.parse(fs.readFileSync(info, "utf8"));
  metadata.version = "999";
  fs.writeFileSync(info, JSON.stringify(metadata));
  const wrongVersion = await applyExtensions({ userData, dryRun: true });
  equal(wrongVersion.adapted.length, 1, "Unsupported versions are skipped");
  equal(
    wrongVersion.skipped[0].reason,
    "Installed version differs from the supported recipe",
    "Version skip is explained",
  );
  const second = manifest.plugins[1];
  const helper = path.join(plugins, second.directory, helperName);
  fs.symlinkSync(path.join(sourceRoot, second.directory, "index.js"), helper);
  await assert.rejects(applyExtensions({ userData }), /Refusing extension symlink/);
  checks++;
  const missing = path.join(userData, "empty", "NyastraModManager");
  equal(
    (await applyExtensions({ userData: missing })).adapted.length,
    0,
    "Absent extensions are skipped",
  );
  equal(fs.existsSync(missing), false, "Absent extensions leave the filesystem untouched");
  console.log(
    "PASS extension installer: dry run, exact versions, backups, repeat install, rollback, symlink refusal and absent extensions",
  );
}
