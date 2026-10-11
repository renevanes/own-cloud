# Eigen Cloud Dienst

De Eigen Cloud Dienst (in de code: de *broker*, `src/broker/`) is de betaalde variant van Eigen Cloud.
De klant betaalt één bedrag per maand aan jou. Jij regelt daarvan alles wat geld kost:

- de **domeinnaam** (registreren of verhuizen via Openprovider),
- de **DNS** (bij deSEC, onder jouw deSEC-account),
- een **eigen Scaleway-project per klant**, met een sleutel die alleen in dat project werkt. Daarin draaien
  de servers, de opslag (Object Storage) en het versturen van mail (Transactional Email).

De beheerconsole of de app van de klant haalt daarna een **pakket** op met die sleutels en bouwt de cloud zelf.

## Wat de dienst wel en niet doet

**Wel:** inloggen met een code per mail, bundels tonen, domein controleren, betalen via Mollie (eerste
betaling met iDEAL, daarna elke maand automatisch), alles klaarzetten, het pakket bewaren, de DNS-proxy,
een bewaker op het aantal servers, facturen, en alles rond het abonnement dat de klant zelf in de app regelt:
bundel wisselen, betaalmethode wijzigen, een mislukte betaling alsnog betalen, opzeggen en dat weer
terugdraaien, en de verhuiscode van de domeinnaam opvragen.

**Niet:** de dienst bouwt het cluster niet en kan niet in de gegevens van de klant kijken.
De **hoofdsleutel** van de klant (die alle gegevens versleutelt) wordt op het apparaat van de klant
gemaakt en komt nooit bij de dienst. De dienst levert alleen de accounts eromheen.

**Meenemen:** een klant kan altijd vertrekken. De domeinnaam gaat met een verhuiscode (die de klant zelf in de
app opvraagt) naar een andere registrar, de DNS-records zijn gewone records, en de gegevens staan versleuteld in opslag waar de klant
met zijn eigen hoofdsleutel bij kan. Verhuizen naar eigen accounts gaat met de gewone beheerconsole:
nieuwe aanbieders koppelen en de servers laten verhuizen.

## Geldstromen

```
klant ──(Mollie: eerste betaling + maandelijkse SEPA-incasso)──▶ jij
jij ──▶ Scaleway       (servers, opslag, mail van alle klantprojecten: één factuur voor je organisatie)
jij ──▶ Openprovider   (domeinnamen, van je reseller-tegoed)
jij ──▶ deSEC          (gratis; een vrijwillige donatie is netjes)
```

Rekenvoorbeeld voor de bundel "Compleet": 2 kleine servers + 1 witness bij Scaleway ≈ € 12–18,
opslag 100 GB ≈ € 1–2, domein ≈ € 0,60 per maand, mail ≈ € 0. Zet je prijs daar ruim boven: je draagt
het risico op wanbetaling, de btw en je eigen tijd.

## Veiligheid

- **Per klant een eigen Scaleway-project.** De IAM-applicatie van de klant heeft een policy die alléén voor
  dat project geldt (`SCW_PERMISSION_SETS`). Met die sleutel kan de klant (of iemand die de sleutel steelt)
  niets in andere projecten en niets aan je organisatie of facturatie.
- **De hoofdsleutel van de klant komt nooit bij de dienst.** Alles in de opslag is daarmee versleuteld.
- **DNS-proxy.** Het cluster krijgt geen deSEC-token van jouw account. Het krijgt een eigen token dat
  alleen werkt via `https://<dienst>/v1/desec/…` en alleen voor zijn eigen zone (alleen `rrsets`; de zone
  zelf weggooien kan niet). De dienst stuurt het verzoek met zijn eigen deSEC-token door.
- **Certificaten.** Caddy op de servers kan het proxy-adres niet gebruiken (de deSEC-module heeft desec.io
  vast ingebouwd). Daarom spreekt de dienst ook het acme-dns-protocol: `POST /v1/acme-dns/update` met het
  ordernummer en het DNS-token. Dat kan alleen het TXT-record `_acme.<domein>` zetten (de laatste twee
  waarden); `_acme-challenge.cloud` en `_acme-challenge.mail` wijzen daar met een CNAME naartoe.
- **Geheimen versleuteld opgeslagen.** De Scaleway-sleutel, het DNS-token, het pakket, de houdergegevens
  en een verhuiscode staan met AES-256-GCM versleuteld in de database. De sleutel staat in `BROKER_SECRET`
  of anders in `<datamap>/geheim.key` (alleen leesbaar voor de eigenaar). Inlogcodes en sessietokens
  staan alleen als hash opgeslagen.
- **Wat als de dienst gehackt wordt?** Dan kan een aanvaller met jouw organisatiesleutels bij Scaleway,
  Openprovider en deSEC: servers en buckets van klanten weggooien of uitzetten, DNS omleggen, domeinen
  verhuizen, en de projectsleutels uit het pakket lezen. Hij kan de **gegevens van klanten niet lezen**:
  die zijn versleuteld met hun hoofdsleutel. De back-ups staan met object-lock 30 dagen vast.
  Bescherm de dienst dus goed: eigen server, alleen poort 443 open, updates, 2FA op alle accounts,
  en een aparte API-sleutel voor de dienst (niet je eigen beheerderssleutel).
- **Mollie-webhook.** De dienst gelooft de webhook nooit: hij haalt de status altijd zelf op bij Mollie.

## Opzetten

### 1. Accounts

| Wat | Waar | Nodig |
|---|---|---|
| Mollie | mollie.com | Bedrijfsaccount, iDEAL en SEPA-incasso aan. Gebruik eerst een `test_`-sleutel. |
| Openprovider | openprovider.com | Reseller-account met tegoed. API-gebruiker met wachtwoord; zet het IP-adres van je server op de lijst. |
| deSEC | desec.io | Account met een token dat zones mag aanmaken (geen beperking op één domein). |
| Scaleway | console.scaleway.com | Organisatie. Maak een IAM-applicatie "eigen-cloud-dienst" met (voor de hele organisatie) `ProjectManager`, `IAMManager`, `InstancesFullAccess` (bewaker, opschorten) en `TransactionalEmailFullAccess`, en een API-sleutel daarvoor. Let op: met `IAMManager` kan deze sleutel zichzelf alle rechten geven; behandel hem als de sleutel van je organisatie. |
| Mail | je eigen domein | SMTP-adres voor inlogcodes en meldingen (bijv. Scaleway TEM van je eigen project). |

### 2. Omgevingsvariabelen

| Variabele | Standaard | Wat |
|---|---|---|
| `BROKER_DATA_DIR` | `./data-dienst` | Database, `geheim.key`, eventueel `bundles.json` |
| `BROKER_PORT` / `BROKER_HOST` | `4100` / `0.0.0.0` | Waar de dienst luistert |
| `BROKER_PUBLIC_URL` | `http://localhost:4100` | Openbaar adres, bijv. `https://dienst.jouwbedrijf.nl` (voor Mollie en de DNS-proxy in het pakket) |
| `BROKER_TRUST_PROXY` | `loopback,uniquelocal` | Welke proxy het IP-adres van de bezoeker mag doorgeven |
| `BROKER_SECRET` | — | 64 hex-tekens; anders wordt `geheim.key` gemaakt. **Bewaar een kopie veilig**: zonder deze sleutel zijn de pakketten niet meer te lezen |
| `BROKER_TERMS_URL`, `BROKER_PRIVACY_URL` | — | Links naar je voorwaarden en privacyverklaring (standaard; in het beheer onder Huisstijl te overschrijven) |
| `BROKER_FREE_ZONE` | uit | Domein van de dienst voor gratis adressen, bijv. `eigencloud.nl`: klanten kiezen dan alleen een naam (`vanes.eigencloud.nl`), zonder domein te kopen. Zie hieronder |
| `MOLLIE_API_KEY` | — | `test_…` of `live_…` |
| `MOLLIE_API_URL` | `https://api.mollie.com/v2` | |
| `OPENPROVIDER_USERNAME`, `OPENPROVIDER_PASSWORD` | — | |
| `OPENPROVIDER_URL` | `https://api.openprovider.eu/v1beta` | |
| `DESEC_TOKEN` | — | |
| `DESEC_URL` | `https://desec.io/api/v1` | |
| `SCW_SECRET_KEY`, `SCW_ORGANIZATION_ID` | — | Sleutel van de dienst en je organisatie-id |
| `SCW_API_URL` | `https://api.scaleway.com` | |
| `SCW_PERMISSION_SETS` | `InstancesFullAccess,BlockStorageFullAccess,ObjectStorageFullAccess,TransactionalEmailFullAccess` | Rechten van de klantsleutel, alleen in het eigen project |
| `BROKER_SMTP_URL` | — | Bijv. `smtp://gebruiker:wachtwoord@smtp.tem.scaleway.com:587`. Zonder: mails komen in het logboek (alleen voor ontwikkelen) |
| `BROKER_MAIL_FROM` | `Eigen Cloud Dienst <noreply@localhost>` | Afzender |
| `BROKER_ADMIN_EMAIL` | — | Krijgt meldingen (mislukt klaarzetten, incasso mislukt, te veel servers, opzeggingen) |
| `BROKER_LOOP_MS` | `30000` | Hoe vaak de achtergrondlus draait |
| `BROKER_GUARD_MS` | `3600000` | Hoe vaak de bewaker kijkt |
| `BROKER_ENFORCE` | uit | `1`: de bewaker zet de nieuwste extra servers ook echt uit |
| `BROKER_COMPANY_NAME` | — | **Nodig voor geldige facturen.** Je bedrijfsnaam. Zonder deze naam werken facturen wel, maar staat er "Bedrijfsgegevens ontbreken (stel BROKER_COMPANY_* in)" op, en bij het starten en bij `facturen` krijg je een waarschuwing |
| `BROKER_COMPANY_ADDRESS` | — | Adres, meerdere regels gescheiden door `\n`, bijv. `Blaak 10\n3011 TA Rotterdam` |
| `BROKER_COMPANY_KVK` | — | KvK-nummer |
| `BROKER_COMPANY_VAT` | — | Btw-identificatienummer, bijv. `NL001234567B01` |
| `BROKER_VAT_PERCENT` | `21` | Btw-percentage op de facturen (de prijzen van de bundels zijn inclusief btw) |
| `BROKER_OWNER_EMAIL` | — | Eerste **eigenaar** van het beheer (`/beheer`). Wordt bij het starten als medewerker aangemaakt (of krijgt de rol eigenaar). Kan ook met `dienst:cli -- eigenaar <e-mail>` |
| `BROKER_BRAND_NAME` | `Eigen Cloud Dienst` | Standaardnaam van je dienst in de app en in mails aan medewerkers; in het beheer (Huisstijl) te overschrijven |
| `BROKER_HEALTH_UNHEALTHY_MS` | `900000` (15 min) | Zo lang mag een cloud ongezond melden voordat de klant automatisch een bericht krijgt |
| `BROKER_HEALTH_SILENT_MS` | `21600000` (6 uur) | Zo lang mag een klare cloud (die zich al eens gemeld heeft) stil blijven voordat er automatisch een bericht komt |

### 3. Starten

Zonder Docker:

```bash
npm ci && npm run build
node dist/broker/main.js        # of tijdens ontwikkelen: npm run dienst
```

Met het bestaande Docker-image (dezelfde code, ander startcommando):

```bash
docker run -d --name dienst --restart unless-stopped \
  -v /srv/dienst:/data -e BROKER_DATA_DIR=/data --env-file /srv/dienst.env \
  -p 127.0.0.1:4100:4100 eigen-cloud:latest node dist/broker/main.js
```

Zet er een reverse proxy met HTTPS voor (bijv. Caddy: `dienst.jouwbedrijf.nl { reverse_proxy 127.0.0.1:4100 }`).
Mollie moet `https://dienst.jouwbedrijf.nl/v1/mollie/webhook` kunnen bereiken.

### 4. Gratis adressen (`BROKER_FREE_ZONE`)

Zo hoeft een nieuwe klant geen domein te kopen en geen houdergegevens in te vullen:

1. Neem een domein voor de dienst, bijvoorbeeld `eigencloud.nl`, en maak het bij deSEC aan (in hetzelfde account als `DESEC_TOKEN`).
2. Zet bij je registrar de nameservers van dat domein op `ns1.desec.io` en `ns2.desec.org` (en de DS-records van deSEC voor DNSSEC).
3. Zet `BROKER_FREE_ZONE=eigencloud.nl`.

Per klant maakt de dienst een eigen zone `naam.eigencloud.nl` bij deSEC (met een eigen DNS-token, net als bij een eigen domein) en zet in `eigencloud.nl` de verwijzing ernaartoe (NS en DS). Namen van 3 tot 32 tekens; een paar namen zijn gereserveerd (`www`, `mail`, `cloud`, `api`, `dienst`, …, zie `RESERVED_LABELS` in `src/broker/config.ts`). Let op: deSEC heeft een standaardlimiet op het aantal zones per account; vraag deSEC om een hogere limiet voordat je veel klanten hebt. Na opzeggen en opruimen blijft de zone staan (naam bezet) tot je hem zelf weghaalt.

### 5. De app laten weten waar de dienst staat

Zet het adres (bijv. `https://dienst.eigencloud.nl`) in het bestand `DIENST_URL` in de repository, of als GitHub-variabele `EIGEN_DIENST_URL`. Vanaf de volgende versie bieden de app en de console de dienst aan nieuwe gebruikers aan als eerste keuze ("Wij regelen alles"); zonder adres zien ze alleen de route met hun eigen Scaleway-sleutel.

Maak dagelijks een back-up van de datamap (de database `dienst.sqlite` met `sqlite3 dienst.sqlite ".backup …"`)
en bewaar `BROKER_SECRET` / `geheim.key` apart.

## Bundels (`bundles.json`)

Staat er geen `<datamap>/bundles.json`, dan gelden twee voorbeeldbundels: **Compleet** (€ 24,95) en
**Ruim** (€ 39,95). **Die prijzen zijn plaatshouders: stel ze zelf in.** Formaat:

```json
[
  {
    "id": "compleet",
    "title": "Compleet",
    "description": "Twee servers, een witness, 100 GB opslag, domein, DNS en mail.",
    "monthly": { "currency": "EUR", "value": "24.95" },
    "includes": { "dataServers": 2, "witnesses": 1, "storageGb": 100, "mail": true, "domain": true },
    "placement": [
      { "provider": "scaleway", "region": "nl-ams-1", "size": "DEV1-M", "country": "NL", "kind": "data" },
      { "provider": "scaleway", "region": "nl-ams-2", "size": "PLAY2-MICRO", "country": "NL", "kind": "data" },
      { "provider": "scaleway", "region": "fr-par-1", "size": "DEV1-S", "country": "FR", "kind": "witness" }
    ],
    "storage": [
      { "region": "nl-ams", "purpose": "replica" },
      { "region": "fr-par", "purpose": "backup" }
    ]
  }
]
```

Nieuw per bundel: `includes.users` (aantal gebruikers in de cloud, standaard 1) en `extraUserMonthly`
(`{ "currency": "EUR", "value": "2.50" }`, prijs per extra gebruiker per maand incl. btw; weglaten of `null` = niet te koop).
In plaats van een lijst mag het bestand ook een object zijn: `{ "bundles": [ … ], "costs": { "servers": { "DEV1-M": "8.50" }, "storageGbMonthly": "0.015" } }`.
`costs` zijn je geschatte kosten bij Scaleway (excl. btw, per maand) per serverformaat en per GB opslag per kopie; het beheer
zet die naast de prijs van de klant (marge). Niet opgegeven formaten krijgen de plaatshouders uit `DEFAULT_COSTS` in
`src/broker/config.ts`. **Controleer ze met je eigen Scaleway-factuur.**

**Aanbod in het beheer.** Bundels die je in het beheer (Aanbod) wijzigt of toevoegt, worden in de database bewaard en gaan
vanaf dan vóór `bundles.json`. Wil je terug naar het bestand, verwijder dan de instelling `bundles` uit de tabel `settings`.

Gebruik alleen regio's die de console kent (`nl-ams-1`, `nl-ams-2`, `nl-ams-3`, `fr-par-1`, `pl-waw-1`) en
controleer of het formaat in die zone te koop is. Een prijswijziging geldt voor nieuwe bestellingen;
lopende Mollie-abonnementen houden hun bedrag (ook als de klant later van bundel wisselt en terug, krijgt hij
de prijs die op dat moment in `bundles.json` staat).

## Wat er gebeurt na betaling

1. **DNS-zone** bij deSEC (met DNSSEC-sleutels).
2. **Domein**: registreren of verhuizen bij Openprovider met nameservers `ns1.desec.io` en `ns2.desec.org`
   en de DNSSEC-sleutel. Bij een eigen domein moet de klant die nameservers zelf instellen.
3. **Scaleway-project** `eigen-cloud-<klant>-<bestelling>`.
4. **IAM**: applicatie, policy (alleen dat project) en een API-sleutel.
5. **Mail**: domein bij Scaleway TEM; DKIM (en DMARC als die er nog niet is) in de zone. SPF niet: dat
   beheert het cluster zelf en voegt `spfExtra` uit het pakket toe.
6. **DNS-token** voor de proxy.
7. **Klaar**: het pakket wordt versleuteld bewaard en de klant krijgt een mail.

Elke stap kijkt eerst of het onderdeel al bestaat; opnieuw proberen maakt dus niets dubbel. Tijdelijke
fouten (netwerk, 5xx, 401, 429) worden steeds later opnieuw geprobeerd; na 10 keer krijg je een mail.
Een blijvende fout (andere 4xx) zet de bestelling op *mislukt*, met een leesbare melding, en je krijgt
een mail. Na oplossen: `npm run dienst:cli -- opnieuw <id>`.

Een gemiste Mollie-webhook wordt opgevangen: open eerste betalingen worden tot 48 uur lang elke 5 minuten
zelf nagekeken.

## Abonnement zelf regelen (in de app)

Onder **Abonnement** ziet de klant zijn bundel, de volgende betaaldatum, de betaalmethode (bijv.
"NL** **** **** 1234" of "Visa •••• 4242"), alle betalingen met hun factuur, en eventueel een openstaand bedrag.
Hij kan daar zelf:

- **Van bundel wisselen.** Kan alleen als de cloud klaar is en de betalingen in orde zijn. Het Mollie-abonnement
  krijgt het nieuwe bedrag (en een nieuwe omschrijving, uniek per klant dankzij het korte ordernummer). **Er is
  geen verrekening naar rato:** de lopende maand blijft zoals betaald, het nieuwe bedrag geldt vanaf de
  volgende betaling. Het pakket wordt wél meteen bijgewerkt: de console mag direct extra servers bouwen en de
  bewaker rekent meteen met de grenzen van de nieuwe bundel. Bij teruggaan naar een kleinere bundel moet de
  console zelf servers afbouwen; de bewaker meldt het als dat niet gebeurt.
- **Betaalmethode wijzigen.** De klant betaalt € 0,01 (eerste betaling; daarmee maakt Mollie een nieuwe
  machtiging). Als die betaald is, zet de dienst de nieuwe machtiging op het abonnement (`mandateId`) en stort
  de cent terug. Lukt het terugstorten niet (bijv. te weinig saldo bij Mollie), dan komt dat alleen in het
  logboek (`mandate-refund-error`); de wijziging gaat gewoon door. Voor de cent komt geen factuur.
- **Achterstand betalen.** Alleen bij een betalingsprobleem: een eenmalige betaling (geen incasso) van alle
  mislukte incasso's die nog openstaan.
- **Opzegging terugdraaien.** Zie *Opzeggen* hieronder.
- **Domein meenemen.** Bij een geregistreerd of verhuisd domein (klaar of opgezegd) haalt de dienst de
  verhuiscode op bij Openprovider. Bij een eigen domein kan dat niet; dat beheert de klant al zelf.

## Facturen

Elke echte betaling krijgt een factuur: de eerste betaling, elke maandelijkse incasso en een betaalde
achterstand (niet de € 0,01 van een nieuwe betaalmethode). De klant krijgt een korte mail ("Factuur
EC-2026-0001") en bekijkt of print de factuur in de app.

- **Nummering**: `EC-<jaar>-<volgnummer>` met vier cijfers, doorlopend per jaar en zonder gaten (het nummer wordt
  in dezelfde databasetransactie toegekend als de factuur wordt opgeslagen). Factuurdatum = de dag waarop de
  betaling binnenkwam bij de dienst.
- **Btw**: de bedragen zijn inclusief btw. De dienst rekent terug: bedrag excl. btw = incl. / (1 + btw%),
  afgerond op centen; het btw-bedrag is het verschil, zodat excl. + btw altijd precies het betaalde bedrag is.
  Bijvoorbeeld € 24,95 = € 20,62 + € 4,33 btw (21%).
- **Inhoud**: jouw bedrijfsgegevens (`BROKER_COMPANY_*`), de gegevens van de klant (naam, bedrijf en adres van
  de domeinhouder als die er is, plus het e-mailadres), de omschrijving met de periode (bijv. "10 oktober –
  9 november 2026"), excl./btw/incl. en "Betaald op … via …".
- **Vastgelegd**: alle gegevens van een factuur worden bij het maken versleuteld bewaard. Een latere wijziging
  van je bedrijfsgegevens, btw-tarief of bundel verandert oude facturen dus niet. Stel `BROKER_COMPANY_*` in
  vóórdat de eerste klant betaalt.
- Eén factuur per betaling, ook als Mollie de webhook twee keer stuurt.
- **Je eigen boekhouding blijft nodig.** De dienst maakt facturen, maar doet geen boekhouding en geen
  btw-aangifte. Neem de facturen (`facturen`) en de uitbetalingsoverzichten van Mollie (*settlements*, met
  de kosten die Mollie inhoudt) mee in je administratie. Creditnota's (bijv. bij een terugboeking of
  chargeback) maakt de dienst niet; die maak je zelf.
- Betalingen van vóór deze versie hebben geen factuur gekregen.

## Beheer vanaf de opdrachtregel

Dezelfde omgevingsvariabelen en datamap als de dienst:

```bash
npm run dienst:cli -- klanten              # alle klanten en hun bestellingen
npm run dienst:cli -- order <id>           # details, stappen en laatste gebeurtenissen
npm run dienst:cli -- opnieuw <id>         # mislukt klaarzetten opnieuw proberen
npm run dienst:cli -- opschorten <id>      # sleutel intrekken + servers uit (gegevens blijven)
npm run dienst:cli -- hervatten <id>       # nieuwe sleutel; de console haalt het nieuwe pakket op
npm run dienst:cli -- opruimen <id>        # na opzegging: laat zien wat er weg zou gaan
npm run dienst:cli -- opruimen <id> --zeker
npm run dienst:cli -- bewaker              # nu op te veel servers controleren
npm run dienst:cli -- facturen             # alle facturen: nummer, datum, bedrag, bestelling
npm run dienst:cli -- facturen <id>        # alleen die van één bestelling
npm run dienst:cli -- eigenaar <e-mail>    # eerste (of extra) eigenaar voor het beheer
npm run dienst:cli -- medewerkers          # alle medewerkers, hun rol en tweede stap
npm run dienst:cli -- tweede-stap-wissen <e-mail>   # telefoon kwijt: opnieuw laten instellen
```

`klanten` laat per bestelling ook het maandbedrag en het aantal facturen (en het betaalde totaal) zien.

In Docker: `docker exec dienst node dist/broker/cli.js klanten`.

**Betalingsproblemen.** Mislukt een maandelijkse incasso, dan krijgen klant en jij een mail en staat de
bestelling op *betalingsprobleem*. De cloud blijft werken. De dienst probeert een mislukte incasso niet zelf
opnieuw (en Mollie doet dat bij een abonnement ook niet vanzelf — controleer dit). De klant ziet het
openstaande bedrag in de app (onder Abonnement) en kan het daar in één keer betalen (iDEAL e.d.); daarna staat
de bestelling weer op *klaar* en krijgt hij een factuur. Gebeurt dat niet, neem dan contact op en schort na
een afgesproken termijn (bijv. 14 dagen) op met `opschorten`. Lukt de volgende maandelijkse incasso wel, dan
gaat de bestelling ook vanzelf terug naar *klaar*, maar de eerder mislukte incasso blijft dan als openstaand
staan (hij is immers nooit betaald) en telt mee bij een volgend betalingsprobleem. Heb je een achterstand
buiten de dienst om geregeld, dan moet je dat nu nog met de hand in de database afboeken (`settled_by`).

**Opzeggen.** De klant zegt op in de app; het Mollie-abonnement stopt meteen en alles blijft werken tot
het einde van de betaalde maand (`endsAt`). Tot die datum kan de klant de opzegging in de app terugdraaien:
dan komt er een nieuw Mollie-abonnement dat precies op `endsAt` begint, met de bestaande machtiging. Daarna
(of na `opruimen`) moet hij opnieuw bestellen. Daarna bewaar je de gegevens nog 30 dagen. `opruimen --zeker`
verwijdert de IAM-applicatie (met sleutels en policy), trekt het maildomein in en schakelt de DNS-toegang
uit. **Handmatig** (bewust, omdat het onherroepelijk is): servers en volumes verwijderen, buckets leegmaken
(de back-upbucket heeft object-lock) en daarna het project verwijderen in de Scaleway-console. De DNS-zone
en de domeinnaam blijven staan tot de klant verhuist of de domeinnaam vervalt (zet dan autorenew uit bij
Openprovider).

## Beheer door de aanbieder (`/beheer`)

Medewerkers beheren de dienst in de browser op `https://<dienst>/beheer`, of in de Eigen Cloud-app (onderdeel
*Aanbieder*, dezelfde pagina's in een WebView). De pagina's staan in `web-dienst/` (gewoon HTML/JS, geen bouwstap) en
worden door de dienst zelf geserveerd, met een strenge Content-Security-Policy. **Docker:** het image moet de map
`web-dienst/` meenemen (`COPY web-dienst ./web-dienst` in de `Dockerfile`); zonder die map werkt de API wel, maar is
`/beheer` er niet.

### Eerste eigenaar

Zet `BROKER_OWNER_EMAIL=jij@jouwbedrijf.nl` en start de dienst, of voer één keer `npm run dienst:cli -- eigenaar jij@jouwbedrijf.nl`
uit (Docker: `docker exec dienst node dist/broker/cli.js eigenaar jij@jouwbedrijf.nl`). Open daarna `/beheer`, vraag een code
aan en stel je tweede stap in. Daarna nodig je zelf medewerkers uit (Medewerkers). De laatste eigenaar kan nooit worden
verwijderd of een andere rol krijgen.

### Rollen

| Rol | Mag |
|---|---|
| **Eigenaar** | Alles: ook medewerkers, huisstijl en het logboek |
| **Beheer** | Klanten en clouds inzien en opschorten/hervatten/opzeggen/opnieuw/opruimen, kosten, aanbod (bundels en prijzen), uitnodigingscodes, berichten, hulpvragen |
| **Support** | Klanten en clouds inzien (zonder abonnement en kosten), hulpvragen beantwoorden, berichten lezen |
| **Financiën** | Klanten inzien, betalingen, facturen, achterstanden, terugbetalen, omzet, kosten |

Rechten (in `src/broker/staff.ts`, `PERMISSIONS`): `customers.read`, `customers.act`, `costs`, `money`, `refund`, `offering`,
`invites`, `announcements.read`, `announcements`, `tickets`, `health`, `staff`, `brand`, `audit`. `GET /v1/admin/me` geeft de
rechten van de ingelogde medewerker; de pagina's tonen alleen wat mag, de API controleert het altijd zelf (anders 403).

### Inloggen: altijd twee stappen

1. **Code per mail**: `POST /v1/admin/auth/start {email}` → altijd 202 (alleen medewerkers krijgen echt een mail, zodat
   niemand kan uitzoeken wie medewerker is); zelfde code-regels als bij klanten (6 cijfers, 15 minuten, 5 pogingen, 5 codes
   per adres per uur). `POST /v1/admin/auth/verify {email, code}` → `{pending, next: "enrol"|"second", methods: ["totp","device"]}`.
   `pending` is een tijdelijke aanmelding (10 minuten, 5 foute pogingen), géén sessie.
2. **Tweede stap (verplicht)**. Bij de eerste keer (`next: "enrol"`) stelt de medewerker er één in:
   - **Authenticator-app (TOTP, RFC 6238)**: `POST /v1/admin/auth/enrol/totp {pending}` → `{secret, uri, qrSvg}` (`otpauth://totp/…`,
     SHA1, 6 cijfers, 30 s); `POST /v1/admin/auth/enrol/totp/confirm {pending, code}` → sessie. Inloggen: `POST /v1/admin/auth/totp {pending, code}`.
     Eén stap (30 s) speling naar voren en achteren; een gebruikte code (of een oudere) werkt niet nog eens.
   - **Toestelsleutel (vingerafdruk)**: `POST /v1/admin/auth/challenge {pending}` → `{challenge, message}`; de app ondertekent
     `message` = `eigen-dienst-login:<challenge>`; `POST /v1/admin/auth/enrol/device {pending, publicKey, signature, label}` → sessie.
     Inloggen: `challenge` en dan `POST /v1/admin/auth/device {pending, signature, publicKey?}`. Elke uitdaging werkt één keer.
3. **Sessie**: `{token, staff, permissions}`. Daarna `Authorization: Staff <token>`. Het token (32 willekeurige bytes) staat alleen
   als hash in de database en vervalt na **12 uur niets doen**. Klanttokens (`Bearer`) werken niet in het beheer en andersom.

Ingelogd kan een medewerker onder *Mijn account* een tweede methode toevoegen of weghalen (`/v1/admin/me/totp`,
`/v1/admin/me/device`, …), maar nooit de laatste. Telefoon kwijt? Een eigenaar wist de tweede stap (Medewerkers →
*Tweede stap wissen*, of `dienst:cli -- tweede-stap-wissen <e-mail>`); de medewerker stelt hem bij de volgende keer opnieuw in.

### Brug met de app (vingerafdruk)

De pagina's roepen deze functies aan als `window.EigenNative` ze heeft (in de app); in een gewone browser is alleen de
authenticator-app beschikbaar.

| Functie | Wat de app doet | Antwoord |
|---|---|---|
| `EigenNative.dienstKey(origin)` | Geeft de publieke sleutel van **deze Dienst** (`origin` = `location.origin`, bijv. `https://dienst.jouwbedrijf.nl`). Bestaat er nog geen, dan maakt de app een ECDSA P-256-sleutelpaar in de Android Keystore (`KeyGenParameterSpec` met `PURPOSE_SIGN`, `DIGEST_SHA256`, `setUserAuthenticationRequired(true)`, biometrie). Eén sleutel per origin. | SPKI (DER) als base64 (`publicKey.getEncoded()`) |
| `EigenNative.dienstSign(challenge, origin)` | Toont de vingerafdrukvraag (BiometricPrompt met `CryptoObject`) en ondertekent de UTF-8-tekst `eigen-dienst-login:<challenge>` met `SHA256withECDSA` met de sleutel van `origin`. | Handtekening als base64: DER (zoals Android hem geeft) of 64 bytes r‖s |
| `EigenNative.deviceName()` *(optioneel)* | Naam van het toestel, bijv. "Pixel 8 van Rene" | tekst |

Antwoorden mag op drie manieren: direct een niet-lege tekst teruggeven, een Promise teruggeven, of (gebruikelijk op Android,
want de vingerafdrukvraag is asynchroon) een lege tekst teruggeven en later in de WebView
`window.eigenDienstKey(waarde, fout)` resp. `window.eigenDienstSigned(waarde, fout)` aanroepen (bijv. via
`webView.evaluateJavascript("window.eigenDienstSigned('…', null)")`). Bij annuleren of een fout: `waarde` = `null` en `fout` =
een korte Nederlandse tekst. De pagina wacht hooguit 2 minuten. De challenge bestaat uit base64url-tekens (veilig in een
JS-tekst). De WebView heeft een gewone `<dialog>` nodig (Chrome-WebView kan dat); `prompt()` wordt niet gebruikt.

### Logboek

Elke handeling in het beheer komt in de tabel `audit` (wie, wat, waarop, wanneer, details): inloggen, tweede stap,
medewerkers, opschorten/hervatten/opzeggen/opnieuw/opruimen, terugbetalen, aanbod, huisstijl, uitnodigingen, hulpvragen en
berichten. Alleen eigenaren zien het (*Logboek*, `GET /v1/admin/audit`). Acties op een bestelling komen ook in de
gebeurtenissen van die bestelling (`staff-suspend` met `by`).

### Beheer-API

Alles met `Authorization: Staff <token>`; fouten als `{error}` (401 niet ingelogd, 403 niet met deze rol, 404, 409, 400; 502
als Mollie of Scaleway een fout gaf).

| Methode en pad | Recht | Wat |
|---|---|---|
| `GET /v1/admin/me` | ingelogd | Medewerker, rechten, huisstijl |
| `POST /v1/admin/auth/logout` | ingelogd | Sessie beëindigen |
| `POST /v1/admin/me/name` `{name}` | ingelogd | Eigen naam (klanten zien die bij antwoorden) |
| `POST /v1/admin/me/totp`, `…/totp/confirm {code}`, `DELETE /v1/admin/me/totp` | ingelogd | Authenticator-app toevoegen/weghalen |
| `POST /v1/admin/me/device/challenge`, `POST /v1/admin/me/device {publicKey, signature, label}`, `DELETE /v1/admin/me/device/:id` | ingelogd | Telefoon koppelen/ontkoppelen |
| `GET /v1/admin/overview` | iedereen | Aantallen per status, omzet deze maand, achterstanden, open hulpvragen, ongezonde clouds (wat de rol mag zien) |
| `GET /v1/admin/customers?q=&status=a,b&health=problem&limit=&offset=` | customers.read | Bestellingen met klant, status, gebruikers, gezondheid. `q` zoekt in e-mail, domein, ordernummer en uitnodigingscode |
| `GET /v1/admin/orders/:id` | customers.read | Details: stappen, gebeurtenissen, techniek (zonder geheimen), gezondheid, abonnement (beheer/financiën), kosten, hulpvragen, mogelijke acties |
| `POST /v1/admin/orders/:id/suspend` · `resume` · `cancel` · `retry` | customers.act | Zelfde als de opdrachtregel |
| `POST /v1/admin/orders/:id/cleanup` `{sure?}` | customers.act | Zonder `sure`: alleen het plan |
| `GET /v1/admin/orders/:id/servers` | costs | Servers in het Scaleway-project (alle zones), toegestaan aantal, geschatte kosten, prijs en marge |
| `GET /v1/admin/costs` | costs | Per actieve bestelling prijs excl. btw, geschatte kosten, marge en totalen |
| `GET /v1/admin/payments?status=&orderId=` | money | Betalingen (zonder de € 0,01), met factuur, terugbetaald en nog terug te betalen |
| `POST /v1/admin/payments/:id/refund` `{amount?, description?}` | refund | Terugbetalen via Mollie (`POST /payments/{id}/refunds`); zonder bedrag: alles wat nog kan |
| `GET /v1/admin/invoices?orderId=` · `GET /v1/admin/invoices/:id` | money | Facturen; één factuur als HTML |
| `GET /v1/admin/arrears` | money | Bestellingen met een betalingsprobleem, openstaand bedrag en mislukte incasso's |
| `GET /v1/admin/revenue?months=12` | money | Per maand (NL-tijd, dag van betalen): incl., excl., btw, terugbetaald, netto, aantal |
| `GET /v1/admin/bundles` · `PUT /v1/admin/bundles/:id` · `DELETE /v1/admin/bundles/:id` | offering | Aanbod; `PUT` voegt toe of wijzigt (alleen meegegeven velden; servers en opslag blijven staan). Verwijderen kan niet zolang klanten de bundel hebben |
| `GET /v1/admin/brand` · `PUT /v1/admin/brand` | brand | Huisstijl: `{name, accentColor:"#rrggbb", contact:{email,phone,website}, termsUrl, privacyUrl}`; lege tekst = terug naar de standaard |
| `PUT /v1/admin/brand/logo` `{dataUrl}` of `{type, data(base64)}` · `DELETE …/logo` | brand | PNG of SVG, hooguit 200 KB; SVG zonder scripts of externe verwijzingen |
| `GET /v1/admin/invites` · `POST /v1/admin/invites {label?, bundle?, maxUses?, expiresAt?}` · `DELETE /v1/admin/invites/:code` | invites | Uitnodigingscodes (8 tekens, getoond als `ABCD-EFGH`) |
| `GET /v1/admin/tickets?status=active\|open\|answered\|closed\|all&q=` · `GET /v1/admin/tickets/:id` | tickets | Hulpvragen |
| `POST /v1/admin/tickets/:id/messages {message, close?}` · `…/close` · `…/reopen` | tickets | Antwoorden (klant krijgt een mail), sluiten, heropenen |
| `GET /v1/admin/announcements?state=` | announcements.read | Berichten met `state` actief/gepland/afgelopen |
| `POST /v1/admin/announcements {title, body, severity: info\|onderhoud\|storing, startsAt?, endsAt?, audience?: "orders", orderIds?}` · `…/:id/end` | announcements | Bericht plaatsen of beëindigen |
| `GET /v1/admin/health` | health | Alle actieve clouds met hun laatste melding |
| `GET /v1/admin/staff` · `POST /v1/admin/staff {email, role, name?}` · `PATCH /v1/admin/staff/:id {role}` · `DELETE /v1/admin/staff/:id` · `POST /v1/admin/staff/:id/reset` | staff | Medewerkers; een nieuwe medewerker krijgt een mail |
| `GET /v1/admin/audit?limit=&before=&staff=&action=` | audit | Logboek, nieuwste eerst; `before` = id voor de volgende bladzijde |

### Extra gebruikers

Een bundel heeft `includes.users` gebruikers. De klant koopt er bij met `POST /v1/orders/:id/users {count}` (`count` = het
totaal aantal extra gebruikers, 0–100; alleen als de cloud *klaar* is). Net als bij bundel wisselen: het Mollie-abonnement
krijgt het bedrag **huidige bundelprijs + count × extraUserMonthly** vanaf de volgende betaling, zonder verrekening, en het
pakket krijgt meteen `users` = inbegrepen + extra. Let op: daarmee gaat de klant ook naar de huidige bundelprijs als je die
intussen hebt veranderd. Bij bundel wisselen gaan de extra gebruikers mee (tegen de prijs van de nieuwe bundel; heeft die
bundel geen prijs per extra gebruiker, dan vervallen ze). De cloud moet de limiet zelf afdwingen met `kit.users`.

### Gezondheid van clouds

Een cloud meldt zich (bijvoorbeeld elke 5 minuten) met het DNS-token uit zijn pakket, net als bij de DNS-proxy:

```
POST /v1/orders/<orderId>/health
Authorization: Token <kit.dns.token>
{ "version": "1.7.3", "healthy": true, "problems": [], "storageUsedBytes": 123456789, "users": 2,
  "nodes": [{ "id": "n1", "region": "nl-ams-1", "status": "ok" }] }
→ 200 { "ok": true, "next": 300 }       // next = aanbevolen seconden tot de volgende melding
```

403 bij een verkeerd token, een andere bestelling of een opgeschorte bestelling; 400 als `healthy` geen true/false is; 429
bij meer dan 120 meldingen per uur. Alleen deze velden worden bewaard (ingekort: hooguit 20 problemen van 200 tekens en 20
servers); al het andere wordt genegeerd. **Stuur nooit inhoud** (mail, agenda, foto's, namen van gebruikers).

Automatische berichten: is een cloud langer dan `BROKER_HEALTH_UNHEALTHY_MS` ongezond, of heeft een klare cloud die zich
al eens meldde langer dan `BROKER_HEALTH_SILENT_MS` niets laten horen, dan krijgt die klant automatisch een bericht
(soort *storing*), komt de cloud in het overzicht onder *Clouds met een probleem* en krijgt `BROKER_ADMIN_EMAIL` een mail.
Meldt de cloud zich weer gezond, dan wordt het bericht beëindigd. Gecontroleerd bij elke melding en in de achtergrondlus.

## Nog niet getest met echte accounts

Alles is getest tegen nep-versies van de API's (`test/broker.test.ts`), gebouwd volgens de documentatie.
Controleer met echte (test)accounts vóór je live gaat:

- **Openprovider domeincheck**: de vorm van het antwoord (`data.results[].status` = `free`, prijs onder
  `price.reseller` of `price.product`).
- **Openprovider verhuizen**: de dienst verhuist door `POST /domains` mét `auth_code` te sturen. Openprovider
  heeft mogelijk een apart `POST /domains/transfer`; pas dit aan als dat nodig blijkt.
- **Openprovider houder**: het opsplitsen van telefoonnummers (landcode / netnummer / abonneenummer) en
  extra velden die sommige extensies vragen (bijv. `.eu`, `.be`).
- **Scaleway rechten**: de namen in `SCW_PERMISSION_SETS` en of die samen genoeg zijn voor servers, IP's,
  volumes, Object Storage en TEM; en welke rechten de sleutel van de dienst zelf nodig heeft.
- **Scaleway TEM**: de vorm van de records (`records.dkim/dmarc/spf` of `dkim_config`/`spf_config`) en
  de recordnaam van DKIM (`<project-id>._domainkey`).
- **Scaleway Object Storage**: dat de projectsleutel buckets in het eigen project aanmaakt.
- **Mollie live**: de eerste betaling met machtiging en het abonnement in live-modus (in testmodus
  werkt alles met nep-betalingen).
- **Formaten per zone**: of `DEV1-M`, `PLAY2-MICRO` en `DEV1-S` in de gekozen zones beschikbaar zijn.
- **Mollie abonnement wijzigen**: `PATCH /customers/{id}/subscriptions/{id}` met `amount`/`description` (bundel
  wisselen) en met `mandateId` (nieuwe betaalmethode). Volgens de documentatie kan dat; nog niet live geprobeerd.
- **Mollie terugstorten**: `POST /payments/{id}/refunds` voor de € 0,01; werkt alleen met genoeg saldo bij Mollie.
- **Mollie betaalmethode wijzigen met € 0,01**: of elke methode (iDEAL, creditcard) een eerste betaling van
  € 0,01 accepteert en daarna een geldige machtiging oplevert.
- **Mollie opzegging terugdraaien**: een nieuw abonnement met `startDate` in de toekomst en `mandateId`; de
  omschrijving krijgt "vanaf <datum>" erbij omdat Mollie unieke omschrijvingen per klant wil.
- **Mollie achterstand**: een betaling met `sequenceType: "oneoff"` en `customerId`.
- **Mollie terugbetalen vanuit het beheer**: `POST /payments/{id}/refunds` met een deelbedrag; de status van de
  terugbetaling (`pending` → `refunded`) wordt nu niet opgevolgd. Controleer in het Mollie-dashboard.
- **Kosten per serverformaat**: de prijzen in `DEFAULT_COSTS` zijn plaatshouders; zet je echte prijzen in `bundles.json`.
- **Openprovider verhuiscode**: `GET /domains/{id}/authcode` → `data.auth_code`, en als dat niets geeft één keer
  `POST /domains/{id}/authcode/reset`. Gebouwd volgens de documentatie, nog niet met een echt account getest.
  Controleer ook per extensie of de code direct terugkomt (bij sommige registries gaat hij per mail naar de houder).

## Juridisch en administratief (kort)

- **Reseller-voorwaarden**: lees de voorwaarden van Openprovider (houdergegevens moeten kloppen, je bent
  aanspreekpunt bij misbruik) en de gebruiksvoorwaarden van Scaleway en deSEC voor doorverkoop.
- **Facturen en boekhouding**: zie *Facturen*. Controleer met je boekhouder of de factuur aan je eisen voldoet
  (bijv. of je zakelijke klanten om hun btw-nummer wilt vragen). De btw-aangifte doe je zelf.
- **Btw**: je prijzen voor consumenten zijn inclusief 21% btw. Voor zakelijke klanten in andere EU-landen
  geldt mogelijk verlegging; voor consumenten elders in de EU het btw-tarief van hun land (OSS).
- **Verwerkersovereenkomst**: je verwerkt persoonsgegevens (e-mailadres, houdergegevens, betaalgegevens via
  Mollie). Bied zakelijke klanten een verwerkersovereenkomst aan en sluit er zelf een met Scaleway en
  Openprovider (meestal via hun voorwaarden). De inhoud van de cloud kun je niet lezen; zeg dat ook zo.
- **Privacyverklaring**: welke gegevens, waarom, hoe lang (bijv. houdergegevens zolang het domein loopt,
  boekhouding 7 jaar), en wie de subverwerkers zijn (Mollie, Openprovider, deSEC, Scaleway).
- **Algemene voorwaarden**: opzegtermijn, wat er gebeurt bij wanbetaling (opschorten na X dagen),
  bewaartermijn na opzegging (30 dagen), en dat de klant zelf verantwoordelijk is voor zijn hoofdsleutel.

## API (voor de app en de console)

JSON; fouten als `{ "error": "…" }`. Inloggen met `Authorization: Bearer <token>`.

| Methode en pad | Wat |
|---|---|
| `GET /v1/info` | Naam, bundels (met `includes.users` en `extraUserMonthly`), links naar voorwaarden en privacy, `brand` |
| `GET /v1/brand` · `GET /v1/brand/logo` | Huisstijl van de aanbieder: `{name, accentColor, contact:{email,phone,website}, termsUrl, privacyUrl, logoUrl}`; het logo als PNG/SVG |
| `GET /v1/invite/:code` | `{valid, code?, reason?, brand, bundle?}` (hoofdletters en streepjes maken niet uit) |
| `POST /v1/auth/start` `{email}` | Mailt een code van 6 cijfers (15 minuten, 5 pogingen) → 202 |
| `POST /v1/auth/verify` `{email, code}` | → `{token, customer}` (token 90 dagen geldig) |
| `GET /v1/domains/check?name=` | → `{domain, available, price}` |
| `POST /v1/orders` | `{bundle, domain:{mode,name,authCode?}, registrant?, acceptTerms:true, invite?}` → `{orderId, checkoutUrl}`. Een ongeldige `invite` geeft 400; een geldige wordt bij de bestelling bewaard en geteld |
| `GET /v1/orders/:id` | Status en stappen |
| `GET /v1/orders/:id/kit` | Het pakket (alleen als het klaar is; anders 409) |
| `GET /v1/me` | Klant en bestellingen. Herstellen op een nieuw toestel gebruikt dit: inloggen met e-mail en code → nieuwste bestelling → `kit` → de console zoekt met de herstelsleutel de versleutelde configuratie in de opslag van het pakket (de dienst kan die zelf niet lezen) |
| `POST /v1/orders/:id/cancel` | Opzeggen → `{ok, endsAt}` (`endsAt` hier als datum `JJJJ-MM-DD`) |
| `GET /v1/orders/:id/billing` | Abonnement en betalingen, zie hieronder |
| `POST /v1/orders/:id/bundle` | `{bundle}` → `{ok, bundle:{id,title,monthly}, effective:"JJJJ-MM-DD"}`. 400: onbekende of dezelfde bundel; 409: niet *klaar* |
| `POST /v1/orders/:id/payment-method` | → `{checkoutUrl}` (betaling van € 0,01). 409: geen lopend abonnement |
| `POST /v1/orders/:id/settle` | → `{checkoutUrl}` (eenmalige betaling van het openstaande bedrag). 409: niets open |
| `POST /v1/orders/:id/resume` | → `{ok, status:"ready", nextPaymentDate}`. 409: niet opgezegd, of `endsAt` voorbij, of opgeruimd |
| `GET /v1/orders/:id/authcode` | → `{domain, authCode}`. 409: eigen domein, of niet *klaar*/*opgezegd* |
| `GET /v1/invoices/:id` | De factuur als HTML (om te bekijken of af te drukken; A4) |
| `POST /v1/orders/:id/users` | `{count}` → `{ok, users:{included,extra,total}, amount, effective}`. Zie *Extra gebruikers* |
| `GET /v1/tickets` · `POST /v1/tickets {subject, message, orderId?}` | Eigen hulpvragen; een nieuwe vraag mailt de medewerkers (eigenaar, beheer, support) en `BROKER_ADMIN_EMAIL` |
| `GET /v1/tickets/:id` · `POST /v1/tickets/:id/messages {message}` | Gesprek (`messages: [{from: "customer"\|"staff", name, body, at}]`) en reageren |
| `GET /v1/announcements` | Actieve berichten voor deze klant: `[{id, title, body, severity, startsAt, endsAt, auto, createdAt}]` |
| `POST /v1/orders/:id/health` | Voor de cloud, met `Authorization: Token <dns-token>`; zie *Gezondheid van clouds* |
| `/v1/admin/…` | Beheer door medewerkers; zie *Beheer door de aanbieder* |
| `POST /v1/mollie/webhook` | Voor Mollie |
| `GET /betaald?order=` | Bedankpagina na betalen |
| `/v1/desec/domains/:zone/…` | DNS-proxy met `Authorization: Token <dns-token>` |

Alles onder `/v1/orders/:id/…` en `/v1/invoices/:id` werkt alleen voor de eigen bestellingen en facturen
(anders 404). Een fout bij Mollie of Openprovider geeft 502 met een melding.

`GET /v1/orders/:id/billing`:

```
{ orderId, status, domain,
  bundle: { id, title, monthly: { currency, value } },   // monthly = wat de klant nu betaalt
  nextPaymentDate: "JJJJ-MM-DD" | null,                   // uit het Mollie-abonnement (alleen als het loopt)
  endsAt: number | null,                                  // ms (middernacht NL-tijd); alleen na opzeggen
  mandate: { method, label, status } | null,              // bijv. "NL** **** **** 1234" of "Visa •••• 4242"
  payments: [{ id, date, amount, status, description, invoiceId | null }],   // nieuwste eerst; zonder de € 0,01
  outstanding: { currency, value } | null,                // alleen bij betalingsprobleem
  bundles: [{ id, title, monthly, current }],
  users: { included, extra, extraUserMonthly: { currency, value } | null },
  canResume: boolean,
  domainTransferable: boolean }                           // geregistreerd/verhuisd én klaar of opgezegd
```
