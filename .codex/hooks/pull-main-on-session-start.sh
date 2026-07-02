#!/usr/bin/env bash
# SessionStart hook — keep the MAIN checkout's `main` fresh, the SAFE way.
# See AGENTS.md "Parallel development (worktrees)" and the sibling worktree-reminder.sh.
#
# Why this exists: the requested behaviour was "git pull main on every Edit/Write/Read".
# That is harmful — Read is side-effect-free yet would mutate the tree under you, pull
# would clobber/conflict with the in-progress edit, and on a feature branch it pollutes
# the branch. The safe equivalent of "always keep main latest" is: fast-forward `main`
# to origin/main ONCE per session start, and ONLY when it is a zero-risk fast-forward.
#
# Hard guards (any one → skip, always exit 0, never blocks the session):
#   - not inside a git work tree
#   - inside a linked worktree (do feature work there; never sync its branch to main)
#   - not on the default branch `main`
#   - working tree is dirty (a pull could clobber / conflict with uncommitted work)
#   - `origin/main` is not a fast-forward of local `main` (diverged → resolve manually)
#
# Fast-forwarding the source files is safe for the running prod (prod serves a built
# web/dist + a live node process; FF only updates source — prod restarts only on
# `npm run prod:up`). Output goes to stdout, which SessionStart feeds into context, so
# the next turn knows main moved and won't reason against a stale tree.

# Only act inside a git work tree.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Silent inside a linked worktree (its git-dir lives under .../.git/worktrees/<name>).
case "$(git rev-parse --git-dir 2>/dev/null)" in
  */worktrees/*) exit 0 ;;
esac

# Only on the default branch `main` (detached HEAD / feature branches → skip).
[ "$(git branch --show-current 2>/dev/null)" = "main" ] || exit 0

# Skip if the working tree has uncommitted changes — never pull over in-progress work.
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  echo "open-tag main-sync: main checkout has uncommitted changes — skipped auto-pull."
  exit 0
fi

# Fetch origin/main (read-only; does NOT touch the working tree).
if ! git fetch origin main --quiet 2>/dev/null; then
  echo "open-tag main-sync: git fetch failed — left main as-is."
  exit 0
fi

local_rev="$(git rev-parse HEAD 2>/dev/null)"
remote_rev="$(git rev-parse FETCH_HEAD 2>/dev/null)"

# Already up to date → say nothing.
[ "$local_rev" = "$remote_rev" ] && exit 0

# Fast-forward ONLY. If local main has commits not on origin/main (diverged), bail loudly
# rather than create a merge commit or rewrite history.
if git merge-base --is-ancestor "$local_rev" "$remote_rev" 2>/dev/null; then
  if git merge --ff-only FETCH_HEAD --quiet 2>/dev/null; then
    behind="$(git rev-list --count "$local_rev..$remote_rev" 2>/dev/null)"
    echo "open-tag main-sync: fast-forwarded main by ${behind:-?} commit(s) to origin/main ($(git rev-parse --short HEAD))."
  else
    echo "open-tag main-sync: fast-forward of main failed — left as-is."
  fi
else
  echo "open-tag main-sync: local main has diverged from origin/main — NOT auto-pulling (resolve manually)."
fi
exit 0
