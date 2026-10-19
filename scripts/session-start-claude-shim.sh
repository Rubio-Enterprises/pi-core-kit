#!/usr/bin/env bash
# scripts/session-start-claude-shim.sh — FROZEN consumer entry point for the
# Claude Code SessionStart hook, registered in .claude/settings.json
# (matcher "startup|resume") — rubio-standards shim/common/repo-local layout.
#
# It is deliberately logic-free and should never need to change again:
#   - ALL hook logic lives in scripts/common/session-start-claude.sh —
#     TEMPLATE-OWNED, normally rendered, so every change propagates
#     automatically via the weekly copier-sync PR. Do not edit files under
#     scripts/common/ (consumer edits there are template drift).
#   - Repo-specific startup belongs in scripts/repo-local/session-start-claude.sh
#     — REPO-OWNED, committed (cloud only runs committed hooks), never rendered
#     by the template; the common core runs it (abort-proof) after the
#     toolchain warmup.
# This shim is `_skip_if_exists` (consumer-owned once rendered) precisely so
# the registered hook path stays stable while the core evolves underneath.
#
# Contract (rubio-standards §6.1, checked BY CONTENT on whichever file is
# wired in .claude/settings.json — here, this shim): abort-proof (no
# `set -e`, so an install hiccup downstream can never hard-fail the
# session), ends `exit 0`, and resolves its own root from BASH_SOURCE/$0
# (clause 4) rather than trusting CLAUDE_PROJECT_DIR. Clause 3 (persist PATH
# for later Bash tool calls via $CLAUDE_ENV_FILE) is satisfied BY
# DELEGATION: on the success path below this process `exec`s into
# scripts/common/session-start-claude.sh, which appends the mise bin/shims
# dirs to $CLAUDE_ENV_FILE before it exits — see that file's own header for
# the full contract.
set -uo pipefail
src="${BASH_SOURCE[0]:-$0}"
unset CDPATH
repo_root="$(cd -- "$(dirname -- "$src")/.." 2>/dev/null && pwd)"
if [ -n "$repo_root" ] && [ -f "$repo_root/scripts/common/session-start-claude.sh" ]; then
  exec bash "$repo_root/scripts/common/session-start-claude.sh"
fi
echo "session-start-claude-shim: scripts/common/session-start-claude.sh not found on this branch; skipping toolchain bootstrap" >&2
exit 0
