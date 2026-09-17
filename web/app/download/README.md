# Public app download page

`/download` uses the site's root layout, shared Header/Footer, and LocaleProvider.
Page copy lives under `common.downloadPage*` in the four existing locale files.
There is no separate language selector or login requirement.

Set deployment-specific public release information in `web/config/appDownload.json`
before building: app name, Android APK URL, version, byte size, minimum Android
version, download-page QR image, and optional home/chart screenshots. Keep real
operator values and branded assets in the deployment overlay; repository defaults
are intentionally empty. An empty APK URL shows an unavailable state.

The reverse proxy must forward `/download` to Next.js through the normal website
location. Remove any previous exact `/download` static HTML alias after deploying
the route. APK/image static asset locations can remain in place. QR codes should
point to the public download page so future APK versions need no new QR code.
