# Meedoen aan Eigen Cloud

Eigen Cloud is open source. Aanbieders, gebruikers en ontwikkelaars verbeteren het samen. Iedereen draait zijn eigen
cloud of zijn eigen Eigen Cloud Dienst; dit project levert de software, de app, de lijst van aanbieders en de gedeelde
adressendienst (zie ROLLEN.md).

## Een wijziging voorstellen

1. Maak een fork van `renevanes/own-cloud` en een branch voor je wijziging.
2. Werk zoals in CLAUDE.md staat: tests erbij, `npm run typecheck`, `npm test`, `android/compile-check.sh` en,
   als je de Java-kern raakt, `android/core/test.sh`.
3. Raakt je wijziging de beheerconsole (`src/console`), dan hoort dezelfde wijziging in de Java-kern van de app
   (`android/core`): beide gebruiken dezelfde schermen.
4. Teksten voor gebruikers zijn Nederlands, gewone taal, zonder technische termen.
5. Open een pull request. Verhoog **niet** zelf de versie: de beheerders van de repository doen dat bij het samenvoegen
   (`scripts/bump.sh`, `scripts/publish.sh`), zodat elke versie één nummer en één regel in het wijzigingslog krijgt.

De beheerders van de repository beoordelen elk voorstel. Wat zij samenvoegen, komt in de volgende versie bij iedereen:
de app werkt zichzelf bij en clouds en diensten volgen met de rollende updates.

## Op de lijst van aanbieders

Draai je een Eigen Cloud Dienst, dan kun je in de app op de lijst komen:

1. Open in het beheer van je dienst **Op de lijst**. Daar staat je regel voor `aanbieders.json`, met de sleutel van je dienst.
2. Voeg die regel toe aan `aanbieders.json` via GitHub (*Propose changes*).
3. De beheerders kijken of de dienst bereikbaar is, of je contactgegevens, voorwaarden en privacyverklaring kloppen,
   en voegen het voorstel samen.

Velden: `naam`, `url` (het https-adres van je dienst), `land`, `contact`, `omschrijving`, `sleutel` (publieke
Ed25519-sleutel van je dienst, voor de gedeelde adressendienst).

## Een cloudaanbieder toevoegen

Aanbieders (servers, opslag, DNS) zijn adapters in `src/cluster/adapters/`, met één lijst in
`src/cluster/adapters.ts`. Een nieuwe aanbieder is één bestand plus tests tegen een nagebootste API; de console en
`catalog.json` volgen vanzelf. Het stappenplan staat in [PROVIDERS.md](PROVIDERS.md#een-aanbieder-toevoegen).

Werkt een adapter ook bij de echte aanbieder? Met een eigen account controleer je dat met `npm run live-check`
(alleen lezen: inloggen, servers en zones bekijken, rechten waar de API ze laat zien, en de formaten en prijzen per
regio). Zet daarvoor de sleutels in omgevingsvariabelen, bijvoorbeeld `HCLOUD_TOKEN=… DOMAIN=jouwdomein.nl npm run
live-check -- hetzner`; de lijst staat in [PROVIDERS.md](PROVIDERS.md#testen-met-een-echt-account). Vermeld de
uitkomst (zonder sleutels) in je pull request.

## Fouten melden

Open een issue op GitHub met wat je deed, wat je verwachtte en wat er gebeurde. Zet nooit sleutels, wachtwoorden of
inhoud van mail en foto's in een issue.
