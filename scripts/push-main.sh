#!/bin/bash
# push-main.sh — pull latest, then push to main. Version is bumped by GitHub Actions.
#
# Usage:
#   ./scripts/push-main.sh
#
# Flow: pull --rebase from origin/main, then push. The "Bump version on push to main"
# workflow runs on every push to main and commits a version bump (so you don't run
# bump-version.sh locally). Version only ever goes up on main.

set -euo pipefail

BRANCH=$(git branch --show-current 2>/dev/null || echo "")
if [ "$BRANCH" != "main" ]; then
  echo "Not on main. Current branch: $BRANCH" >&2
  exit 1
fi

git pull --rebase origin main
git push origin main
echo "Pushed. Version will be bumped by GitHub Actions."
