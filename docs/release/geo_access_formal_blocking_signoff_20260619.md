# Geo Access Formal Blocking Sign-off - 2026-06-19

Production formal blocking has been confirmed by the project owner in this release flow.

Final Geo Access production values:

```text
enabled=true
monitor_mode=false
restricted_countries=["CN"]
block_unknown=false
admin_exempt=true
trust CF-IPCountry=true
```

Production restriction scope:

- Restricted country/region list: CN only.
- `US` was a test item only and does not enter the production restricted list.
- `UNKNOWN` is not blocked: `block_unknown=false`.
- Admin path exemption remains enabled: `admin_exempt=true`.
- Cloudflare `CF-IPCountry` is trusted.

Production deployment still needs infrastructure confirmation:

- Cloudflare is attached to the production domain.
- `CF-IPCountry` and `CF-Connecting-IP` are forwarded to origin correctly.
- `GEOIP_DB_PATH` is deployed and readable by the backend service.
- GeoLite2 / MaxMind licensing, download, deployment, update owner, and update cadence are confirmed.

Responsibility boundary:

- Code provides Geo Access capability, frontend page-layer blocking, backend API fallback blocking, local GeoIP fallback, admin configuration, and logging.
- Operations and compliance own the country/region restriction policy, GeoIP licensing and update process, and Cloudflare header trust boundary.
