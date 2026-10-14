#!/usr/bin/env bash
# Oude naam, blijft werken: beschrijft je wijziging (zie scripts/wijziging.sh). Het versienummer kiest
# scripts/publish.sh pas bij het publiceren, zodat meerdere agents tegelijk kunnen werken.
#   scripts/bump.sh "Wijziging 1" "Wijziging 2" ...      MAJOR=1 scripts/bump.sh ... → hoofdversie
exec "$(dirname "$0")/wijziging.sh" "$@"
