# GeoLite2 Country database

The application has a system-level policy that blocks public and API requests identified as mainland China (`CN`). The database file itself is intentionally not committed to this repository.

Each user or deployer must:

1. create its own MaxMind account and obtain the required license or redistribution authorization;
2. install the official `geoipupdate` utility on the deployment host;
3. store the account ID and license key in root-owned `/etc/GeoIP.conf` with mode `0600`;
4. enable the supplied `exchange-geoip-update.timer`; and
5. keep the database current and remove outdated copies as required by the applicable license.

Minimal `/etc/GeoIP.conf` structure:

```text
AccountID <account-id>
LicenseKey <license-key>
EditionIDs GeoLite2-Country
```

Never place a real account ID, license key, `GeoIP.conf`, or `.mmdb` file in Git. The updater validates a newly downloaded database and atomically installs it at:

```text
/opt/exchange-web/data/geoip/GeoLite2-Country.mmdb
```

The backend detects the file modification time and reloads the reader without an API restart. Configure `GEOIP_DB_PATH` to the path above when the deployment does not use that path by default.

This product includes GeoLite2 data created by MaxMind, available from [https://www.maxmind.com](https://www.maxmind.com).
