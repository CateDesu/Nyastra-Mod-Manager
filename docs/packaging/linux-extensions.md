# Linux Fluffy Extensions

The native Linux program can adapt two existing game extensions to use an
existing Fluffy installation and Linux, Wine or Proton runner. Extension code
and artwork are supplied by their authors and are not included in the release.

## Supported extensions

- Resident Evil 4 (2023) Vortex Extension 0.4.1 by ChemBoy1.
- Resident Evil Requiem Vortex Extension 0.1.3 by ChemBoy1.

The installer applies the recipes to these exact installed versions. Other
versions and missing extensions are skipped. If an extension update replaces
the adaptation, rerun the installer. A version change needs a reviewed recipe
before it can be adapted.

For extensions installed after the program, close Nyastra and rerun the installed
installer. With the default application-data folder:

```bash
~/.local/share/nyastra-mod-manager/app/install.sh
```

For a custom `$XDG_DATA_HOME`, use `$XDG_DATA_HOME/nyastra-mod-manager/app/install.sh`.
This uses the bundled runtime and requires no separate Node installation.
From a source checkout, `node linux/extension-adaptations/apply.mjs` runs only
the adaptation step.

Use `--dry-run` to inspect the plan or `--user-data /path/to/NyastraModManager` for a custom
data directory. The default is `$XDG_CONFIG_HOME/NyastraModManager`, falling back to
`~/.config/NyastraModManager`. No source paths or Wine prefixes are inferred.

`--source-plugins /path/to/original/plugins` uses matching original extension
sources when replacing a previous local adaptation. The source is read only.
Only the installed `index.js` and the recipe's `nyastra-fluffy.cjs` helper change.
Original files and receipts remain under `NyastraModManager/extension-backups`. The recipe
prepares every supported source before writing and restores changed files if
installation fails.

## Fluffy configuration

Set a custom Fluffy tool on the game's Dashboard to use its full arguments,
environment, working directory and Proton handling. Custom Dashboard tools take
precedence over the optional default launcher.

An existing shared Fluffy installation can be configured in
`$XDG_CONFIG_HOME/nyastra-mod-manager/fluffy.json`, falling back to
`~/.config/nyastra-mod-manager/fluffy.json`:

```json
{
    "sharedFluffyRoot": "/path/to/Fluffy",
    "launcher": {
        "path": "/absolute/path/to/runner",
        "parameters": ["argument-for-your-existing-Fluffy-installation"]
    }
}
```

Paths must be absolute. `sharedFluffyRoot` is used only when it contains
`Modmanager.exe`. Fluffy mods and presets then target its `Games/RE4R` or
`Games/RE9` directories. RE4's demo uses `Games/RE4R_Demo`. Binaries and
REFramework remain in the game directory. Without a shared root, mods and
presets use the extension's original game-local directories.

No launcher is chosen automatically. A missing runner stops Linux setup before
directory changes or automatic Windows Fluffy downloads. After deploying mods,
enable them in Fluffy. Real game and authenticated Nexus behavior still needs
validation for each game.

## Verification and local material

Run `node linux/extension-adaptations/verify.mjs --source-plugins
/path/to/original/plugins` to exercise the recipes and VM fixtures without
launching Fluffy or a game. The verification checks native destinations,
Dashboard routing, custom tools, missing-runner handling,
backup restoration and repeat installation.

Ignored `linux/extension-adaptations/local/` holds this machine's downloaded
extension copies and old installation records. They are not release inputs.
Only the maintained recipes and runtime helper are packaged.

## Key Files

- `linux/extension-adaptations/manifest.json` lists the exact supported extensions and their authors.
- `linux/extension-adaptations/adapt.mjs` transforms matching extension source.
- `linux/extension-adaptations/runtime.cjs` reads per-user configuration and routes Fluffy through Dashboard tools.
- `linux/extension-adaptations/apply.mjs` applies recipes with backups and rollback.
- `linux/extension-adaptations/verify.mjs` checks isolated installation and extension behavior.
