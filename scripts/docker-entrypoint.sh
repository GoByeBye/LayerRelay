#!/usr/bin/env sh
set -eu

fail() {
  printf '%s\n' "docker-entrypoint: $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "the bootstrap must start as root so it can stage the private config and then drop privileges"
[ "$#" -gt 0 ] || fail "no application command was provided"

source_path=${CONFIG_SOURCE_PATH:-/config/config.json}
runtime_dir=/tmp/layer-relay
runtime_path=$runtime_dir/config.json
data_dir=${DATA_DIR:-/data}
temporary_path=$runtime_dir/.config.json.$$

export DATA_DIR=$data_dir
export LISTEN_HOST=${LISTEN_HOST:-${LAYER_RELAY_LISTEN_HOST:-0.0.0.0}}
export PORT=${PORT:-${LAYER_RELAY_PORT:-8787}}
export SOURCE_CODE_URL=${SOURCE_CODE_URL:-${LAYER_RELAY_SOURCE_CODE_URL:-${LAYER_RELAY_IMAGE_SOURCE_CODE_URL:-https://github.com/GoByeBye/LayerRelay}}}

trap 'rm -f -- "$temporary_path"' EXIT
trap 'exit 1' HUP INT TERM

export CONFIG_PATH=$runtime_path

if [ -f "$source_path" ]; then
  install -d -o root -g bun -m 0750 "$runtime_dir"
  if ! install -o root -g bun -m 0440 "$source_path" "$temporary_path"; then
    fail "could not read the configured source file at $source_path"
  fi
  mv -f -- "$temporary_path" "$runtime_path"
  gosu bun:bun test -r "$runtime_path" || fail "the staged configuration is not readable by the bun user"
else
  [ -n "${PRINTER_HOST:-${LAYER_RELAY_PRINTER_HOST:-}}" ] ||
    fail "no configuration file exists at $source_path and PRINTER_HOST is missing"
  case "${PRINTER_TYPE:-${LAYER_RELAY_PRINTER_TYPE:-prusa}}" in
    prusa)
      [ -n "${PRINTER_USERNAME:-${LAYER_RELAY_PRINTER_USERNAME:-}}" ] &&
        [ -n "${PRINTER_PASSWORD:-${LAYER_RELAY_PRINTER_PASSWORD:-}}" ] ||
        fail "Prusa environment-only startup requires PRINTER_USERNAME and PRINTER_PASSWORD"
      ;;
    bambu)
      [ -n "${BAMBU_SERIAL:-${LAYER_RELAY_BAMBU_SERIAL:-}}" ] &&
        [ -n "${BAMBU_ACCESS_CODE:-${LAYER_RELAY_BAMBU_ACCESS_CODE:-}}" ] ||
        fail "Bambu environment-only startup requires BAMBU_SERIAL and BAMBU_ACCESS_CODE"
      ;;
    *) fail "PRINTER_TYPE must be prusa or bambu" ;;
  esac
fi

[ -d "$data_dir" ] || fail "the runtime data directory does not exist: $data_dir"
chown bun:bun "$data_dir"
gosu bun:bun test -w "$data_dir" || fail "the runtime data directory is not writable by the bun user: $data_dir"

trap - EXIT HUP INT TERM
exec gosu bun:bun /usr/bin/tini -- "$@"
