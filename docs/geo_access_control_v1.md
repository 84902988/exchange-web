# Geo Access Control V1

Geo Access Control V1 provides regional access control with this priority:

1. Read Cloudflare `CF-IPCountry` when trusted.
2. Fallback to a local MaxMind-compatible `.mmdb` country database.
3. Return `UNKNOWN` when the country cannot be identified.

The backend middleware runs before auth/business routers and can block API and backend-rendered web/admin pages. Static assets, health checks, favicon, localhost, and private network IPs are allowed by default.

## Default State

Delivery defaults are conservative:

- `GEO_ACCESS_ENABLED=false`
- `GEO_ACCESS_MONITOR_MODE=true`
- `GEOIP_DB_PATH=`
- `GEO_ACCESS_TRUST_CF_HEADER=true`
- Database settings have priority over env defaults after migration.

No strong blocking is enabled by default. Operations must enable it from `/admin/geo-access`.

## Cloudflare Mode

When traffic is behind Cloudflare, enable Cloudflare IP geolocation so requests include:

- `CF-IPCountry`: country or region code.
- `CF-Connecting-IP`: real client IP.

The backend resolves IP in this order:

1. `CF-Connecting-IP`
2. first IP in `X-Forwarded-For`
3. `X-Real-IP`
4. `request.client.host`

The country code is resolved in this order:

1. `CF-IPCountry`
2. local GeoIP database
3. `UNKNOWN`

## Local IP Database Mode

V1 supports MaxMind GeoLite2 Country or a compatible operational `.mmdb` file.

The `.mmdb` file is not committed to Git and is not part of code delivery. Operations is responsible for downloading, licensing, refreshing, and deploying the IP database.

Example backend env:

```env
GEOIP_DB_PATH=/opt/exchange-web/data/GeoLite2-Country.mmdb
```

If `GEOIP_DB_PATH` is empty, missing, unreadable, or the reader package is unavailable, the backend returns `UNKNOWN` instead of HTTP 500.

## Admin Configuration

Open:

```text
/admin/geo-access
```

Available controls:

- Enable or disable Geo Access Control.
- Keep monitor mode on or switch to blocking mode.
- Block or allow `UNKNOWN`.
- Exempt `/admin` or apply the same controls to admin pages.
- Maintain restricted country codes such as `CN, KP, IR`.
- Add, disable, enable, or delete allowlist/blocklist IP/CIDR rules.
- View recent access decision logs.

Allowlist and blocklist accept single IPs or CIDR ranges, for example:

```text
203.0.113.10
203.0.113.0/24
2001:db8::/32
```

## Decision Order

For non-static traffic:

1. Disabled config: allow and log `DISABLED`.
2. Localhost/private IP: allow.
3. `/admin` exemption when enabled: allow.
4. Allowlist IP/CIDR: allow.
5. Blocklist IP/CIDR: block or monitor.
6. Restricted country: block or monitor.
7. `UNKNOWN`: block or allow according to config.
8. Otherwise: allow.

When monitor mode is enabled, requests that would be blocked are allowed but logged with decision `MONITOR`.

## Logs

`geo_access_logs` records:

- `ip_address`
- `country_code`
- `source`: `CF_HEADER`, `LOCAL_DB`, or `UNKNOWN`
- `path`
- `method`
- `user_agent`
- `decision`: `ALLOW`, `BLOCK`, or `MONITOR`
- `reason`
- `created_at`

Use `/admin/geo-access` to inspect recent logs.

## Monitor To Block Runbook

1. Apply Alembic migrations.
2. Deploy with `GEO_ACCESS_ENABLED=false` or leave the database setting disabled.
3. Confirm the admin page loads at `/admin/geo-access`.
4. Add restricted country codes and any allowlist CIDR ranges.
5. Turn on `enabled` while keeping `monitor_mode=true`.
6. Review `MONITOR` logs for expected countries, paths, and IPs.
7. Add allowlist entries for operational IPs if needed.
8. Decide whether `UNKNOWN` should be blocked.
9. Turn off `monitor_mode` to start blocking.
10. Continue reviewing logs after switching to block mode.

## Responsibility Boundary

Operations/legal is responsible for:

- IP database source, license, deployment, and refresh cadence.
- Restricted country and region lists.
- Legal and compliance decisions.
- Cloudflare configuration and trusted proxy boundaries.

The code only provides the enforcement, configuration, fallback, and logging mechanism.
