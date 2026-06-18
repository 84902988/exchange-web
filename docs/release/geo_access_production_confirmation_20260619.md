# Geo Access Production Confirmation - 2026-06-19

This confirmation note records the production Geo Access decision. The code provides the access-control capability; operations owns the country/region list, enablement strategy, legal/compliance judgment, and GeoIP database licensing/update process.

## 1. Production Decision

Final production restricted country/region list:

```text
restricted_countries=["CN"]
```

Operational decisions:

- `CN` is the only confirmed production restricted country/region.
- `US` was a test item only and must not enter the production restricted list.
- `block_unknown=false`.
- `admin_exempt=true`.
- `trust CF-IPCountry=true`.
- Whether production actually blocks traffic is still controlled by `enabled` and `monitor_mode`.

Recommended production rollout:

```text
enabled=false
```

or:

```text
enabled=true
monitor_mode=true
```

Only switch to formal blocking after operations confirms:

```text
enabled=true
monitor_mode=false
restricted_countries=["CN"]
```

## 2. Current Local DB State

The local DB was previously observed during testing with:

```text
restricted_countries=["CN", "US"]
```

That state was for testing and release-readiness diagnosis. It is not the production restriction list.

Current local DB confirmation:

```text
enabled=true
monitor_mode=false
block_unknown=false
admin_exempt=true
restricted_countries=["CN"]
```

No other Geo Access fields should be changed when syncing the local DB to the production-confirmed country list.

## 3. Required Operations Confirmation

Operations must confirm before production launch:

- Whether to enable Geo Access.
- Whether to run formal blocking or monitor mode.
- Final restricted country/region list: `["CN"]`.
- `US` is not included in the production restricted list.
- `block_unknown=false`.
- `admin_exempt=true`.
- Cloudflare `CF-IPCountry` is trusted.
- Cloudflare forwards `CF-Connecting-IP` and `CF-IPCountry` correctly.
- GeoIP DB deployment path, for example `GEOIP_DB_PATH=/opt/exchange-web/data/GeoLite2-Country.mmdb`.
- GeoLite2 / MaxMind license, download, deployment, update owner, and update cadence.
- Regional restriction page copy is approved by operations/compliance.

## 4. Safety Defaults

Until operations signs off, production should use one of these safe states:

```text
enabled=false
```

or:

```text
enabled=true
monitor_mode=true
```

Do not default to:

- Blocking `US`.
- Blocking `UNKNOWN`.
- Formal blocking before operations approval.

## 5. Responsibility Boundary

Code owns:

- Cloudflare header-first country recognition.
- Local GeoIP DB fallback.
- Admin configuration UI.
- Frontend page-layer restriction.
- Backend API fallback restriction.
- Hit logging and summary display.

Operations owns:

- Whether Geo Access is enabled.
- Whether monitor mode is switched to formal blocking.
- Final country/region list: `["CN"]`.
- Whether `UNKNOWN` should be blocked.
- Cloudflare trust boundary.
- GeoIP DB licensing, deployment, updates, and file path.
- Regional restriction compliance judgment.

## 6. Sign-off

Suggested sign-off roles:

- Operations owner:
- Compliance owner:
- Engineering owner:
- Infrastructure owner:

Launch decision:

```text
[ ] Keep disabled: enabled=false
[ ] Enable monitor only: enabled=true + monitor_mode=true
[ ] Enable formal blocking: enabled=true + monitor_mode=false + restricted_countries=["CN"]
```

Final production values:

```text
restricted_countries=["CN"]
block_unknown=false
admin_exempt=true
trust CF-IPCountry=true
GEOIP_DB_PATH=
```
