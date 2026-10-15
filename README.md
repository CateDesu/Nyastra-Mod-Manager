# Nyastra's Mod Manager

An independent, experimental Linux-only fork of
[Vortex](https://github.com/Nexus-Mods/Vortex), maintained by CateDesu.
The program runs natively on Linux and supports modding Windows games through
Steam and Proton. Windows desktop builds and host integrations are removed.

[Releases](https://github.com/CateDesu/Nyastra-Mod-Manager/releases) ·
[Build and install](docs/packaging/linux.md) ·
[Linux extension setup](docs/packaging/linux-extensions.md) ·
[Report a problem](https://github.com/CateDesu/Nyastra-Mod-Manager/issues)

The Linux preview provides a ZIP with a user installer, an AppImage and a Debian
package. CachyOS x64 is the locally tested platform. Other distributions and game
extensions need individual validation. Native XML FOMOD installation requires
glibc 2.38+ and a compatible libstdc++. Legacy C# installers are unsupported.

The program uses original Astra artwork. Actual Nexus Mods website names,
accounts, addresses and download links retain the service's identity. Stored
mod records and extension identifiers remain compatible with Vortex. Linux
improvements reviewed from [atabisz/Vortex](https://github.com/atabisz/Vortex)
are credited in [NOTICE.md](NOTICE.md).

Nyastra has its own desktop identity, user profile, support tracker and release
page. It automatically checks for compatible Linux releases or newer source
commits. Installing an update remains your choice. See [updates](docs/updater.md).
Existing Linux profiles can be imported explicitly without moving
mod archives or staging folders. The source profile remains available. Imported
account credentials are cleared so the new program can use its own registration.

Nexus Mods application registration is pending. This testing preview permits a
personal API key for registration review. Public end-user distribution with
integrated Nexus login waits for the program's own approved identifiers. The
program does not use Vortex's OAuth client ID, analytics, crash-upload endpoint
or Windows update feed. See [registration](docs/packaging/nexus-registration.md).

Local mod libraries, Fluffy binaries and personal settings are excluded from Git
and release packages. See the [folder map](docs/repo-layout.md).

The Mods page has a **Mods on/off** menu. **Disable all mods and remember enabled**
saves the current profile's enabled installed mods across restarts. **Restore
previously enabled mods** enables only that saved list and preserves later manual
changes. Repeating Disable all keeps the first list. **Enable all installed mods**
also enables previously disabled mods and clears the saved list. These controls
leave uninstalled archives alone and use the normal deployment settings.

Licensed under [GPL-3.0](LICENSE.md). Original contributor and dependency notices
are retained. Binary releases link to their exact modified source tag.
