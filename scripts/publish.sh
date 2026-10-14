#!/usr/bin/env bash
# Publiceert je werk als nieuwe versie: test, kiest het volgende versienummer, maakt één commit "Versie X.Y" en pusht
# naar main. GitHub Actions bouwt daarna de app en de servers en zet release vX.Y (met de APK) op GitHub.
#
# Veilig als meerdere agents (Claude, Codex, …) en mensen tegelijk werken:
#   - je beschrijft je wijziging vooraf met scripts/wijziging.sh (een eigen bestand in wijzigingen/);
#   - het versienummer wordt pas hier gekozen, vlak voor het pushen, op basis van wat er dán op main staat;
#   - publiceerde iemand anders intussen, dan zet dit script je werk bovenop het zijne en probeert het opnieuw
#     met het volgende nummer. Alleen bij een echt conflict in dezelfde regels stopt het (en verandert niets).
#
#   scripts/wijziging.sh "Wat de gebruiker merkt" && scripts/publish.sh
#
# Omgeving (allemaal optioneel):
#   SKIP_TESTS=1          tests overslaan (alleen als je weet waarom; de CI test altijd)
#   DRY_RUN=1             alles doen behalve pushen, en daarna je werk terugzetten zoals het was
#   PUBLISH_AUTHOR        auteur van de commit, standaard "Rene van Es <rene.van.es@esape.nl>"
#   PUBLISH_CO_AUTHOR     extra Co-Authored-By, bijv. "Codex <codex@openai.com>"
#   PUBLISH_TRAILERS      extra regels onderaan het commitbericht (bijv. een sessielink)
#   CLAUDE_SESSION_URL    voegt de Claude-regels toe (Co-Authored-By + Claude-Session)
#   PUBLISH_REMOTE / PUBLISH_BRANCH   standaard origin / main
set -euo pipefail
cd "$(dirname "$0")/.."
REMOTE=${PUBLISH_REMOTE:-origin}
BRANCH=${PUBLISH_BRANCH:-main}
AUTHOR=${PUBLISH_AUTHOR:-"Rene van Es <rene.van.es@esape.nl>"}
AUTHOR_NAME=${AUTHOR% <*}
AUTHOR_MAIL=${AUTHOR##*<}; AUTHOR_MAIL=${AUTHOR_MAIL%>}
gitc() { git -c user.name="$AUTHOR_NAME" -c user.email="$AUTHOR_MAIL" "$@"; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] || [ -f .git/MERGE_HEAD ]; then
  echo "Er loopt nog een rebase of merge. Rond die eerst af."; exit 1
fi

# 1. Openstaand werk vastleggen (wordt straks samengevoegd tot één versiecommit).
CREATED=0
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  gitc commit -q -m "Werk (nog niet gepubliceerd)"
  CREATED=1
fi
START=$(git rev-parse HEAD)
# Bij stoppen: alles terug zoals het was (ook je niet-vastgelegde wijzigingen weer als gewone wijzigingen).
restore() { git reset -q --hard "$START"; [ "$CREATED" = 1 ] && git reset -q --soft HEAD~1 && git reset -q; return 0; }

TRAILERS=""
[ -n "${PUBLISH_CO_AUTHOR:-}" ] && TRAILERS+="Co-Authored-By: $PUBLISH_CO_AUTHOR"$'\n'
if [ -n "${CLAUDE_SESSION_URL:-}" ]; then
  TRAILERS+="Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"$'\n'"Claude-Session: $CLAUDE_SESSION_URL"$'\n'
fi
[ -n "${PUBLISH_TRAILERS:-}" ] && TRAILERS+="$PUBLISH_TRAILERS"$'\n'

TESTED=0
for ATTEMPT in 1 2 3 4 5 6; do
  # 2. Bijwerken met wat er nu op main staat.
  git fetch -q "$REMOTE" "$BRANCH"
  BASE=$(git rev-parse FETCH_HEAD)
  if ! git merge-base --is-ancestor "$BASE" HEAD; then
    if ! git -c user.name="$AUTHOR_NAME" -c user.email="$AUTHOR_MAIL" rebase -q "$BASE" >"$TMP/rebase.log" 2>&1; then
      git rebase --abort >/dev/null 2>&1 || true
      restore
      cat "$TMP/rebase.log" | grep -E "CONFLICT|conflict" | head -20 || true
      echo "Je werk botst met wat er intussen op $BRANCH staat (zie hierboven). Er is niets veranderd."
      echo "Los het op met: git pull --rebase $REMOTE $BRANCH   en draai daarna opnieuw scripts/publish.sh"
      exit 1
    fi
  fi
  WORK=$(git rev-parse HEAD)
  if [ "$WORK" = "$BASE" ]; then restore; echo "Niets nieuws om te publiceren."; exit 1; fi

  # 3. Testen (één keer, op de bijgewerkte stand).
  if [ "$TESTED" = 0 ] && [ "${SKIP_TESTS:-}" != "1" ]; then
    npm run -s typecheck
    npm test > "$TMP/test.log" 2>&1 || { grep -E "^not ok|# fail|Error" "$TMP/test.log" | head -30; restore; echo "Tests mislukt: niet gepubliceerd (je werk staat er nog)."; exit 1; }
    if [ -x android/compile-check.sh ]; then
      android/compile-check.sh > "$TMP/android.log" 2>&1 || { tail -30 "$TMP/android.log"; restore; echo "Android compileert niet: niet gepubliceerd."; exit 1; }
    fi
    TESTED=1
  fi

  # 4. Versie kiezen ten opzichte van main en alles samenvoegen tot één commit.
  git show "$BASE:VERSION" > "$TMP/VERSION.base"
  git show "$BASE:changelog.json" > "$TMP/changelog.base.json"
  set +e
  RES=$(python3 scripts/release.py apply --base-version "$TMP/VERSION.base" --base-changelog "$TMP/changelog.base.json" --message-file "$TMP/msg")
  RC=$?
  set -e
  if [ $RC -ne 0 ]; then restore; echo "Beschrijf eerst je wijziging: scripts/wijziging.sh \"wat de gebruiker merkt\""; exit 1; fi
  NAME=${RES% *}
  [ -n "$TRAILERS" ] && printf '\n%s' "$TRAILERS" >> "$TMP/msg"
  git reset -q --soft "$BASE"
  git add -A
  gitc commit -q -F "$TMP/msg"

  if [ "${DRY_RUN:-}" = "1" ]; then
    echo "Proef: zou versie $NAME publiceren:"; git show --stat --format='%s%n%n%b' HEAD | head -40
    restore; echo "(Proef: niets gepusht, je werk staat terug zoals het was.)"; exit 0
  fi

  # 5. Pushen. Lukt het niet omdat iemand anders net publiceerde, dan opnieuw met het volgende nummer.
  if git push -q "$REMOTE" "HEAD:$BRANCH" 2>"$TMP/push.log"; then
    echo "Gepubliceerd: versie $NAME. GitHub bouwt nu de app en de servers (release v$NAME)."
    exit 0
  fi
  if ! grep -qE "rejected|non-fast-forward|fetch first|stale info" "$TMP/push.log"; then
    cat "$TMP/push.log"; restore; echo "Pushen mislukte (zie hierboven). Er is niets gepubliceerd; je werk staat er nog."; exit 1
  fi
  echo "Iemand anders publiceerde net (poging $ATTEMPT). Ik zet je werk erbovenop en kies het volgende nummer…"
  git reset -q --hard "$WORK"
  sleep $((ATTEMPT * 2))
done
echo "Na 6 pogingen lukte publiceren niet; er wordt nu druk gepubliceerd. Probeer het zo opnieuw."
exit 1
