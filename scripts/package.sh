#!/usr/bin/env bash
#
# Builds the installable plugin ZIP and verifies its layout.
#
# Super Productivity's extractor indexes archive entries by flat filename, so
# the four files below must sit at the archive root — nested under a directory,
# the plugin silently fails to load. This is the single source of truth for
# which files ship; the release workflow and the PR test build both call it.
set -euo pipefail

cd "$(dirname "$0")/.."

ARCHIVE='slack-status-sync.zip'
FILES=(manifest.json plugin.js index.html icon.svg)

for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "error: ${f} is missing from the repo root" >&2; exit 1; }
done

rm -f "$ARCHIVE"
# -j flattens any path component, -X drops platform extras for a stabler archive.
zip -j -X -q "$ARCHIVE" "${FILES[@]}"

entries="$(unzip -Z1 "$ARCHIVE")"

if printf '%s\n' "$entries" | grep -q '/'; then
  echo "error: ${ARCHIVE} contains nested paths; entries must sit at the root" >&2
  printf '%s\n' "$entries" >&2
  exit 1
fi

for f in "${FILES[@]}"; do
  printf '%s\n' "$entries" | grep -qx "$f" || {
    echo "error: ${ARCHIVE} is missing ${f}" >&2
    exit 1
  }
done

# SP rejects plugin archives above ~1 MB.
size_kb=$(( $(wc -c < "$ARCHIVE") / 1024 ))
if [ "$size_kb" -gt 1024 ]; then
  echo "error: ${ARCHIVE} is ${size_kb} KB, over Super Productivity's ~1 MB limit" >&2
  exit 1
fi

echo "Built ${ARCHIVE} (${size_kb} KB), ${#FILES[@]} entries at archive root:"
unzip -l "$ARCHIVE"
