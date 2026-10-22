#!/bin/zsh
# ChatHaxx updater (macOS). Merges the latest upstream Chat On Steroids release into main,
# checks it, pushes it to kangster-OG/ChatHaxx, builds the Mac app and installs it once the app
# has been idle for 15 minutes. See CHATHAXX.md.
#
# Exit codes: 0 done or already current, 10 merge conflict (merge left in progress to resolve),
# 2 dirty tree or wrong branch, other non-zero = a step failed (see the named log).
#   --no-install   stop after the build
#   --no-wait      install now instead of waiting for 15 idle minutes
set -euo pipefail

UPSTREAM_REPO=totec448-spec/chat-on-steroids
REPO_DIR=${CHATHAXX_DIR:-$HOME/Developer/chat-on-steroids-fork}
LOGS=${CHATHAXX_LOGS:-$HOME/Developer/CoS-Fork-Control/logs}
BACKUPS=${CHATHAXX_BACKUPS:-$HOME/Developer/CoS-backups}
APP="/Applications/Chat On Steroids.app"
DATA="$HOME/Library/Application Support/chat-on-steroids"
INSTALL=1; WAIT=1
for arg in "$@"; do
  case $arg in
    --no-install) INSTALL=0 ;;
    --no-wait) WAIT=0 ;;
    *) echo "unknown option $arg"; exit 64 ;;
  esac
done
mkdir -p "$LOGS" "$BACKUPS"
cd "$REPO_DIR"
step() { echo "== $*"; }
run() { local name=$1; shift; "$@" > "$LOGS/$name.log" 2>&1 || { echo "FAILED: $name (log $LOGS/$name.log)"; tail -15 "$LOGS/$name.log"; exit 1; }; }

[[ $(git branch --show-current) == main ]] || { echo "not on main"; exit 2; }
[[ -z $(git status --porcelain) ]] || { echo "working tree is not clean"; git status --short | head; exit 2; }

step "fetch"
git fetch --quiet origin
git merge --ff-only --quiet origin/main
tag=$(gh api "repos/$UPSTREAM_REPO/releases/latest" --jq .tag_name)
echo "latest upstream release: $tag"
# Only the release tag: upstream moves its canary tag, which a full tag fetch refuses to clobber.
git fetch --quiet --no-tags upstream "refs/tags/${tag}:refs/tags/${tag}"

if git merge-base --is-ancestor "$tag" HEAD; then
  echo "main already contains $tag"
else
  step "merge $tag"
  if ! git merge --no-edit -m "Merge upstream $tag" "$tag"; then
    echo "CONFLICT merging $tag; resolve, commit, then run this script again:"
    git diff --name-only --diff-filter=U
    exit 10
  fi
  step "check"
  run npm-ci npm ci --no-audit --no-fund
  run typecheck npm run typecheck
  run privacy npm run verify:privacy
  step "push"
  git push --quiet origin main "refs/tags/$tag"
fi

version=$(node -p "require('./package.json').version")
installed=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || echo none)
echo "source $version, installed $installed"
[[ $version == "$installed" ]] && { echo "RESULT: up to date"; exit 0; }

step "build $version"
[[ -d node_modules ]] || run npm-ci npm ci --no-audit --no-fund
run package npm run dist:dir:mac:arm64
# The build regenerates this file from node_modules; keep the committed copy.
git checkout -- THIRD-PARTY-NOTICES.txt
NEW="$REPO_DIR/release/mac-arm64/Chat On Steroids.app"
[[ $(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$NEW/Contents/Info.plist") == "$version" ]] || { echo "built app has the wrong version"; exit 1; }
codesign --verify --deep --strict "$NEW"
(( INSTALL )) || { echo "RESULT: built $version at $NEW (not installed)"; exit 0; }

running() { pgrep -f "Chat On Steroids.app/Contents/MacOS/Chat On Steroids" >/dev/null; }
if (( WAIT )) && running; then
  step "wait for 15 idle minutes"
  deadline=$(( $(date +%s) + 8 * 3600 ))
  while :; do
    t=$(tail -n 3000 "$DATA/app.log" | grep -E 'info   (tool |request POST mcp)' | tail -1 | cut -c1-19)
    ts=$(date -j -u -f '%Y-%m-%dT%H:%M:%S' "$t" +%s 2>/dev/null || echo 0)
    (( $(date +%s) - ts >= 900 )) && break
    (( $(date +%s) > deadline )) && { echo "RESULT: built $version, not installed: the app was never idle"; exit 3; }
    sleep 60
  done
fi

step "install $version"
osascript -e 'quit app "Chat On Steroids"' >/dev/null 2>&1 || true
for i in {1..60}; do running || break; sleep 1; done
running && { echo "RESULT: the app did not quit; nothing changed"; exit 4; }
stamp=$(date +%Y%m%d-%H%M%S)
cp -p "$DATA/config.json" "$BACKUPS/config-$stamp.json"
mkdir -p "$BACKUPS/app-$installed-$stamp"
ditto "$APP" "$BACKUPS/app-$installed-$stamp/Chat On Steroids.app"
# Writing into /Applications directly is blocked by macOS App Management; Finder may replace apps.
osascript -e "tell application \"Finder\" to duplicate (POSIX file \"$NEW\" as alias) to (POSIX file \"/Applications\" as alias) with replacing" >/dev/null
open "$APP"
now=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")
[[ $now == "$version" ]] || { echo "RESULT: install failed (found $now); backup in $BACKUPS/app-$installed-$stamp"; exit 5; }
echo "RESULT: installed $version (previous app in $BACKUPS/app-$installed-$stamp). The browser extension reloads itself once no chat is busy."
