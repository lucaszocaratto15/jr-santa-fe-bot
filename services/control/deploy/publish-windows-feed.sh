#!/usr/bin/env bash

set -euo pipefail
umask 077

DIST_DIR="${1:?Usage: publish-windows-feed.sh <release-assets-dir> <version>}"
VERSION="${2:?Usage: publish-windows-feed.sh <release-assets-dir> <version>}"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::Expected a stable numeric version."
  exit 1
fi
if [[ ! "${JR_UPDATES_SSH_HOST:-}" =~ ^[A-Za-z0-9.-]+$ ]] || [[ ! "${JR_UPDATES_SSH_USER:-}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "::error::Configure valid JR_UPDATES_SSH_HOST and JR_UPDATES_SSH_USER values."
  exit 1
fi
if [ -z "${JR_UPDATES_SSH_PRIVATE_KEY:-}" ] || [ -z "${JR_UPDATES_SSH_KNOWN_HOSTS:-}" ]; then
  echo "::error::Configure the JR update publisher key and pinned host key."
  exit 1
fi

INSTALLER="JR-Bot-${VERSION}-win-x64.exe"
METADATA="$DIST_DIR/latest.yml"
INSTALLER_PATH="$DIST_DIR/$INSTALLER"
BLOCKMAP_PATH="$INSTALLER_PATH.blockmap"
if ! grep -Fqx "version: $VERSION" "$METADATA" || \
  ! grep -Fqx "path: $INSTALLER" "$METADATA" || \
  ! grep -Fq "url: $INSTALLER" "$METADATA" || \
  [ ! -s "$INSTALLER_PATH" ] || [ ! -s "$BLOCKMAP_PATH" ]; then
  echo "::error::Windows updater metadata, installer, or blockmap is missing or inconsistent."
  exit 1
fi

EXPECTED_SHA512="$(sed -n 's/^sha512:[[:space:]]*//p' "$METADATA" | head -n 1)"
ACTUAL_SHA512="$(openssl dgst -sha512 -binary "$INSTALLER_PATH" | base64 | tr -d '\n')"
if [ -z "$EXPECTED_SHA512" ] || [ "$EXPECTED_SHA512" != "$ACTUAL_SHA512" ]; then
  echo "::error::Installer checksum does not match latest.yml."
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/jr-update-publish.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
KEY_FILE="$WORK_DIR/id_ed25519"
KNOWN_HOSTS_FILE="$WORK_DIR/known_hosts"
BATCH_FILE="$WORK_DIR/publish.sftp"
printf '%s\n' "$JR_UPDATES_SSH_PRIVATE_KEY" > "$KEY_FILE"
printf '%s\n' "$JR_UPDATES_SSH_KNOWN_HOSTS" > "$KNOWN_HOSTS_FILE"
chmod 600 "$KEY_FILE" "$KNOWN_HOSTS_FILE"

if ! ssh-keygen -y -P '' -f "$KEY_FILE" >/dev/null 2>&1 || \
  ! ssh-keygen -F "$JR_UPDATES_SSH_HOST" -f "$KNOWN_HOSTS_FILE" >/dev/null 2>&1; then
  echo "::error::The update publisher key or pinned SSH host entry is invalid."
  exit 1
fi

{
  printf 'put "%s" "/updates/%s"\n' "$INSTALLER_PATH" "$INSTALLER"
  printf 'put "%s" "/updates/%s.blockmap"\n' "$BLOCKMAP_PATH" "$INSTALLER"
  printf 'put "%s" "/updates/.latest.yml.%s.tmp"\n' "$METADATA" "$VERSION"
  printf 'rename "/updates/.latest.yml.%s.tmp" "/updates/latest.yml"\n' "$VERSION"
} > "$BATCH_FILE"

sftp \
  -oBatchMode=yes \
  -oIdentitiesOnly=yes \
  -oStrictHostKeyChecking=yes \
  -oUserKnownHostsFile="$KNOWN_HOSTS_FILE" \
  -i "$KEY_FILE" \
  -b "$BATCH_FILE" \
  "$JR_UPDATES_SSH_USER@$JR_UPDATES_SSH_HOST"

echo "Published JR Bot $VERSION to the Windows update feed."
