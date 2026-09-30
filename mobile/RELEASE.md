# iOS release and source handoff

Build releases from the agreed authoritative source branch. Record its commit,
the branding profile revision, toolchain versions, app version/build, and output
SHA-256 with each delivery. A source export has no Git history; keep its
`SOURCE_MANIFEST.json` with the source handoff.

## Source and external branding

Start with a fresh checkout of the authoritative branch and inspect local changes
before updating an existing checkout. Use the reviewed revision for Windows,
macOS, and server handoffs. Do not replace that revision with an older build
machine checkout or merge unrelated local changes during a release.

From the repository root, create a new export directory **outside every Git
checkout** and apply the externally maintained branding profile:

```sh
python3 scripts/export_public_source.py --target "$EXPORT_DIR"
python3 scripts/apply_branding.py --profile "$BRAND_PROFILE" --target "$EXPORT_DIR"
```

`EXPORT_DIR` must not already exist. Python and Pillow are required for branding
and icon generation. The branding profile and its referenced logo/media files
are separate inputs; retain them in operator-controlled storage before deleting
local working copies. The exporter excludes local environment files, Git
history, runtime data, signing files, build outputs, and `docs/`. This document
remains available because it is under `mobile/`.

Apply branding to the export, then verify and build that same source. Machine
paths, credentials, and private signing material belong outside the repository.

## Dependencies and verification

Use a Node version compatible with `mobile/package.json`, plus Xcode, Ruby,
Bundler, and the operator's existing Apple signing setup on the Mac.

```sh
cd "$EXPORT_DIR/web"
npm ci
cd "$EXPORT_DIR/mobile"
npm ci
npm run verify
bundle install
cd ios
bundle exec pod install
cd ..
```

The mobile parity tests import web valuation source, so the full source export
and web dependencies are required for this verification. Do not remove those
tests to make a mobile-only snapshot pass. Retain the validated
`package-lock.json` files, `mobile/Gemfile.lock`, and `mobile/ios/Podfile.lock` in
the source handoff; review changes to dependency locks before release.

**Run `bundle exec pod install` in the actual Mac checkout after dependency
installation or relocation.** Copied `Pods`, `node_modules`, an old workspace,
or DerivedData do not replace this step. React Native's post-install updates
build settings, React VFS overlays, module/header paths, and aggregate xcconfigs
for the current location. With the current prebuilt React Native configuration,
it also sets `SWIFT_ENABLE_EXPLICIT_MODULES=NO` and configures
`RCT_REMOVE_LEGACY_ARCH=1`. Regenerate these through the Podfile post-install;
do not repair stale paths by copying generated projects from another checkout.

Open `ios/ExchangeMobile.xcworkspace` after pod installation. Check the local
Node path used by Xcode; recreate machine-specific `.xcode.env.local` settings
when moving to another Mac or directory. Keep that file untracked.

## Release inputs and signing

Supply these inputs explicitly for each release. The names in the left column
are Xcode build settings consumed by the project.

| Build setting | Meaning |
| --- | --- |
| `MOBILE_RELEASE_API_BASE_URL` | Operator's public HTTPS API endpoint; no credentials, query, or fragment |
| `MOBILE_RELEASE_CHART_WEB_BASE_URL` | Operator's public HTTPS chart origin; no path, credentials, query, or fragment |
| `MOBILE_IOS_BUNDLE_IDENTIFIER` | Existing registered bundle identifier for the operator's app |
| `MARKETING_VERSION` | Intended app version |
| `CURRENT_PROJECT_VERSION` | New build number; inspect existing uploaded builds before choosing it |

Do not rely on Debug defaults or merely export shell variables that never reach
Xcode's build settings. The Release validation phase checks resolved values,
and the compiled app's `Info.plist` must be checked again after archiving.

In the isolated source's **ExchangeMobile app target, Release configuration**,
select the operator's team, Apple Distribution identity, and matching App Store
provisioning profile. Confirm the bundle identifier, certificate/profile
validity, and that the signing key is available on that Mac. Use app-target
settings or an app-target-only configuration workflow for manual signing.

Do not pass a provisioning profile or manual signing settings globally to a
workspace build: command-line overrides also affect Pods targets and can make
them request an app provisioning profile. Preserve the CocoaPods-generated
signing settings for dependency targets.

Remote builds may need the Mac's logged-in desktop session to access the login
keychain or complete a signing-key access prompt. Unlock/authorize it through
the Mac UI when needed; keep passwords and private keys out of command lines,
logs, source exports, and delivery archives.

## Hermes and artifact privacy

Release JavaScript must be bundled into the app and must run without Metro. Use
the Hermes compiler installed by the current Pods setup. For delivery builds,
point `HERMES_CLI_PATH` at a local wrapper that forwards the arguments to that
compiler and appends `-g0`:

```sh
#!/bin/sh
set -eu
exec "${PODS_ROOT:?}/../../node_modules/hermes-compiler/hermesc/osx-bin/hermesc" "$@" -g0
```

Keep the executable wrapper in a private build-tools location, make it
executable, and supply its absolute path as `HERMES_CLI_PATH`. Do not copy a
wrapper containing another machine's paths. Leave `SOURCEMAP_FILE` unset or
empty; do not include Metro/Hermes source maps in the delivered IPA. Recreate
local wrapper/Node settings on each build machine rather than committing those
absolute paths.

## Archive and export

After configuring signing on the app target, either use Xcode's Product >
Archive with the Release scheme and a generic iOS device, or run this command
from the exported `mobile` directory:

```sh
xcodebuild -workspace ios/ExchangeMobile.xcworkspace \
  -scheme ExchangeMobile -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE_PATH" \
  MOBILE_RELEASE_API_BASE_URL="$PUBLIC_API_URL" \
  MOBILE_RELEASE_CHART_WEB_BASE_URL="$PUBLIC_CHART_ORIGIN" \
  MOBILE_IOS_BUNDLE_IDENTIFIER="$IOS_BUNDLE_ID" \
  MARKETING_VERSION="$APP_VERSION" \
  CURRENT_PROJECT_VERSION="$APP_BUILD" \
  HERMES_CLI_PATH="$HERMES_WRAPPER" SOURCEMAP_FILE= archive
```

These shell variables are local release inputs, not values to commit. Keep
`ARCHIVE_PATH` and exported products outside source directories. Use fresh
DerivedData when relocating a checkout or diagnosing stale generated paths;
do not discard a known-good archive before the replacement is accepted.

In Organizer, validate the archive and choose an App Store Connect export using
the existing operator account. Exporting the IPA and uploading it are separate
actions. For command-line export, keep the resolved ExportOptions plist outside
Git and use `method=app-store-connect`, `destination=export`, the correct signing
style/team, and the app's bundle-to-profile mapping when signing manually:

```sh
xcodebuild -exportArchive -archivePath "$ARCHIVE_PATH" \
  -exportPath "$IPA_DIR" -exportOptionsPlist "$EXPORT_OPTIONS_PATH"
```

An App Store distribution IPA is intended for Apple distribution. To let testers
install it, separately upload the validated build to App Store Connect, wait for
processing, complete the required TestFlight information, and select the
intended testing group. TestFlight distribution and App Store submission/release
are separate decisions; creating an archive or exporting an IPA does not
authorize either of them.

## Delivery and retirement

Before handing over the IPA, inspect the packaged app rather than only the
build inputs: public API/chart URLs, bundle identifier, display name, version,
build number, icons, privacy manifest, and a valid signature/profile with
`get-task-allow=false`. Check the compiled bundle/resources for private machine
paths, development endpoints, old tunnel addresses, embedded credentials, and
source maps. Signing metadata and public endpoint URLs are visible in an IPA;
they must identify the intended operator setup.

Keep raw build logs, dSYMs, source maps, signing material, and account information
in private operator-controlled storage. Deliver the IPA with its SHA-256 and a
concise record of the reviewed source and release inputs, without private paths
or credentials.

Accept the new build on a real iPhone before retiring the old one: confirm
installation/upgrade, startup without Metro, the intended server connection,
market/chart loading, account screens, and absence of startup crashes. Use the
agreed test account/data for any writes. After acceptance, expire superseded
TestFlight builds or retire old downloads as authorized; retain a known-good
rollback artifact and the source/branding/lockfile inputs needed to reproduce it.
Removing an old build does not require revoking a shared signing certificate.
