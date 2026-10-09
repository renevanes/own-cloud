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
een bewaker op het aantal servers, en opzeggen.

**Niet:** de dienst bouwt het cluster niet en kan niet in de gegevens van de klant kijken.
De **hoofdsleutel** van de klant (die alle gegevens versleutelt) wordt op het apparaat van de klant
gemaakt en komt nooit bij de dienst. De dienst levert alleen de accounts eromheen.

**Meenemen:** een klant kan altijd vertrekken. De domeinnaam gaat met een verhuiscode naar een andere
registrar, de DNS-records zijn gewone records, en de gegevens staan versleuteld in opslag waar de klant
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
| `BROKER_TERMS_URL`, `BROKER_PRIVACY_URL` | — | Links naar je voorwaarden en privacyverklaring |
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

Gebruik alleen regio's die de console kent (`nl-ams-1`, `nl-ams-2`, `nl-ams-3`, `fr-par-1`, `pl-waw-1`) en
controleer of het formaat in die zone te koop is. Een prijswijziging geldt voor nieuwe bestellingen;
lopende Mollie-abonnementen houden hun bedrag.

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
```

In Docker: `docker exec dienst node dist/broker/cli.js klanten`.

**Betalingsproblemen.** Mislukt een maandelijkse incasso, dan krijgen klant en jij een mail en staat de
bestelling op *betalingsprobleem*. De cloud blijft werken. De dienst probeert een mislukte incasso niet zelf
opnieuw (en Mollie doet dat bij een abonnement ook niet vanzelf — controleer dit): neem contact op met de
klant, laat hem eventueel los betalen, en schort na een afgesproken termijn (bijv. 14 dagen) op met
`opschorten`. Lukt de volgende maandelijkse incasso wel, dan gaat de bestelling vanzelf terug naar *klaar*.

**Opzeggen.** De klant zegt op in de app; het Mollie-abonnement stopt meteen en alles blijft werken tot
het einde van de betaalde maand (`endsAt`). Daarna bewaar je de gegevens nog 30 dagen. `opruimen --zeker`
verwijdert de IAM-applicatie (met sleutels en policy), trekt het maildomein in en schakelt de DNS-toegang
uit. **Handmatig** (bewust, omdat het onherroepelijk is): servers en volumes verwijderen, buckets leegmaken
(de back-upbucket heeft object-lock) en daarna het project verwijderen in de Scaleway-console. De DNS-zone
en de domeinnaam blijven staan tot de klant verhuist of de domeinnaam vervalt (zet dan autorenew uit bij
Openprovider).

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

## Juridisch en administratief (kort)

- **Reseller-voorwaarden**: lees de voorwaarden van Openprovider (houdergegevens moeten kloppen, je bent
  aanspreekpunt bij misbruik) en de gebruiksvoorwaarden van Scaleway en deSEC voor doorverkoop.
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
| `GET /v1/info` | Naam, bundels, links naar voorwaarden en privacy |
| `POST /v1/auth/start` `{email}` | Mailt een code van 6 cijfers (15 minuten, 5 pogingen) → 202 |
| `POST /v1/auth/verify` `{email, code}` | → `{token, customer}` (token 90 dagen geldig) |
| `GET /v1/domains/check?name=` | → `{domain, available, price}` |
| `POST /v1/orders` | `{bundle, domain:{mode,name,authCode?}, registrant?, acceptTerms:true}` → `{orderId, checkoutUrl}` |
| `GET /v1/orders/:id` | Status en stappen |
| `GET /v1/orders/:id/kit` | Het pakket (alleen als het klaar is; anders 409) |
| `GET /v1/me` | Klant en bestellingen |
| `POST /v1/orders/:id/cancel` | Opzeggen → `{ok, endsAt}` |
| `POST /v1/mollie/webhook` | Voor Mollie |
| `GET /betaald?order=` | Bedankpagina na betalen |
| `/v1/desec/domains/:zone/…` | DNS-proxy met `Authorization: Token <dns-token>` |
