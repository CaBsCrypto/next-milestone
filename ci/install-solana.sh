#!/usr/bin/env bash
set -euo pipefail

tools_dir="${1:-$HOME/.local/share/next-milestone-tools}"
anchor_version=1.2.2
agave_version=4.1.2

mkdir -p "$tools_dir/bin"
curl -fsSL --retry 3 \
  "https://github.com/anza-xyz/agave/releases/download/v$agave_version/solana-release-x86_64-unknown-linux-gnu.tar.bz2" \
  | tar -xj -C "$tools_dir"
curl -fsSL --retry 3 \
  "https://github.com/otter-sec/anchor/releases/download/v$anchor_version/anchor-$anchor_version-x86_64-unknown-linux-gnu" \
  -o "$tools_dir/bin/anchor"
chmod +x "$tools_dir/bin/anchor"

if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "$tools_dir/bin" "$tools_dir/solana-release/bin" >> "$GITHUB_PATH"
fi

"$tools_dir/bin/anchor" --version
"$tools_dir/solana-release/bin/solana" --version
