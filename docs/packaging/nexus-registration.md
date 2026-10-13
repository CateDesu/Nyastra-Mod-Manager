# Nexus Mods registration

Official process:
https://help.nexusmods.com/article/114-api-acceptable-use-policy

Nexus Mods asks developers to email support@nexusmods.com with a testing build
that works with a personal API key. After review, provide the application name,
short description and a high resolution logo visible on a dark background.
Nexus then issues an SSO application slug. Registration does not imply endorsement.

Name: Nyastra's Mod Manager

Description: An independent, open source Linux mod manager based on Vortex,
with Steam and Proton discovery, native archive and XML FOMOD installation,
and game-specific deployment support.

Source: https://github.com/CateDesu/Nyastra-Mod-Manager

Logo: assets/images/nyastra.png. The transparent original Astra mascot was
generated for this program. Generation details are recorded alongside it.

Also request a public desktop OAuth client ID, approved loopback redirect details
and PKCE S256 support for the program's existing OAuth flow. It binds only to
127.0.0.1 on a dynamically allocated port. A desktop client must not embed a
client secret. The current redirect is http://127.0.0.1:<allocated-port> with no callback path. Nexus must approve any
variable-port redirect policy rather than the program assuming permission.

The application sends its own Application-Name and version headers. It retains
real Nexus Mods addresses and account labels. It does not use the inherited
Vortex OAuth client ID or SSO slug. Personal API keys remain a testing mechanism
until registration. No private key should be included in source or an email
attachment of the source tree.

The public client ID and SSO slug belong in
src/renderer/src/extensions/nexus_integration/constants.ts after they are issued.
Rebuild, verify the approved browser sign-in flow and replace testing artifacts
before an end-user release. Send the approved testing ZIP or a usable download
link with the request; a private draft release cannot be downloaded by reviewers.
