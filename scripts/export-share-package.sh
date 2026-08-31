#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-$HOME/Downloads/agent-native-remote-share.tar.gz}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/agent-native-remote"
metadata_args=()
if tar --version 2>/dev/null | head -n 1 | grep -qi 'bsdtar'; then
  metadata_args=(--no-xattrs --no-mac-metadata)
fi
COPYFILE_DISABLE=1 tar \
  "${metadata_args[@]}" \
  --exclude='.env' \
  --exclude='.DS_Store' \
  --exclude='HANDOFF*.md' \
  --exclude='recover-agent-remote-mcp-via-browser.mjs' \
  --exclude='logs' \
  --exclude='target' \
  --exclude='*.log' \
  -C "$SKILL_DIR" -cf - . \
  | COPYFILE_DISABLE=1 tar "${metadata_args[@]}" -C "$TMP_DIR/agent-native-remote" -xf -

while IFS= read -r link; do
  target="$(readlink "$link")"
  if [[ "$target" == /* || "$target" == .. || "$target" == ../* || "$target" == */../* ]]; then
    echo "refusing to export an escaping symbolic link: $link" >&2
    exit 1
  fi
done < <(find "$TMP_DIR/agent-native-remote" -type l -print)
if find "$TMP_DIR/agent-native-remote" -type f \
    \( -name '.env' -o -name 'HANDOFF*.md' -o -name '*.log' -o -name '*known_hosts*' -o -name '*_ed25519' \) \
    -print -quit | grep -q .; then
  echo "refusing to export private runtime state" >&2
  exit 1
fi

"$SKILL_DIR/scripts/audit-share-package.mjs" \
  "$TMP_DIR/agent-native-remote" "$SKILL_DIR/.env"

PREBUILT="$TMP_DIR/agent-native-remote/assets/codex-remote-mcp-server/prebuilt"
(cd "$PREBUILT" && shasum -a 256 -c SHA256SUMS)

mkdir -p "$(dirname "$OUTPUT")"
archive_tmp="$OUTPUT.$$.tmp"
if tar --version 2>/dev/null | head -n 1 | grep -qi 'bsdtar'; then
  owner_args=(--uid 0 --gid 0 --uname root --gname root)
else
  owner_args=(--owner=0 --group=0 --numeric-owner)
fi
COPYFILE_DISABLE=1 tar \
  "${metadata_args[@]}" \
  "${owner_args[@]}" \
  -C "$TMP_DIR" -czf "$archive_tmp" agent-native-remote
if command -v xattr >/dev/null 2>&1; then
  xattr -c "$archive_tmp"
fi
mv -f "$archive_tmp" "$OUTPUT"
if command -v xattr >/dev/null 2>&1; then
  xattr -c "$OUTPUT"
fi

printf 'package: %s\n' "$OUTPUT"
printf 'sha256: '
shasum -a 256 "$OUTPUT" | awk '{print $1}'
printf 'bytes: '
wc -c < "$OUTPUT" | tr -d ' '
