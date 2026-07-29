#!/usr/bin/env bash
set -Eeuo pipefail

readonly CONFIG_PATH="${GEOIPUPDATE_CONFIG:-/etc/GeoIP.conf}"
readonly TARGET_DIR="${GEOIP_TARGET_DIR:-/opt/exchange-web/data/geoip}"
readonly TARGET_FILE="${TARGET_DIR}/GeoLite2-Country.mmdb"
readonly TARGET_OWNER="${GEOIP_TARGET_OWNER:-exchange}"
readonly TARGET_GROUP="${GEOIP_TARGET_GROUP:-exchange}"

if [[ -n "${GEOIP_PYTHON_BIN:-}" ]]; then
  PYTHON_BIN="${GEOIP_PYTHON_BIN}"
elif [[ -x /opt/exchange-web/.venv/bin/python ]]; then
  PYTHON_BIN=/opt/exchange-web/.venv/bin/python
else
  PYTHON_BIN=/opt/exchange-web/backend/.venv/bin/python
fi
readonly PYTHON_BIN

command -v geoipupdate >/dev/null 2>&1 || {
  echo "geoipupdate is not installed" >&2
  exit 1
}
command -v flock >/dev/null 2>&1 || {
  echo "flock is not installed" >&2
  exit 1
}
[[ -r "${CONFIG_PATH}" ]] || {
  echo "GeoIP update config is not readable: ${CONFIG_PATH}" >&2
  exit 1
}
[[ -x "${PYTHON_BIN}" ]] || {
  echo "Python runtime is not executable: ${PYTHON_BIN}" >&2
  exit 1
}

install -d -o "${TARGET_OWNER}" -g "${TARGET_GROUP}" -m 0750 "${TARGET_DIR}"
exec 9>"${TARGET_DIR}/.geoip-update.lock"
flock -n 9 || {
  echo "another GeoIP update is already running"
  exit 0
}

download_dir="$(mktemp -d)"
staged_file=""
cleanup() {
  rm -rf -- "${download_dir}"
  if [[ -n "${staged_file}" && -e "${staged_file}" ]]; then
    rm -f -- "${staged_file}"
  fi
}
trap cleanup EXIT

geoipupdate -f "${CONFIG_PATH}" -d "${download_dir}"
candidate="${download_dir}/GeoLite2-Country.mmdb"
[[ -s "${candidate}" ]] || {
  echo "GeoLite2-Country.mmdb was not downloaded" >&2
  exit 1
}

"${PYTHON_BIN}" - "${candidate}" <<'PY'
import sys

import maxminddb

path = sys.argv[1]
with maxminddb.open_database(path) as reader:
    database_type = str(reader.metadata().database_type or "")
if database_type != "GeoLite2-Country":
    raise SystemExit(f"unexpected database type: {database_type!r}")
PY

staged_file="$(mktemp -p "${TARGET_DIR}" .GeoLite2-Country.mmdb.XXXXXX)"
install -o "${TARGET_OWNER}" -g "${TARGET_GROUP}" -m 0640 "${candidate}" "${staged_file}"
mv -f -- "${staged_file}" "${TARGET_FILE}"
staged_file=""
echo "GeoLite2-Country database updated successfully"
