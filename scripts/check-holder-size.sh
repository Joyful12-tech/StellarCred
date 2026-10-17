#!/usr/bin/env bash
# check-holder-size.sh — Guard against HolderPageClient growing back to a
# monolith (#606). Fails CI if the file exceeds MAX_LINES.
#
# Usage: bash scripts/check-holder-size.sh
#
# MAX_LINES is set at the post-refactor size (~500 lines) plus a small buffer
# so intentional additions (a new section, a new modal) don't immediately break
# CI, but the kind of multi-hundred-line inline feature additions that caused
# the original regression (#606, 1936 lines) won't pass silently.

set -euo pipefail

TARGET="frontend/app/holder/HolderPageClient.tsx"
MAX_LINES=520

if [[ ! -f "$TARGET" ]]; then
  echo "::error::$TARGET not found"
  exit 1
fi

LINES=$(wc -l < "$TARGET")

echo "HolderPageClient.tsx: ${LINES} lines (limit: ${MAX_LINES})"

if [[ "$LINES" -gt "$MAX_LINES" ]]; then
  echo "::error::${TARGET} has ${LINES} lines, which exceeds the ${MAX_LINES}-line limit."
  echo "::error::New holder features belong in frontend/lib/hooks/ and frontend/components/holder/."
  echo "::error::See CONTRIBUTING.md §'Holder page architecture' and issue #606."
  exit 1
fi

echo "OK — within limit."
exit 0
