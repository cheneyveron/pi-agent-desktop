# Desktop release updates

`pi-agent-desktop` 会将已安装的 macOS、Windows 或 Linux 应用作为一个由 updater 签名的完整包更新。该安装包会记录三个组件在 `src-tauri/resources/component-versions.json` 中的确切版本：

1. `cheneyveron/pi-agent-desktop`
2. `earendil-works/pi`
3. `agegr/pi-web`

The settings screen checks only the latest stable `cheneyveron/pi-agent-desktop` GitHub Release, at most once a week. If the installed desktop app version is older, its single **Upgrade** button downloads that signed release, installs the complete app, and restarts it. It never replaces JavaScript or dependencies inside an already installed signed app.

## Automatic component sync

Both component sync and signed releases are started manually from GitHub Actions. Component sync checks the fork boundary before merging: changes requiring review open a PR; eligible direct updates run the validation checks before reaching `main`. Sync does not dispatch a release automatically.

After the reviewed changes and version bump reach `main`, run **Publish signed desktop release** in `cheneyveron/pi-agent-desktop`. The workflow keeps the Release in draft until every platform and the component manifest succeed.

## One-time signing setup

Tauri updater signatures are mandatory. This distribution's signing key is stored in
`/ssd/appdata/secrets/pi-agent-desktop.yaml` under `tauri_updater` (`private_key`,
`public_key`, and `password`). The private and public keys are configured as the
repository Actions secrets below. Reuse this key for subsequent releases; replacing
it prevents installed copies from verifying the new update. Never print the key
or put it in command arguments. The current key has an empty password, so the
password Actions secret is intentionally unset.

For a new distribution only, generate a key on a trusted machine:

```bash
npm exec tauri signer generate -- -w /ssd/appdata/secrets/pi-agent-desktop-updater.key
```

Store these repository Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`: contents of the private key file;
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: password chosen during generation;
- `TAURI_UPDATER_PUBLIC_KEY`: the exact Base64 contents of the `.pub` file generated next to the private key.

The release workflow validates this public key before installing dependencies and
injects it into Tauri's updater configuration for both bundle signing and runtime
verification. The key is never printed by the workflow.

Never commit the private key or its password. The public key is embedded at compile time only in release builds. Local builds deliberately do not register the updater plugin.

### macOS Developer ID signing and notarization

macOS builds are signed with a **Developer ID Application** certificate of
Solidtensor Inc. and notarized, so a downloaded app opens without the user
approving it in System Settings. Only the Account Holder can create that
certificate (the App Store Connect API answers 403), so it is made by hand at
developer.apple.com › Certificates › **Developer ID Application** (G2 Sub-CA)
from the CSR in `/ssd/appdata/secrets/pi-agent-desktop/apple/`; the private key
next to it never leaves the secrets directory. The downloaded `.cer` goes to the
same folder as `developer-id-application.cer`, and is exported with the key and
its intermediate CA as a password-protected `.p12`.

Repository Actions secrets (never commit any of them; this repository is public):

- `APPLE_CERTIFICATE`: Base64 of the `.p12` (certificate, private key, Developer ID intermediate);
- `APPLE_CERTIFICATE_PASSWORD`: the `.p12` password;
- `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_PRIVATE_KEY`: key id, issuer id and `.p8` contents of an App Store Connect team API key, used by `notarytool`.

The release workflow imports the certificate into a temporary keychain and
derives `APPLE_SIGNING_IDENTITY` from it. `desktop:prepare` then signs what
Tauri leaves alone under `Contents/Resources` — every Mach-O in the staged
server tree (node-pty's `pty.node` and `spawn-helper`, …) and `Pi Agent
Server.app`, whose Node runtime gets `desktop/server-helper.entitlements` (JIT,
unsigned executable memory, no library validation for user-installed native
addons) — with the hardened runtime and a secure timestamp
(`scripts/macos-codesign.mjs`). Notarization rejects the whole app if any one of
them is unsigned. Tauri signs and notarizes the app and staples the ticket; the
workflow then notarizes and staples the DMG, checks both with `spctl`, and
replaces the draft's DMG with the stapled one. A missing secret fails the macOS
build instead of falling back to an ad-hoc signature.

The first Developer ID release changes the app's code-signing requirement, so
macOS asks once more for folder access granted to earlier ad-hoc builds. Later
updates keep the same requirement and keep their grants.

## Publishing

Merging upstream changes includes publishing updated desktop installers by default, unless the user requests a code-only merge. Delivery ends after the published installers are verified; updating the local deployment requires a separate explicit request.

After the reviewed changes and version bump are committed and pushed to `origin/main`, run:

```bash
npm run desktop:release
```

The script verifies the GitHub identity, pushed commit and component versions, starts
(or resumes) the signed release workflow, waits for all platforms, then verifies the
published installers, signature files, component manifest, updater targets and tag.
It reports only status changes. Concurrent invocations in the same checkout are
locked; rerunning follows an existing run. An already published version is verified
without starting another release. Version bumps and release notes remain part of
preparing the reviewed change.

On Hermes it reads `pi_agent_telepi_pat` from the existing credential record above.
Elsewhere set `GH_TOKEN` (or `GITHUB_TOKEN`) for the `cheneyveron` account with repository
write and Actions access. Credentials stay in memory. Signing uses the existing
Actions secrets.

```bash
npm run desktop:release -- --no-wait      # Start/resume, print the Actions URL, exit
npm run desktop:release -- --verify-only  # Verify the current published version
npm run desktop:release -- --retry-failed # Explicitly retry failed jobs
```

A failed build exits nonzero and leaves the release draft. Interrupting the script
or its 90-minute timeout does not stop the remote build; rerun to resume monitoring.


Start **Publish signed desktop release** manually after the release changes reach `main`. It verifies that the bundled `pi` and `pi-web` versions match their latest stable Releases or the documented versions in `scripts/release-component-pins.json`, then sequentially creates Apple Silicon (`aarch64`) DMG/updater artifacts, a Linux x64 `.deb`, and a Windows x64 NSIS `-setup.exe`/updater archive. Intel Mac (`x86_64-apple-darwin`) artifacts are not built. The Release stays in draft until all platforms and the component manifest are present; only then is `v<pi-agent-desktop version>` published as the latest Release.

The workflow uses Developer ID signing and notarization on macOS (see above), Tauri updater signatures, and the native Linux package format. Windows has no Authenticode certificate yet. Without Authenticode, Windows may show a SmartScreen warning even though updater verification remains cryptographically signed.

## Remote server self-update (Docker)

A server that runs the Web UI for browsers, or for the desktop app's custom backend URL, has no Tauri updater. When it runs in Docker with the updater sidecar, Settings › Version & Updates shows the same **Upgrade** button for it; any other server still reports "managed by your administrator". The button replaces the container with the newer **image**; nothing is built on the server.

```
Settings ─POST /api/updates/install─▶ web ──request file──▶ updater sidecar ──▶ docker compose pull / up -d web
   ▲                                    ◀──── status file ───┘
   └──── polls until the new version answers, then reloads ────┘
```

### Publishing the image

`.github/workflows/docker-image.yml` builds the repository `Dockerfile` for `linux/amd64` and pushes `ghcr.io/cheneyveron/pi-agent-desktop:<version>` and `:latest` with the workflow's `GITHUB_TOKEN`. The signed release workflow calls it as its last job, after `manifest` has published the Release, so a draft never gets an image and a failed image build does not un-publish the release. Run it by hand (Actions › Publish server image, input `0.7.5`) to publish or republish an existing version.

The package is **public**: this repository is a fork of a public one, which GitHub does not let you make private, and the image holds only this repository's source (configuration and secrets come from mounted volumes and environment). Publishing needs nothing extra, because `GITHUB_TOKEN` can write packages of this repository, and pulling needs no credentials. If the package is ever made private, pulls need a classic PAT with only `read:packages`; see the commented lines in the reference compose file.

### Deploying

[deploy/docker/compose.yaml](../deploy/docker/compose.yaml) is the reference project: the `web` service, plus an `updater` sidecar running [deploy/docker/updater.sh](../deploy/docker/updater.sh) in `docker:cli`. Put these beside it in the project directory:

```
.env          PI_AGENT_TAG=0.7.4   PROJECT_DIR=<absolute path of this directory>   DOCKER_GID=<stat -c %g /var/run/docker.sock>
updater.sh
state/updater/   (writable by the web user)
```

`PI_WEB_UPDATER_DIR` on the web service is what turns the button on. If the web service has an `env_file`, mount that file into the updater at the same path, because `docker compose up` runs inside the sidecar and reads it there. A failed `up`, or a running container that is not the requested tag, counts as a failed update and is rolled back.

### What happens on Upgrade

1. The server finds the newest stable Release (never a version or URL from the request), waits up to 10 minutes until no session is running, and writes `request` (`id=`, `version=x.y.z`) into the shared directory.
2. The sidecar validates both values, runs `docker compose pull web` with that tag, writes the tag to `PI_AGENT_TAG` in `.env` (so a later manual `docker compose up` keeps it) and recreates only `web`. The sidecar itself is not touched.
3. It waits up to 3 minutes for the container's healthcheck. If it does not turn healthy, the previous tag is restored and `status` says `failed`; the page shows that message. A failed pull changes nothing.
4. The page keeps polling `GET /api/updates/install` while the server is down and reloads when the restarted server reports a new version.

`status` lines: `id`, `phase` (`pulling`, `restarting`, `done`, `failed`), `version`, `error`.

### Security

- The web container never gets the Docker socket. Only the sidecar has it; it runs one fixed script, has no network and no published port, runs as the web user with the docker group added, and accepts nothing but a validated `x.y.z` tag from the shared directory.
- Anyone who can reach the server's update endpoint can trigger an update to the newest stable release. Keep the web password or an access proxy in front of a remote server.
- Images are pulled from the fixed `ghcr.io/cheneyveron/pi-agent-desktop` repository named in the compose file, not from the request. The sidecar holds no registry credential while the package is public; if you add one, keep it `read:packages` only.
- Rollback is the previous image tag, which stays on the host; keep `PI_AGENT_TAG` concrete, never `latest`.
