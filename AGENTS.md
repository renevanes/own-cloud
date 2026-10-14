# Eigen Cloud — afspraken voor agents en mensen

Dit bestand is voor iedereen die hier code wijzigt: Claude, OpenAI Codex, andere agents en mensen. Meerdere werken
**tegelijk** aan deze repository en publiceren elk zelf; de afspraken hieronder zorgen dat dat niet botst.
(Claude leest dit via CLAUDE.md, Codex leest AGENTS.md rechtstreeks.)

## Wat dit is

Eigen Cloud: mail, agenda en foto's in eigen beheer (vervanger van Gmail/Google Agenda/Google Foto's), verspreid over
Europese aanbieders. Onderdelen: de cloud zelf (`src/`, Node 22 + TypeScript + Fastify, SQLite met replicatie), de
beheerconsole (`src/console` + `web-console/`), de Eigen Cloud Dienst voor aanbieders (`src/broker` + `web-dienst/`),
de gratis-adressendienst (`src/adressen`) en de Android-app (`android/app`, Java zonder externe libraries; de
Java-kern `android/core` doet in de app hetzelfde als de console in TypeScript). Achtergrond: README.md, ROLLEN.md,
BROKER.md, PROVIDERS.md, TRUST.md, CLUSTER.md.

## Zo werk je naast anderen

1. **Begin bij de laatste stand.** `git fetch origin && git rebase origin/main` (of een verse clone). Kijk in
   `git log origin/main` en de open pull requests wat anderen net deden; draai hun werk niet terug.
2. **Werk klein en afgerond.** Eén onderwerp per publicatie. Groot werk dat niet in één keer af komt: zet het op een
   eigen branch `wip/<onderwerp>` (push mag altijd) en open eventueel een draft pull request, zodat anderen zien waar
   je mee bezig bent. Nooit onaf werk op `main`.
3. **Beschrijf je wijziging, kies géén versienummer.** Pas `VERSION` en `changelog.json` nooit zelf aan. Gebruik
   `scripts/wijziging.sh "wat de gebruiker nu kan of wat beter is"` (één of meer regels). Dat maakt een eigen bestand in
   `wijzigingen/`, dus twee agents botsen er nooit op. Regels zijn voor Rene: Nederlands, gewone taal, geen technische
   termen. `MAJOR=1` ervoor = hoofdversie.
4. **Publiceren** (als je mag pushen naar `main`): `scripts/publish.sh`. Dat
   - zet je werk bovenop de nieuwste `main` (botst iets echt, dan stopt het zonder iets te veranderen),
   - test (typecheck, `npm test`, Android-check),
   - kiest **dan pas** het volgende versienummer, maakt één commit "Versie X.Y" en pusht,
   - en probeert het vanzelf opnieuw met het volgende nummer als een ander net eerder publiceerde.
   Attributie: `PUBLISH_CO_AUTHOR="Codex <codex@openai.com>"` (of je eigen naam) en eventueel `PUBLISH_TRAILERS`.
   Proefdraaien zonder pushen: `DRY_RUN=1 scripts/publish.sh`.
5. **Of via een pull request** (geen pushrechten, of je wilt review): branch + `scripts/wijziging.sh` + pull request.
   Na samenvoegen kent de CI zelf het versienummer toe (job "versie") en bouwt en publiceert hij de nieuwe versie.
6. **Na publiceren** bouwt GitHub Actions de APK en de server-images en zet release `vX.Y` (met `Eigen-Cloud-vX.Y.apk`).
   Telefoons en servers werken zichzelf bij. Eén pijplijn tegelijk (`concurrency: release-publication`); snel
   achter elkaar publiceren kan, de laatste versie bevat altijd alles.

Wat je niet doet: force-pushen naar `main`, tags of releases met de hand maken of verwijderen, andermans branches
verwijderen, `VERSION`/`changelog.json` met de hand wijzigen, ondertekensleutels of secrets in de repository zetten.

## Kwaliteitsregels

- **Teksten** voor gebruikers: Nederlands, gewone taal, zinnen met een hoofdletter alleen aan het begin.
- **Console = app.** Wat je in `src/console` (TypeScript) wijzigt, hoort ook in `android/core` (Java): dezelfde
  routes en exact dezelfde JSON, want beide gebruiken `web-console/console.js`. Gedeelde formaten staan in de
  golden-tests (`scripts/golden.ts` ↔ `FormatsGoldenTest.java`).
- **Rollende updates.** Servers met verschillende versies draaien tegelijk: nieuwe instellingen moeten oude servers
  kunnen negeren, nieuwe tabellen volgen de migratieregels (RELEASE-1.17.md).
- **Externe API's** (aanbieders, Mollie, deSEC, …): volg de officiële documentatie en test tegen een nagebootste API
  in `test/helpers/`. Nooit tegen echte accounts in tests.
- **Geheimen** nooit in code, logs of commits.

## Testen

```
npm ci
npm run typecheck && npm test        # Node
npm run test:browser                 # Playwright (Chromium)
android/core/test.sh                 # Java-kern tegen de echte TypeScript-code (Java 17, moto[server])
android/compile-check.sh             # app tegen android.jar; zonder Android SDK wordt hij overgeslagen (CI bouwt echt)
```

## Omgevingsnotities

- Sandboxes zonder Android SDK of met beperkte netwerktoegang: de CI (GitHub Actions) bouwt en lint de app altijd;
  vertrouw daarop voor wat lokaal niet kan, en zeg het in je verslag.
- De app wordt in de testfase ondertekend met een openbare testsleutel zolang de vier ondertekensecrets ontbreken
  (android/signing/README.md).
