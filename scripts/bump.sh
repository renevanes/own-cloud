#!/usr/bin/env bash
# Nieuwe versie: nummer omhoog en een regel in het wijzigingslog (dat ziet de gebruiker in de app).
#   scripts/bump.sh "Wijziging 1" "Wijziging 2" ...
#   MAJOR=1 scripts/bump.sh ...   → 1.9 wordt 2.0
# Schrijf de regels voor de gebruiker: wat kan hij nu, wat is er beter. Geen technische termen.
set -euo pipefail
cd "$(dirname "$0")/.."
source VERSION
[ $# -gt 0 ] || { echo "Geef minstens één regel voor het wijzigingslog"; exit 1; }
MAJ=${VERSION_NAME%%.*}; MIN=${VERSION_NAME#*.}
if [ "${MAJOR:-0}" = 1 ]; then MAJ=$((MAJ+1)); MIN=0; else MIN=$((MIN+1)); fi
NEWNAME="$MAJ.$MIN"; NEWCODE=$((VERSION_CODE+1))
sed -i "s/^VERSION_NAME=.*/VERSION_NAME=$NEWNAME/; s/^VERSION_CODE=.*/VERSION_CODE=$NEWCODE/" VERSION
python3 - "$NEWNAME" "$@" <<'PY'
import sys, json, datetime, zoneinfo
name, changes = sys.argv[1], sys.argv[2:]
log = json.load(open('changelog.json', encoding='utf-8'))
today = datetime.datetime.now(zoneinfo.ZoneInfo('Europe/Amsterdam')).date().isoformat()
log.insert(0, {"version": name, "date": today, "changes": changes})
json.dump(log, open('changelog.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
open('changelog.json', 'a').write('\n')
PY
echo "Nieuwe versie: $NEWNAME (code $NEWCODE)"
