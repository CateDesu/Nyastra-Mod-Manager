# Nyastra's Mod Manager

A Linux mod manager for installing mod archives, managing profiles and
collections, and deploying mods through game extensions, with Steam and Proton
in mind. An independent, open source fork of
[Vortex](https://github.com/Nexus-Mods/Vortex), maintained by CateDesu.

<p align="center">
  <img src="assets/images/nyastra.png" alt="Astra, Nyastra's purple cat mascot" width="240">
</p>

**Platform:** Linux · **[Documentation](docs/README.md)** ·
[Upstream changelog](docs/changelog.md) · [Discord](https://discord.com/invite/TQJrbZcgKF)

[Installation](#installation) · [Importing a Vortex profile](#importing-a-vortex-profile) ·
[Mods on/off](#mods-onoff) · [Compatibility](#compatibility) ·
[Updating and saved data](#updating-and-saved-data) · [Getting help](#getting-help)

> [!NOTE]
> **This is an experimental Linux preview.** CachyOS x64 is the locally tested
> platform. Other distributions, games, extensions and collections need individual
> validation. This is not an official Nexus Mods release.

---

## Installation

Download a Linux package from the
**[preview releases](https://github.com/CateDesu/Nyastra-Mod-Manager/releases)**:

| Format                 | How to use it                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| **ZIP with installer** | Extract it and run `./install.sh` to add a launcher and desktop menu entry for your user. |
| **AppImage**           | Make the file executable and launch it.                                                   |
| **Debian package**     | Install the `.deb` through your package manager.                                          |

After installing the ZIP, open **Nyastra's Mod Manager** from your application
menu. The extracted folder can be removed once installation finishes.

When setting up a game, keep the mod staging folder on the same filesystem as
the game or mod output if you use hardlink deployment.

See the [installation guide](docs/packaging/linux.md#install-and-profile-import)
for installer options and the [compatibility notes](#compatibility) for runtime
requirements, including AppImage requirements.

### Importing a Vortex profile

**Already using Vortex on Linux?** Close both programs and follow the
[profile import instructions](docs/packaging/linux.md#install-and-profile-import)
before creating a Nyastra profile. Import copies the existing Linux profile
without changing its source. Mod archives and staging folders stay in place,
and imported account credentials are cleared. Wine and Lutris Windows profiles
are not imported.

## Mods on/off

The **Mods on/off** menu on the Mods page gives you three choices:

| Action                                    | What happens                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Disable all mods and remember enabled** | Saves the current profile's enabled installed mods, then disables them.                          |
| **Restore previously enabled mods**       | Restores only the saved selection and preserves later manual changes.                            |
| **Enable all installed mods**             | Enables every installed mod, including previously disabled ones, and clears the saved selection. |

The saved selection survives restarts. Repeating the disable action keeps the
first selection. These actions leave uninstalled archives alone and use your
normal deployment settings.

## Compatibility

- **Windows games and tools** use game extensions with Proton or Wine.
  Compatibility varies by game.
- **Native XML FOMOD installers** require glibc 2.38+ and libstdc++ providing
  `GLIBCXX_3.4.32` and `CXXABI_1.3.15`, including with the AppImage. Legacy C#
  installers are unsupported.
- **Fluffy integration** supports specific RE4 and Resident Evil Requiem
  extensions. It requires an existing Fluffy installation and a configured runner.
  See [extension setup](docs/packaging/linux-extensions.md) for supported versions.
  Third-party extension assets and Fluffy binaries are not bundled.
- **Nexus Mods registration** is pending. Personal API keys are available for
  testing and registration review. Public distribution with integrated login
  awaits Nyastra's own approved identifiers. See the
  [registration notes](docs/packaging/nexus-registration.md).

## Updating and saved data

Open **Settings → Linux updates** to check now or turn automatic checks on or off.
Checks look for compatible releases or newer source commits on GitHub without
changing program files. To update, close the program and install the new package
in the same format. See the [update guide](docs/updater.md).

Settings remain under `$XDG_CONFIG_HOME/NyastraModManager`, or
`~/.config/NyastraModManager` when that variable is unset. Keep any custom
`--user-data` location when restarting. Mod archives and staging folders remain
at their configured paths.

Upstream analytics, feature-flag requests and crash uploads are disabled. Logs
are shared manually after you review them. Local mod libraries and personal
settings are excluded from Git and release packages.

---

## Documentation

The [documentation index](docs/README.md) covers setup, usage and development.
Developer references:

- [Building from source](docs/install-instructions/README.md)
- [Linux packaging](docs/packaging/linux.md#build)
- [Repository layout](docs/repo-layout.md)
- [Updates](docs/updater.md)

## Getting help

Ask setup and usage questions in [Discord](https://discord.com/invite/TQJrbZcgKF).
Report bugs and request features through
[GitHub issues](https://github.com/CateDesu/Nyastra-Mod-Manager/issues).
Include your distribution, package version, game and extension versions, and
steps to reproduce the problem. Review logs before sharing them.

---

## License

Licensed under [GPL-3.0](LICENSE.md), with original contributor and dependency
notices retained. [NOTICE.md](NOTICE.md) credits Linux improvements reviewed from
[atabisz/Vortex](https://github.com/atabisz/Vortex) and the original Astra artwork.
Binary releases link to their exact modified source tag.
