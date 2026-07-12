# HarmonyOS Sans fonts

No font binary is currently bundled in the mobile project. The shared typography
configuration therefore keeps HarmonyOS Sans SC as the preferred family while
using the native Android/iOS system font as a safe runtime fallback.

Place the official HarmonyOS Sans SC font files in this directory after downloading them from Huawei's official design resource page:

https://developer.huawei.com/consumer/cn/design/resource-V1/

Suggested filenames:

- `HarmonyOS_Sans_SC_Regular.ttf`
- `HarmonyOS_Sans_SC_Medium.ttf`
- `HarmonyOS_Sans_SC_Bold.ttf`

Use the actual filenames from the official download package if they differ, then update `mobile/src/theme/typography.ts` if needed.

After legally sourced files are added, run the React Native asset-linking step for
both platforms and switch `bundledHarmonyAssetsAvailable` to `true` only after the
Android assets and iOS `UIAppFonts` entries have been verified.
