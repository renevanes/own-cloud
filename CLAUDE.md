# Eigen Cloud — afspraken voor wie hier werkt

- **Elke wijziging is een nieuwe versie.** Na het werk: `scripts/bump.sh "regel voor de gebruiker" ...` en dan
  `scripts/publish.sh` (draait de tests, maakt één commit "Versie X.Y" en pusht naar main). Nooit zonder ophogen
  pushen: de CI weigert een versie die al bestaat.
- De regels in het wijzigingslog zijn voor Rene: Nederlands, zonder technische termen, wat hij nu kan of wat beter is.
- App en servers delen het nummer in `VERSION`. GitHub Actions bouwt de APK, zet release `vX.Y` met
  `Eigen-Cloud-vX.Y.apk` en publiceert de update (ghcr.io en de server-images). Stuur Rene daarna de APK van die release.
- Tests: `npm run typecheck`, `npm test`, `android/compile-check.sh`, `android/core/test.sh` (moto nodig).
- Gebruik nooit `pkill -f` in deze omgeving.
