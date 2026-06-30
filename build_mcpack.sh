#!/usr/bin/env bash
set -e
# Usage: ./build_mcpack.sh
# Produces dist/CheatersAddon.mcpack and dist/cheaters_companion.zip
ROOT="$(cd "$(dirname "$0")" && pwd)"
BP="$ROOT/behavior_packs/CheatersBP"
RP="$ROOT/resource_packs/CheatersRP"
OUT="$ROOT/dist"
MCNAME="CheatersAddon.mcpack"
COMPANION_ZIP="$OUT/cheaters_companion.zip"

rm -rf "$OUT"
mkdir -p "$OUT"

tmpdir=$(mktemp -d)
cp -r "$BP" "$tmpdir/behavior_packs/"
cp -r "$RP" "$tmpdir/resource_packs/"
( cd "$tmpdir" && zip -r "$OUT/$MCNAME" . )
echo "Built $OUT/$MCNAME"

( cd "$ROOT/companion" && zip -r "$COMPANION_ZIP" . )
echo "Built companion zip: $COMPANION_ZIP"

rm -rf "$tmpdir"
echo "Done. Import $OUT/$MCNAME into Bedrock and unzip $COMPANION_ZIP to run the companion server."
