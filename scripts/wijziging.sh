#!/usr/bin/env bash
# Beschrijf je wijziging voor het wijzigingslog (dat ziet de gebruiker in de app bij "Wat is er nieuw").
#   scripts/wijziging.sh "Wat de gebruiker nu kan of wat beter is" ["nog een regel" ...]
#   MAJOR=1 scripts/wijziging.sh ...     → de volgende versie wordt een hoofdversie (1.9 → 2.0)
# Maakt een eigen bestand in wijzigingen/ (geen botsingen als meerdere agents tegelijk werken). Het versienummer
# kies je niet zelf: dat doet scripts/publish.sh (of de CI bij het samenvoegen van een pull request).
# Schrijf de regels voor Rene: Nederlands, zonder technische termen.
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -gt 0 ] || { echo "Geef minstens één regel voor het wijzigingslog"; exit 1; }
mkdir -p wijzigingen
WHO=$(printf '%s' "${AGENT_NAME:-${USER:-iemand}}" | tr -c 'a-zA-Z0-9' '-' | cut -c1-20)
F="wijzigingen/$(date -u +%Y%m%d-%H%M%S)-$WHO-$RANDOM.txt"
{ [ "${MAJOR:-0}" = 1 ] && echo "!major"; for line in "$@"; do echo "$line"; done; } > "$F"
echo "Beschreven in $F. Publiceren: scripts/publish.sh"
