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

## Publishing

Start **Publish signed desktop release** manually after the release changes reach `main`. It verifies that the bundled `pi` and `pi-web` versions match their latest stable Releases or the documented versions in `scripts/release-component-pins.json`, then sequentially creates Apple Silicon (`aarch64`) DMG/updater artifacts, a Linux x64 `.deb`, and a Windows x64 NSIS `-setup.exe`/updater archive. Intel Mac (`x86_64-apple-darwin`) artifacts are not built. The Release stays in draft until all platforms and the component manifest are present; only then is `v<pi-agent-desktop version>` published as the latest Release.

The workflow currently uses ad-hoc macOS application signing, Tauri updater signatures, and the native Linux package format. Before distributing outside a controlled environment, configure an Apple Developer ID certificate/notarization and a Windows Authenticode certificate. Without Authenticode, Windows may show a SmartScreen warning even though updater verification remains cryptographically signed.
