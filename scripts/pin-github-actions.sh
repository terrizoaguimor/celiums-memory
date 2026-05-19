#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# pin-github-actions.sh — Convert every `uses: <repo>@<tag>` reference
# in .github/workflows/*.yml to `uses: <repo>@<sha>  # <tag>` per
# ADR-018 §"Required hardening — Pinned actions".
#
# Run BEFORE the public-repo flip. After this script, every action
# reference is a commit SHA + a comment noting which release tag the
# SHA pointed to. Dependabot still raises updates as it discovers
# them; the comment lets reviewers see version drift at a glance.
#
# Requires: gh CLI (authenticated) + ratchet (https://github.com/sethvargo/ratchet).
#
# Usage:
#   scripts/pin-github-actions.sh check    # dry-run (CI gate)
#   scripts/pin-github-actions.sh pin      # rewrite workflows in place

set -euo pipefail

MODE="${1:-check}"

if ! command -v ratchet >/dev/null 2>&1; then
  echo "ratchet not installed. brew install ratchet OR see https://github.com/sethvargo/ratchet" >&2
  exit 1
fi

case "$MODE" in
  check)
    ratchet check .github/workflows/*.yml
    ;;
  pin)
    for f in .github/workflows/*.yml; do
      echo "Pinning: $f"
      ratchet pin "$f"
    done
    echo "Done. Review the diff + commit."
    ;;
  unpin)
    # Useful for development — temporarily restore tag references
    # while iterating. NEVER commit unpinned workflows to main.
    for f in .github/workflows/*.yml; do
      ratchet unpin "$f"
    done
    ;;
  *)
    echo "Usage: $0 {check|pin|unpin}" >&2
    exit 2
    ;;
esac
