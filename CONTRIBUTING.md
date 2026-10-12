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

Draai je een Eigen Cloud Dienst (opgezet in de app met **Aanbieder worden**), dan zet je jezelf zo op de lijst:

1. Open in de app je Dienst (**Beheer openen**) en kies **Op de lijst**. Vul land en omschrijving aan; naam en contact
   komen uit je huisstijl, de sleutel van je Dienst staat er al in.
2. Tik **Hele lijst kopiëren** (de huidige lijst met jouw regel erin, of bijgewerkt) en **aanbieders.json openen op
   GitHub**. Kies het potlood, selecteer alles, plak, en kies *Propose changes*. Je hebt alleen een gratis GitHub-account
   nodig; installeren hoeft niet.
3. De beheerders kijken of de dienst bereikbaar is, of je contactgegevens, voorwaarden en privacyverklaring kloppen,
   en voegen het voorstel samen. De app leest de lijst rechtstreeks van GitHub: zonder nieuwe versie sta je erin.

Velden: `naam`, `url` (het https-adres van je dienst), `land`, `contact`, `omschrijving`, `sleutel` (publieke
Ed25519-sleutel van je dienst, voor de gedeelde adressendienst). Daarnaast twee velden die **alleen de beheerders** zetten:

| Veld | Wat |
|---|---|
| `standaard` | `true` op **hooguit één** regel: die aanbieder biedt de app nieuwe gebruikers als eerste aan ("Wij regelen alles"). Staan er meer, dan telt alleen de eerste. |
| `adressen` | Op de standaardregel: het https-adres van de gratis-adressendienst (zie [ADRESSEN.md](ADRESSEN.md)). Elke Dienst die met zijn eigen sleutel op de lijst staat, gebruikt die dan vanzelf. |

De app (en de console) kijkt bij elke aanbieder of hij antwoordt (`GET /v1/info`, 4 seconden; onthouden: een uur als hij
antwoordt, 2 minuten als niet). Een aanbieder die niet antwoordt, staat er als *Nog niet beschikbaar* bij, is niet te
kiezen en wordt nooit vanzelf gekozen; gebruikers kunnen het dan zelf regelen. Zodra hij antwoordt, wordt de
standaardaanbieder vanzelf weer de eerste keuze. Het bestand `DIENST_URL` (of `EIGEN_DIENST_URL`) blijft werken als vaste
standaard voor een eigen bouw van de app en gaat dan voor.

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
