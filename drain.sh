#!/usr/bin/env bash
#
# Drain the extraction backlog on the deployed Worker.
#
# /admin/extract processes at most EXTRACT_BATCH (25) records per invocation, so
# a backfill needs many calls. This loops until nothing is pending, then writes
# the final /admin/stats payload to drain-final-stats.json.
#
# Usage:
#   export ADMIN_TOKEN=...
#   ./drain.sh [worker-url]
#
# Tunables (env): SLEEP_SECONDS, MAX_ITERATIONS, STALL_LIMIT

set -uo pipefail

WORKER="${1:-https://pet-recall-ingest.workdigitalmedia.workers.dev}"
SLEEP_SECONDS="${SLEEP_SECONDS:-2}"
MAX_ITERATIONS="${MAX_ITERATIONS:-200}"
STALL_LIMIT="${STALL_LIMIT:-3}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATS_FILE="$HERE/drain-final-stats.json"

if [[ -z "${ADMIN_TOKEN:-}" ]]; then
  echo "ADMIN_TOKEN is not set. Run:  export ADMIN_TOKEN=<your token>" >&2
  exit 1
fi

AUTH=(-H "Authorization: Bearer $ADMIN_TOKEN")
# A batch of 25 sequential LLM calls is slow but bounded; do not wait forever.
CURL=(curl -sS --max-time 300 "${AUTH[@]}")

# Pending is the count still awaiting a first extraction. Records whose
# extraction failed park at version 0 and drop out of this count, so watch the
# 'failed' total in the final stats as well.
pending_count() {
  "${CURL[@]}" "$WORKER/admin/stats" \
    | python3 -c 'import json,sys
try:
    print(int(json.load(sys.stdin)["totals"]["pending"]))
except Exception:
    print(-1)'
}

pending="$(pending_count)"
if [[ "$pending" -lt 0 ]]; then
  echo "could not read /admin/stats — check the URL and ADMIN_TOKEN" >&2
  exit 1
fi

echo "starting: $pending pending"

iteration=0
stalls=0

while [[ "$pending" -gt 0 ]]; do
  iteration=$((iteration + 1))
  if [[ "$iteration" -gt "$MAX_ITERATIONS" ]]; then
    echo "stopping: hit MAX_ITERATIONS ($MAX_ITERATIONS)" >&2
    break
  fi

  response="$("${CURL[@]}" "$WORKER/admin/extract?limit=25")"
  if [[ -z "$response" ]]; then
    echo "stopping: empty response from /admin/extract" >&2
    break
  fi

  # Surface the first couple of errors so a systemic failure is visible early
  # rather than only showing up as a stalled pending count.
  extracted="$(printf '%s' "$response" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("?"); sys.exit()
print(d.get("extracted", 0))
for e in (d.get("errors") or [])[:2]:
    print("    error:", str(e)[:200], file=sys.stderr)')"

  sleep "$SLEEP_SECONDS"

  previous="$pending"
  pending="$(pending_count)"
  if [[ "$pending" -lt 0 ]]; then
    echo "stopping: /admin/stats became unreadable" >&2
    pending="$previous"
    break
  fi

  printf 'iteration %d: extracted %s, %s pending\n' "$iteration" "$extracted" "$pending"

  # Guard against burning LLM spend on a backlog that is not actually shrinking.
  if [[ "$pending" -ge "$previous" ]]; then
    stalls=$((stalls + 1))
    if [[ "$stalls" -ge "$STALL_LIMIT" ]]; then
      echo "stopping: pending has not decreased in $STALL_LIMIT iterations" >&2
      break
    fi
  else
    stalls=0
  fi
done

echo
echo "final /admin/stats:"
"${CURL[@]}" "$WORKER/admin/stats" | tee "$STATS_FILE"
echo
echo "(saved to $STATS_FILE)"
