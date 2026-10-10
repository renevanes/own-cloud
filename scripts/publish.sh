#!/usr/bin/env bash
# Publiceert de huidige versie: controleert, test, maakt één commit "Versie X.Y" en pusht naar main.
# GitHub Actions bouwt daarna de app en de servers, zet de release v<X.Y> op GitHub (met de APK)
# en publiceert de update; telefoons en servers halen hem vanzelf op.
#   scripts/publish.sh               (SKIP_TESTS=1 alleen als je weet waarom)
set -euo pipefail
cd "$(dirname "$0")/.."
source VERSION
TOP=$(python3 -c "import json;print(json.load(open('changelog.json',encoding='utf-8'))[0]['version'])")
[ "$TOP" = "$VERSION_NAME" ] || { echo "Het wijzigingslog begint bij $TOP, maar VERSION zegt $VERSION_NAME. Gebruik scripts/bump.sh."; exit 1; }

# Werkten er meerdere sessies tegelijk? Dan eerst kijken of niemand anders intussen publiceerde.
git fetch -q origin main
if ! git merge-base --is-ancestor FETCH_HEAD HEAD; then
  echo "Er staat intussen iets nieuwers op GitHub. Haal dat eerst op (git pull --rebase) en verhoog daarna opnieuw de versie."; exit 1
fi
REMOTE_CODE=$( (git show FETCH_HEAD:VERSION 2>/dev/null || true) | sed -n "s/^VERSION_CODE=//p")
if [ -n "$REMOTE_CODE" ] && [ "$VERSION_CODE" -le "$REMOTE_CODE" ]; then
  echo "Versie $VERSION_NAME (code $VERSION_CODE) is niet hoger dan die op GitHub (code $REMOTE_CODE). Draai eerst scripts/bump.sh."; exit 1
fi
if [ "${SKIP_TESTS:-}" != "1" ]; then
  npm run -s typecheck
  npm test > /tmp/eigen-publish-test.log 2>&1 || { grep -E "^not ok|# fail|Error" /tmp/eigen-publish-test.log | head -30; echo "Tests mislukt: niet gepubliceerd"; exit 1; }
  [ -x android/compile-check.sh ] && { android/compile-check.sh > /tmp/eigen-publish-android.log 2>&1 || { tail -30 /tmp/eigen-publish-android.log; echo "Android compileert niet: niet gepubliceerd"; exit 1; }; }
fi
SESSION_LINE=""
[ -n "${CLAUDE_SESSION_URL:-}" ] && SESSION_LINE="
Claude-Session: $CLAUDE_SESSION_URL"
git add -A
git diff --cached --quiet && [ "$(git rev-parse HEAD)" = "$(git rev-parse FETCH_HEAD)" ] && { echo "Niets nieuws om te publiceren"; exit 1; }
if ! git diff --cached --quiet; then
  git -c user.name="Rene van Es" -c user.email=rene.van.es@esape.nl commit -q -F - <<MSG
Versie $VERSION_NAME

$(python3 -c "import json;print('\n'.join('- '+c for c in json.load(open('changelog.json',encoding='utf-8'))[0]['changes']))")

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>$SESSION_LINE
MSG
fi
git push origin HEAD:main
echo "Gepubliceerd: versie $VERSION_NAME. GitHub bouwt nu de app en de servers (release v$VERSION_NAME)."
