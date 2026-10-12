# Adressendienst (gratis adressen)

De adressendienst (`src/adressen/`) geeft **gratis adressen** uit in één gedeelde zone, bijvoorbeeld
`vanes.eigencloud.nl`. Hij is centraal: alle aanbieders op de lijst (`aanbieders.json`) vragen hun namen hier
aan, zodat een klant zijn adres **houdt als hij van aanbieder wisselt**. Hij draait bij Rene (beheerder van de
repository), net als de lijst van aanbieders: als onderdeel van zijn eigen Dienst, op dezelfde server, opgezet en beheerd
vanuit de app. Zie ook ROLLEN.md (*Gratis adressen*) en BROKER.md (4b).

## Wat hij doet

Per naam, in het deSEC-account van de adressendienst:

1. maakt hij de zone `naam.eigencloud.nl` (deSEC staat geen subzone van een domein in een ander account toe,
   dus de zone kan niet bij de aanbieder staan);
2. zet hij in `eigencloud.nl` de verwijzing: `NS` naar `ns1.desec.io.`/`ns2.desec.org.` en de `DS`-records
   (DNSSEC);
3. maakt hij een deSEC-token dat **alleen in die ene zone mag schrijven** (token policies) en geeft dat aan
   de Dienst van de aanbieder. Die schrijft daarmee de records van de klant (via zijn DNS-proxy, acme-dns en
   de mailrecords);
4. maakt hij een **overdrachtscode** voor de klant (20 tekens, bijv. `ABCD-EFGH-JKLM-NPQR-STUV`). Die wordt
   één keer getoond (de Dienst zet hem in het pakket van de klant) en alleen als hash bewaard.

**Overstappen.** De nieuwe aanbieder vraagt de naam over met de code van de klant. De adressendienst trekt het
token van de oude aanbieder in, maakt een nieuw token voor de nieuwe, en vervangt de code (de oude werkt dan
niet meer). De zone met alle records blijft gewoon staan.

**Vrijgeven.** De huidige aanbieder (of de beheerder van de adressendienst, in de app) kan een naam vrijgeven: token weg, verwijzing weg,
zone weg (met alle records). Daarna is de naam **30 dagen in quarantaine** en pas dan weer uit te geven, zodat
niemand meteen mail voor de vorige eigenaar kan ontvangen.

De adressendienst ziet en bewaart geen klantgegevens: alleen de naam, welke aanbieder hem beheert (met diens
eigen kenmerk, bijv. het bestelnummer), het id van het token en de hash van de code. Alles komt in een logboek.

## Opzetten vanuit de app (aanbevolen)

De adressendienst draait mee op de server van een Dienst die je in de app opzet (BROKER.md, *Opzetten vanuit de app*).
Geen extra server, geen terminal.

1. **deSEC** (eenmalig, in de browser bij deSEC en je registrar):
   1. Een eigen deSEC-account voor de adressendienst (niet dat van je Dienst).
   2. Maak daar de gedeelde zone aan (bijv. `eigencloud.nl`) en zet bij de registrar de nameservers op
      `ns1.desec.io` en `ns2.desec.org`, met de DS-records van deSEC.
   3. Maak een token dat **tokens mag beheren** (*Manage tokens*, `perm_manage_tokens`) en zones mag maken en
      verwijderen. Behandel het als de sleutel tot alle gratis adressen.
   4. **Vraag deSEC om een hogere zonelimiet**: elk gratis adres is een zone in dit account.
2. **In de app**: *Aanbieder worden* → stap **Adres** → **Ook de gratis-adressendienst draaien**. Vul de gedeelde zone
   en het token in; het adres van de adressendienst is standaard `adressen.<domein>` (bij `dienst.esape.nl` dus
   `adressen.esape.nl`). De app controleert meteen bij deSEC of de zone in dit account staat (`GET /domains/<zone>/`) en
   of het token tokens mag beheren (`GET /auth/tokens/`).
3. **Opzetten** (of **Opnieuw opzetten** als je Dienst al draait). Op de server komt dan naast de Dienst:
   - de adressendienst (`node dist/adressen/main.js`, **hetzelfde image**, dus dezelfde rollende updates), op
     `127.0.0.1:4200`, met `/srv/dienst/adressen.env` (`ADRES_ZONE`, `ADRES_DESEC_TOKEN`, `ADRES_PUBLIC_URL`,
     `ADRES_LOKAAL_DIENST`) en zijn database in `/srv/dienst/adressen`;
   - Caddy met HTTPS voor het eigen adres van de adressendienst (zonder pad-voorvoegsel);
   - het A-record: valt het adres onder het domein van je cloud, dan zet je cloud het zelf (net als `dienst.<domein>`);
     anders laat de app zien welk record je zelf zet.
   - De Dienst praat er rechtstreeks mee (`BROKER_ADRES_URL=http://127.0.0.1:4200`) en neemt `adressen.sqlite` mee in
     zijn eigen versleutelde back-up (elk uur, `BROKER_BACKUP_ADRESSEN`). Bij opnieuw opzetten zet de nieuwe server de
     back-up terug vóórdat de adressendienst start (die wacht op de database van de Dienst, `ADRES_WACHT_OP`).
4. **Op de lijst**: in het beheer van je Dienst, **Op de lijst**, staat je regel met `"adressen": "https://adressen…"`.
   Als beheerder van het project zet je die op de standaardregel (zie CONTRIBUTING.md); daarmee vinden alle andere
   Diensten de adressendienst vanzelf.

**Je eigen Dienst wordt altijd vertrouwd.** De adressendienst kent de Dienst op dezelfde server (`ADRES_LOKAAL_DIENST`)
en leest diens publieke sleutel uit diens eigen `aanbieder.key` (`ADRES_LOKAAL_SLEUTEL`, alleen lezen). Je klanten kunnen
dus meteen een gratis adres nemen, ook voordat je regel op de lijst staat.

**Uitzetten** (stap Adres, vinkje uit, en Opnieuw opzetten) haalt de adressendienst van de server; zijn database blijft in
de back-ups. Let op: zolang hij op de standaardregel van de lijst staat, rekenen alle Diensten op hem.

## Aanbieders aansluiten

Een Dienst die met zijn eigen sleutel op de lijst staat, gebruikt vanzelf de adressendienst uit het veld `adressen` van
de standaardregel (hij kijkt bij het starten en daarna elk uur; `BROKER_LIST_URL`, `uit` = niet kijken). De aanbieder
hoeft dus niets in te stellen: alleen **Op de lijst** (zie CONTRIBUTING.md). De `url` in de lijst moet precies zijn
`BROKER_PUBLIC_URL` zijn. `BROKER_ADRES_URL` (in de app: *Accounts* → *Adressendienst*) gaat altijd voor.

## Beheer in de app

Draait de adressendienst op de server van je Dienst, dan staat in het beheer van je Dienst (alleen voor eigenaren) het
onderdeel **Adressendienst**: de gedeelde zone (en of die bij deSEC staat), alle adressen met hun aanbieder en kenmerk,
het logboek (per adres of alles), de aanbieders op de lijst met of hun sleutel klopt, en **Vrijgeven** van een adres
(token, verwijzing en zone weg; 30 dagen quarantaine). Het beheer gebruikt de ondertekende routes `/v1/beheer/…` van de
adressendienst, die alleen de Dienst op dezelfde server mag gebruiken.

## Zonder de app (Docker, voor gevorderden)

### Omgevingsvariabelen

| Variabele | Standaard | Wat |
|---|---|---|
| `ADRES_ZONE` | — (nodig) | De gedeelde zone, bijv. `eigencloud.nl` |
| `ADRES_DESEC_TOKEN` | — (nodig) | Token van het deSEC-account van de adressendienst (zie hierboven) |
| `ADRES_DESEC_URL` | `https://desec.io/api/v1` | |
| `ADRES_PORT` / `ADRES_HOST` | `4200` / `0.0.0.0` | Waar hij luistert |
| `ADRES_DATA_DIR` | `./data-adressen` | Database `adressen.sqlite` |
| `ADRES_LIST_URL` | `https://raw.githubusercontent.com/renevanes/own-cloud/main/aanbieders.json` | De lijst van aanbieders: een https-adres of een bestand op schijf. Wordt 5 minuten bewaard; een onbekende aanbieder laat hem (hooguit eens per minuut) opnieuw ophalen. Lukt ophalen niet, dan blijft de vorige lijst gelden |
| `ADRES_PUBLIC_URL` | `http://localhost:4200` | Eigen openbaar adres (voor het logboek bij het starten) |
| `ADRES_TRUST_PROXY` | `loopback,uniquelocal` | Welke proxy het IP-adres van de bezoeker mag doorgeven (voor de snelheidslimiet) |
| `ADRES_LOKAAL_DIENST`, `ADRES_LOKAAL_SLEUTEL` | uit | Adres en `aanbieder.key` van de Dienst op dezelfde server: altijd vertrouwd, en de enige die `/v1/beheer/…` mag gebruiken |
| `ADRES_WACHT_OP` | uit | Pas starten als dit bestand bestaat (de app gebruikt de database van de Dienst: die zet eerst de back-up terug) |

### Starten

```bash
npm ci && npm run build
node dist/adressen/main.js        # of tijdens ontwikkelen: npm run adressen
```

Met het bestaande Docker-image (dezelfde code, ander startcommando):

```bash
docker run -d --name adressen --restart unless-stopped \
  -v /srv/adressen:/data -e ADRES_DATA_DIR=/data --env-file /srv/adressen.env \
  -p 127.0.0.1:4200:4200 eigen-cloud:latest node dist/adressen/main.js
```

Zet er een reverse proxy met HTTPS voor, **zonder pad-voorvoegsel** (de handtekening gaat over het pad):
`adressen.eigencloud.nl { reverse_proxy 127.0.0.1:4200 }`. Maak dagelijks een back-up van `adressen.sqlite`
(`sqlite3 adressen.sqlite ".backup …"`): zonder database weet de dienst niet meer welke naam bij wie hoort.

### Beheer vanaf de opdrachtregel

Dezelfde omgevingsvariabelen en datamap als de dienst (in Docker: `docker exec adressen node dist/adressen/cli.js …`).
Vanuit de app opgezet? Gebruik dan het beheer in de app (hierboven).

```bash
npm run adressen:cli -- namen                     # alle namen: in gebruik (bij welke aanbieder), vrijgegeven
npm run adressen:cli -- vrijgeven <naam>          # laat zien wat er gebeurt
npm run adressen:cli -- vrijgeven <naam> --zeker  # token, verwijzing en zone weg; 30 dagen quarantaine
npm run adressen:cli -- aanbieders                # de lijst, met of elke sleutel klopt
npm run adressen:cli -- logboek [<naam>]          # laatste gebeurtenissen
```

## API

JSON; fouten als `{ "error": "…" }`. `:naam` mag `vanes` of `vanes.eigencloud.nl` zijn. Namen: 3 tot 32
letters, cijfers of streepjes, niet beginnend of eindigend met een streepje, niet `xn--…`, en niet gereserveerd
(`RESERVED_LABELS` in `src/broker/config.ts`: `www`, `mail`, `cloud`, `api`, `dienst`, …).

| Methode en pad | Ondertekend | Wat |
|---|---|---|
| `GET /v1/info` | nee | `{zone, nameservers}` |
| `GET /v1/naam/:label` | mag | `{naam, vrij}`. Zonder handtekening: 60 per minuut per IP-adres |
| `POST /v1/namen` `{label, ref?}` | ja | Nieuwe naam → `{naam, zone, token, overdrachtscode}`. 409 als hij bezet of in quarantaine is. Dezelfde aanvraag nog eens (zelfde aanbieder én zelfde `ref`, bijv. na een onderbroken poging) geeft een **nieuw** token en een nieuwe code; het vorige token wordt ingetrokken |
| `POST /v1/namen/:naam/controle` `{overdrachtscode}` | ja | `{naam, geldig}`, zonder iets te veranderen (de Dienst controleert zo vóór de betaling); hooguit 10 keer per uur per naam en aanbieder. 404 als de naam niet in gebruik is |
| `POST /v1/namen/:naam/overdragen` `{overdrachtscode, ref?}` | ja, door de **nieuwe** aanbieder | → `{naam, zone, token, overdrachtscode}`: oud token ingetrokken, nieuw token, nieuwe code. 403 bij een foute code (na 10 fouten per uur: 429). Dezelfde aanbieder met dezelfde `ref` nog eens mag zonder geldige code (de code is dan al vernieuwd) |
| `DELETE /v1/namen/:naam` | ja, door de **huidige** aanbieder | Vrijgeven → `{naam, vrijVanaf}`. 403 als de naam bij een andere aanbieder hoort |
| `GET /v1/beheer/status` · `GET /v1/beheer/namen` · `GET /v1/beheer/logboek?naam=` · `GET /v1/beheer/aanbieders` | ja, alleen door de Dienst op dezelfde server (`ADRES_LOKAAL_DIENST`) | Beheer: zone (en of die bij deSEC staat), aantallen, alle namen, logboek, de lijst met of elke sleutel klopt. Anders 403 |
| `POST /v1/beheer/namen/:naam/vrijgeven` | idem | Vrijgeven door de beheerder (ook als de naam bij een andere aanbieder hoort) → `{naam, vrijVanaf}` |

`ref` is een eigen kenmerk van de aanbieder (hooguit 100 tekens); de Dienst gebruikt het bestelnummer.
`zone` is de zone van de naam (gelijk aan `naam`); het `token` is een gewoon deSEC-token (`Authorization:
Token …` op `https://desec.io/api/v1/domains/<zone>/rrsets/…`).

Foutcodes: 400 ongeldige naam of body · 401 niet ondertekend, foute handtekening, klok wijkt af of verzoek al
eens gedaan · 403 aanbieder niet op de lijst, zonder sleutel, foute code of naam van een ander · 404 naam niet in
gebruik · 409 bezet · 429 te veel verzoeken · 502 deSEC werkt niet (opnieuw proberen) · 503 lijst van aanbieders
niet op te halen.

## Ondertekening

Elke aanbieder heeft een Ed25519-sleutelpaar (de Dienst maakt `aanbieder.key` in zijn datamap). De publieke
sleutel staat als `"sleutel"` (base64 van de SPKI-DER-vorm, begint met `MCowBQYDK2VwAyEA`) in `aanbieders.json`.

Elk ondertekend verzoek heeft drie headers:

| Header | Inhoud |
|---|---|
| `x-dienst` | Adres van de Dienst, gelijk aan `url` in `aanbieders.json` (hoofdletters en een slash aan het eind maken niet uit) |
| `x-tijd` | Unix-tijd in milliseconden |
| `x-handtekening` | base64 van de Ed25519-handtekening over de tekst hieronder |

De ondertekende tekst (regels gescheiden door `\n`):

```
<METHODE in hoofdletters>
<pad met query, precies zoals verstuurd, bijv. /v1/namen/vanes.eigencloud.nl/overdragen>
<x-tijd>
<sha256 (hex, kleine letters) van de body zoals verstuurd; bij geen body die van de lege tekst>
```

De adressendienst weigert het verzoek als de aanbieder niet op de lijst staat of geen geldige sleutel heeft
(403), als de handtekening niet klopt, als `x-tijd` meer dan 5 minuten afwijkt, of als dezelfde handtekening in
de afgelopen 10 minuten al eens gebruikt is (401). Voorbeeld (Node):

```js
import crypto from "node:crypto";
const key = crypto.createPrivateKey(fs.readFileSync("aanbieder.key"));
const body = JSON.stringify({ label: "vanes", ref: "bestelling-1" });
const tijd = String(Date.now());
const tekst = `POST\n/v1/namen\n${tijd}\n${crypto.createHash("sha256").update(body).digest("hex")}`;
const handtekening = crypto.sign(null, Buffer.from(tekst), key).toString("base64");
await fetch("https://adressen.eigencloud.nl/v1/namen", { method: "POST", body,
  headers: { "content-type": "application/json", "x-dienst": "https://dienst.vanes.nl", "x-tijd": tijd, "x-handtekening": handtekening } });
```

De code staat in `src/adressen/sign.ts` (gedeeld door de Dienst en de adressendienst).

## deSEC: aannames (nog niet tegen het echte deSEC getest)

De tests draaien tegen een nep-deSEC die deze aannames nabootst. Controleer ze bij de eerste echte installatie:

- **Controle in de app:** `GET /domains/<zone>/` (200 als de zone in dit account staat) en `GET /auth/tokens/` (200
  alleen met `perm_manage_tokens`, anders 403). Dat laatste is aangenomen, niet nagekeken.
- **Tokens maken:** `POST /auth/tokens/` met `{name, perm_manage_tokens: false, perm_create_domain: false,
  perm_delete_domain: false}` geeft 201 met `id` en (eenmalig) `token`. Het token van de adressendienst moet
  zelf `perm_manage_tokens` hebben. Of `perm_create_domain`/`perm_delete_domain` bestaan en wat hun standaard
  is, is niet nagekeken; onbekende velden zou deSEC moeten negeren.
- **Beleidsregels:** `POST /auth/tokens/{id}/policies/rrsets/`, eerst de standaardregel
  `{domain: null, subname: null, type: null, perm_write: false}`, daarna `{domain: "<naam>", subname: null,
  type: null, perm_write: true}`. Aangenomen: de meest specifieke regel geldt, en de standaardregel moet als
  eerste bestaan. Lukt een regel niet, dan verwijdert de dienst het token meteen weer.
- **Lezen:** zo'n token kan naar verwachting alle zones in het centrale account **lezen** (een regel beperkt
  alleen schrijven). Dat zijn openbare DNS-gegevens, maar wel de lijst van alle gratis adressen.
- **Intrekken:** `DELETE /auth/tokens/{id}/` (204; 404 = al weg).
- **Zones:** `POST /domains/` voor `naam.eigencloud.nl` in hetzelfde account als `eigencloud.nl` mag;
  `DELETE /domains/{naam}/` verwijdert hem. deSEC zet bij een subzone in hetzelfde account mogelijk zelf de
  verwijzing (NS/DS); de adressendienst zet hem toch zelf (`PUT …/rrsets/`, met lege `records` om weg te halen),
  dat is in beide gevallen goed.
- **Onderbroken aanvraag:** valt de dienst uit tussen het maken van een token en het bewaren van het id, dan
  blijft er een token over dat niemand kent (het geheim is nooit doorgegeven). Ruim zulke tokens af en toe op in
  het deSEC-account (naam `adres <naam>`).
