#!/usr/bin/env sh
set -eu

fail() {
  printf '%s\n' "docker-entrypoint: $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "the bootstrap must start as root so it can stage the private config and then drop privileges"
[ "$#" -gt 0 ] || fail "no application command was provided"

source_path=${CONFIG_SOURCE_PATH:-/config/config.json}
runtime_dir=/tmp/3d-livestream
runtime_path=$runtime_dir/config.json
data_dir=${DATA_DIR:-/data}
temporary_path=$runtime_dir/.config.json.$$

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
elif [ -z "${PRINTER_HOST:-}" ] || [ -z "${PRINTER_USERNAME:-}" ] || [ -z "${PRINTER_PASSWORD:-}" ]; then
  fail "no configuration file exists at $source_path and the required PRINTER_* variables are incomplete"
fi

[ -d "$data_dir" ] || fail "the runtime data directory does not exist: $data_dir"
chown bun:bun "$data_dir"
gosu bun:bun test -w "$data_dir" || fail "the runtime data directory is not writable by the bun user: $data_dir"

trap - EXIT HUP INT TERM
exec gosu bun:bun /usr/bin/tini -- "$@"
