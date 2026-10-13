export const marker = "// Nyastra Linux Fluffy adaptation v3";
export const helperName = "nyastra-fluffy.cjs";

function replaceOnce(source, before, after) {
  const parts = source.split(before);
  if (parts.length !== 2)
    throw new Error(`Extension source changed: expected one match for ${JSON.stringify(before)}`);
  return parts.join(after);
}

export function adapt(source, game) {
  if (source.includes(marker)) return source;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  let updated = source.replaceAll("\r\n", "\n");
  const previous = updated.includes("// Nyastra Linux Fluffy adaptation v2");
  if (previous) updated = replaceOnce(updated, "// Nyastra Linux Fluffy adaptation v2", marker);
  else
    updated = replaceOnce(
      updated,
      "const template = require('string-template');",
      `const template = require('string-template');
${marker}
const { createFluffyIntegration } = require('./${helperName}');
const { sharedFluffyInstalled, fluffyModPath, fluffyTarget, configuredLauncher } =
  createFluffyIntegration({ fs, util, path });
function linuxFluffyTool(api) {
  return createFluffyIntegration({ fs, util, path }).linuxFluffyTool(
    api, GAME_ID, FLUFFY_ID, tools.find(tool => tool.id === FLUFFY_ID));
}
`,
    );
  updated = replaceOnce(
    updated,
    previous
      ? `    queryPath: process.platform === 'linux' ? () => Promise.resolve(
      configuredLauncher()?.path ? path.dirname(configuredLauncher().path) : '') : undefined,
    executable: () => process.platform === 'linux'
      ? (configuredLauncher()?.path ? path.basename(configuredLauncher().path) : '') : FLUFFY_EXEC,
    requiredFiles: process.platform === 'linux'
      ? (configuredLauncher()?.path ? [path.basename(configuredLauncher().path)] : []) : [FLUFFY_EXEC],
    parameters: process.platform === 'linux' ? (configuredLauncher()?.parameters || []) : [],
    detach: true,
    relative: process.platform !== 'linux',`
      : "    executable: () => FLUFFY_EXEC,\n    requiredFiles: [FLUFFY_EXEC],\n    detach: true,\n    relative: true,",
    `    queryPath: () => Promise.resolve(
      configuredLauncher()?.path ? path.dirname(configuredLauncher().path) : ''),
    executable: () => configuredLauncher()?.path ? path.basename(configuredLauncher().path) : '',
    requiredFiles: configuredLauncher()?.path ? [path.basename(configuredLauncher().path)] : [],
    parameters: configuredLauncher()?.parameters || [],
    detach: true,
    relative: false,`,
  );
  if (!previous)
    updated = replaceOnce(
      updated,
      "function isFluffyInstalled(api, spec) {",
      "function isFluffyInstalled(api, spec) {\n  if (sharedFluffyInstalled()) return true;",
    );
  updated = replaceOnce(
    updated,
    updated.match(/^async function downloadFluffy\(api, gameSpec\) \{[\s\S]*?^\}/m)?.[0] ?? "",
    `async function downloadFluffy(api, gameSpec) {
  linuxFluffyTool(api);
}`,
  );
  updated = replaceOnce(
    updated,
    updated.match(/^function runFluffy\(api\) \{[\s\S]*?^\}/m)?.[0] ?? "",
    `function runFluffy(api) {
  return Promise.resolve().then(() => {
    const { discovery, definition, configured } = linuxFluffyTool(api);
    const starter = new util.StarterInfo(util.getGame(GAME_ID), discovery, definition, configured);
    return util.StarterInfo.run(starter, api, (title, error, allowReport) =>
      api.showErrorNotification(title, error, { allowReport }));
  }).catch(err => api.showErrorNotification('Failed to run Fluffy Mod Manager', err, {
    allowReport: false,
  }));
}
`,
  );
  if (previous) return updated.replaceAll("\n", newline);
  if (game === "re4") {
    updated = replaceOnce(
      updated,
      "    return MOD_PATH_DEMO;",
      "    return fluffyModPath(MOD_PATH_DEMO);",
    );
    updated = replaceOnce(updated, "  return MOD_PATH;\n}", "  return fluffyModPath(MOD_PATH);\n}");
    updated = replaceOnce(
      updated,
      "\"targetPath\": path.join('{gamePath}', FLUFFYMOD_PATH)",
      "\"targetPath\": fluffyTarget('{gamePath}', FLUFFYMOD_PATH)",
    );
    updated = replaceOnce(
      updated,
      "pathPattern(context.api, game, path.join('{gamePath}', MOD_PATH_USED))",
      "pathPattern(context.api, game, fluffyTarget('{gamePath}', MOD_PATH_USED))",
    );
    updated = replaceOnce(
      updated,
      "fs.ensureDirWritableAsync(path.join(GAME_PATH, MOD_PATH_USED))",
      "fs.ensureDirWritableAsync(fluffyTarget(GAME_PATH, MOD_PATH_USED))",
    );
    updated = replaceOnce(
      updated,
      "fs.ensureDirWritableAsync(path.join(GAME_PATH, PRESET_PATH))",
      "fs.ensureDirWritableAsync(fluffyTarget(GAME_PATH, PRESET_PATH))",
    );
  } else if (game === "requiem") {
    if (updated.split("return FLUFFYMOD_PATH;").length !== 4)
      throw new Error("Extension source changed: expected three Requiem mod paths");
    updated = updated.replaceAll("return FLUFFYMOD_PATH;", "return fluffyModPath(FLUFFYMOD_PATH);");
    updated = replaceOnce(
      updated,
      "pathPattern(context.api, game, path.join('{gamePath}', FLUFFYMOD_PATH))",
      "pathPattern(context.api, game, fluffyTarget('{gamePath}', FLUFFYMOD_PATH))",
    );
    updated = replaceOnce(
      updated,
      "    await fs.ensureDirWritableAsync(path.join(gamePath, relPaths[index]));",
      `    const relativePath = relPaths[index];
    const destination = relativePath === FLUFFYMOD_PATH || relativePath === PRESET_PATH
      ? fluffyTarget(gamePath, relativePath)
      : path.join(gamePath, relativePath);
    await fs.ensureDirWritableAsync(destination);`,
    );
  } else {
    throw new Error(`Unsupported adaptation: ${game}`);
  }
  updated = replaceOnce(
    updated,
    "pathPattern(context.api, game, path.join('{gamePath}', PRESET_PATH))",
    "pathPattern(context.api, game, fluffyTarget('{gamePath}', PRESET_PATH))",
  );
  return updated.replaceAll("\n", newline);
}
