#!/usr/bin/env bash
# Concatenate the source parts into a single self-contained index.html
set -e
cd "$(dirname "$0")"
cat src/part1.html src/engine.js src/part2.html > index.html
echo "Built index.html ($(wc -c < index.html) bytes)"
