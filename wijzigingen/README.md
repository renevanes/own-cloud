# Wijzigingen die nog gepubliceerd moeten worden

Elk `.txt`-bestand hier beschrijft één wijziging in regels voor de gebruiker (Nederlands, zonder technische termen).
Maak ze met `scripts/wijziging.sh "regel" ...`. Bij publiceren (`scripts/publish.sh`) of bij het samenvoegen van een
pull request (CI) worden alle bestanden hier samen de volgende versie in `changelog.json`, en verdwijnen ze.

Pas `VERSION` en `changelog.json` nooit zelf aan: zo kunnen meerdere agents en mensen tegelijk werken zonder botsingen.
Zie [AGENTS.md](../AGENTS.md).
