#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$SKILL_DIR/assets/codex-remote-mcp-server/codex-rs"
OUTPUT_DIR="$SKILL_DIR/assets/codex-remote-mcp-server/prebuilt/x86_64-unknown-linux-gnu"
TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/agent-native-remote/cargo-target}"
TARGET="x86_64-unknown-linux-gnu.2.17"

if command -v rustup >/dev/null 2>&1; then
  RUSTUP_CARGO="$(rustup which cargo)"
  export PATH="$HOME/.cargo/bin:$(dirname "$RUSTUP_CARGO"):$PATH"
  rustup target list --installed | grep -Fqx x86_64-unknown-linux-gnu || {
    echo "Rust target x86_64-unknown-linux-gnu is required; install it with: rustup target add x86_64-unknown-linux-gnu" >&2
    exit 1
  }
fi

command -v cargo >/dev/null || { echo "cargo is required" >&2; exit 1; }
command -v zig >/dev/null || { echo "zig is required" >&2; exit 1; }
command -v cargo-zigbuild >/dev/null || {
  echo "cargo-zigbuild is required; install it with: cargo install cargo-zigbuild --locked" >&2
  exit 1
}

mkdir -p "$TARGET_DIR" "$OUTPUT_DIR"
REMAP_RUSTFLAGS="--remap-path-prefix=$HOME=/build/home --remap-path-prefix=$SOURCE_DIR=/src/codex-rs --remap-path-prefix=$TARGET_DIR=/build/target"
if [[ -n "${RUSTFLAGS:-}" ]]; then
  REMAP_RUSTFLAGS="$RUSTFLAGS $REMAP_RUSTFLAGS"
fi
CARGO_TARGET_DIR="$TARGET_DIR" \
CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}" \
CARGO_PROFILE_RELEASE_OPT_LEVEL=z \
CARGO_PROFILE_RELEASE_PANIC=abort \
RUSTFLAGS="$REMAP_RUSTFLAGS" \
  cargo zigbuild \
    --manifest-path "$SOURCE_DIR/Cargo.toml" \
    --package codex-remote-mcp-server \
    --bin codex-remote-mcp-server \
    --release \
    --target "$TARGET"

SOURCE_BINARY="$TARGET_DIR/x86_64-unknown-linux-gnu/release/codex-remote-mcp-server"
[[ -x "$SOURCE_BINARY" ]] || { echo "build output not found: $SOURCE_BINARY" >&2; exit 1; }
install -m 700 "$SOURCE_BINARY" "$OUTPUT_DIR/codex-remote-mcp-server"
PACKAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$PACKAGE_DIR"' EXIT
install -m 700 "$SKILL_DIR/assets/codex-remote-mcp-server/install.sh" "$PACKAGE_DIR/install.sh"
install -m 700 "$OUTPUT_DIR/codex-remote-mcp-server" "$PACKAGE_DIR/codex-remote-mcp-server"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$PACKAGE_DIR" -cf - install.sh codex-remote-mcp-server \
  | xz -9e -T0 > "$OUTPUT_DIR/codex-remote-mcp-package.tar.xz"
chmod 600 "$OUTPUT_DIR/codex-remote-mcp-package.tar.xz"
(
  cd "$SKILL_DIR/assets/codex-remote-mcp-server/prebuilt"
  shasum -a 256 \
    x86_64-unknown-linux-gnu/codex-remote-mcp-server \
    x86_64-unknown-linux-gnu/codex-remote-mcp-package.tar.xz \
    > SHA256SUMS
)

file "$OUTPUT_DIR/codex-remote-mcp-server"
cat "$SKILL_DIR/assets/codex-remote-mcp-server/prebuilt/SHA256SUMS"
