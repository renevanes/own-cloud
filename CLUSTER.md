# De slak — Eigen Cloud over meerdere Europese aanbieders

Eigen Cloud kan als **cluster** draaien: verspreid over meerdere soevereine Europese aanbieders, met automatische failover, zelfherstel, versleutelde back-ups, en de mogelijkheid om te **verhuizen**, te **vermenigvuldigen** en te **slapen**. Je richt het in met de **beheerconsole** (`npm run beheer`, zie de README) en bestuurt het daarna vanuit de app (tab **🐌 Waar draai ik**) of de console. De CLI `eigen` blijft beschikbaar voor wie dat prettig vindt.

```
            ┌──────────── DNS (deSEC + 2e aanbieder) ────────────┐
            │  cloud.<domein> / mail.<domein> → alle data-nodes  │
            └───────────────┬───────────────────────┬────────────┘
                            │                       │
   🇳🇱 Scaleway Amsterdam    ▼                       ▼   🇩🇪 Hetzner Falkenstein
   ┌───────────────────────────┐   wijzigingen   ┌───────────────────────────┐
   │ data-node  👑 leider      │ ──────────────▶ │ data-node  (warme stand-by)│
   │ schrijft · upload · jobs  │ ◀── stemmen ──▶ │ secundaire MX · leesreplica│
   └─────────────┬─────────────┘                 └─────────────┬─────────────┘
                 │            🇫🇮 witness (stemt alleen)        │
                 │            Hetzner Helsinki / thuis          │
                 ▼                                              ▼
   ┌──────────────── versleutelde object-opslag (S3) ─────────────────────────┐
   │ replica 🇳🇱 Scaleway   replica 🇩🇪 Hetzner   back-up 🇫🇮 UpCloud (onveranderbaar) │
   │ snapshots · wijzigingen (point-in-time) · bestanden · manifest            │
   └──────────────────────────────────────────────────────────────────────────┘
```

## Hoe het werkt

| Onderdeel | Werking |
|---|---|
| **Eén schrijver** | Leiderverkiezing volgens Raft. Met 2 data-nodes + 1 witness is er altijd een meerderheid zolang er 2 van de 3 bereikbaar zijn. |
| **Fencing in de database zelf** | Schrijven mag alleen tot `lease_until`, en dat wordt in SQLite-triggers gecontroleerd met de klok. Een leider die vastloopt of bevriest kan na het verlopen van zijn lease niets meer schrijven, ook niet via een ander proces (import, set-password). Andere nodes stemmen pas na `STICKY > LEASE`, dus twee schrijvers tegelijk kan niet. |
| **Replicatie** | Elke wijziging wordt via triggers vastgelegd in `_changelog` en semi-synchroon naar de stand-by gestuurd: een schrijfactie (of binnenkomende mail) wordt pas bevestigd als hij op 2 data-nodes staat (max. 3 s wachten). |
| **Afgezette leider** | Heeft hij nog niet-gerepliceerde wijzigingen, dan ziet hij dat bij terugkeer. Hij **bewaart zijn oude database** in `data/orphans/` en herstelt zichzelf vanaf de opslag. Getest met een bevroren leider. |
| **Doorsturen** | Elke data-node bedient de webapp. API-verzoeken op een volger gaan door naar de leider, en DNS wijst naar alle data-nodes. Failover hangt dus **niet** van DNS af. |
| **Mail** | `mail.<domein>` wijst naar alle data-nodes. Een volger neemt mail aan, zet die op schijf en geeft hem door aan de leider (secundaire MX). Tijdens slapen krijgen afzenders een `451` en proberen ze het tot ±5 dagen opnieuw. |
| **Opslag** | Snapshots + wijzigingssegmenten + bestanden, **versleuteld vóór verzending** (AES-256-GCM, sleutels afgeleid van jouw hoofdsleutel). Aanbieders zien alleen ruis. |
| **Back-up ≠ replica** | Opslag met `purpose: backup` wordt nooit opgeruimd. Zet daar versiebeheer/object-lock aan, met inloggegevens die alleen mogen schrijven. Foto's gaan eerst 30 dagen naar de prullenbak. |
| **Brandoefening** | Wekelijks (instelbaar) herstelt de leider de database uit **elke opslag apart**, doet een integriteitscontrole en controleert een steekproef van bestanden op hun SHA-256. Elke verhuizing is ook een herstel, dus test je back-up continu. |
| **Nieuwe servers** | Cloud-init bevat géén geheimen: alleen een download-link die na 2 uur verloopt en een eenmalige token. De echte configuratie staat versleuteld in de opslag en wordt na het aansluiten verwijderd. |
| **Jobs** | Vermenigvuldigen, verhuizen, verwijderen, slapen en brandoefening zijn duurzame jobs in de gerepliceerde database. Valt de leider halverwege weg, dan maakt de nieuwe leider de job af. |
| **Zelfherstel** | Is een node langer dan *X* min (standaard 15) onbereikbaar, dan zet de leider een vervanger bij een andere aanbieder of in een ander land, en verwijdert de oude. Zijn er te weinig nodes, dan vult hij aan. |
| **Kosten bewaken** | Elk half uur zoekt de leider bij elke aanbieder naar servers met het cluster-label die niet (meer) in het register staan, en ruimt die op. |

## Afhankelijkheden: wat kan wegvallen?

| Wegvallend | Gevolg | Opvang |
|---|---|---|
| Eén server | Niets merkbaar (bij leider: ±7–10 s schrijfpauze) | Failover + zelfherstel |
| Een hele aanbieder | Idem | Nodes en opslag staan bij verschillende aanbieders en in verschillende landen |
| Een opslag-aanbieder | Uploads naar die opslag wachten | De andere opslag loopt door; de achterstand wordt later ingehaald |
| DNS-aanbieder | Niets, zolang de tweede DNS werkt | Zones bij 2 aanbieders, beide door de app bijgewerkt |
| Docker Hub / GitHub | Niets | Images staan in je eigen opslag (`scripts/build-images.sh`) |
| Alle servers tegelijk | Uren, niet dagen | `eigen wake` herstelt uit de opslag; het cluster bouwt zichzelf weer op |
| Jouw laptop | Niets | De CLI is alleen nodig om te wekken; `eigen.json` staat in Bitwarden |
| **Je hoofdsleutel** | **Alles onleesbaar** | `eigen key` → op papier, op 2 plekken. Zonder sleutel geen herstel, ook niet door jou. |

## Starten met de beheerconsole (aanbevolen)

`npm run beheer` (of dubbelklik `beheer.cmd` op Windows). De assistent doet alles uit de stappen hieronder automatisch: hoofdsleutel maken en laten bevestigen, buckets aanmaken (de back-up met versiebeheer en object-lock), aanbieders testen en live prijzen ophalen, een plaatsing kiezen, het domein bij deSEC klaarzetten, de relay testen, en de eerste server starten met zichtbare voortgang.

Na de start blijft de console nuttig:
- **Wakker maken** als alles slaapt (de console is dan het enige dat nog "leeft" — draai hem eventueel op een Raspberry Pi thuis).
- **Back-up testen vanaf je eigen computer**: herstel uit elke opslag, buiten het cluster om.
- **Database downloaden** (ook naar een eerder moment).
- **Instellingen**: wijzigingen in opslag, aanbieders, DNS of relay worden ondertekend naar het draaiende cluster gestuurd.
- **Herstellen op een nieuwe computer** met alleen je herstelsleutel en de gegevens van één opslag: de console bewaart een versleutelde kopie van zijn configuratie in je opslag.

## Starten met de CLI (alternatief)

### 1. Beheerconfiguratie

```bash
npm install
npm run eigen -- init eigen jouwdomein.nl     # maakt eigen.json + hoofdsleutel → schrijf hem op papier
```

Vul in `eigen.json` in:

- **stores**: maak buckets aan bij minstens 2 aanbieders in 2 landen (S3-compatibel: Hetzner Object Storage, Scaleway, UpCloud, OVH, Exoscale). Zet bij de back-up-bucket **versiebeheer + object-lock** aan.
- **providers**: API-tokens (Hetzner Cloud, Scaleway, UpCloud). Test ze met `npm run eigen -- provider-test hetzner`.
- **dns**: deSEC-token (gratis, Berlijn). Zet bij je registrar de NS-records van deSEC (en eventueel een tweede aanbieder).
- **policy.placement**: waar nodes mogen komen, op volgorde van voorkeur. Het voorbeeld spreidt over NL (Scaleway Amsterdam), DE (Hetzner) en FI (UpCloud/Hetzner Helsinki).
- **appEnv**: `SMTP_RELAY` (aanbevolen, zie hieronder).

Bewaar `eigen.json` in Bitwarden: het bevat de hoofdsleutel en alle tokens.

### 2. Images in je eigen opslag

```bash
EIGEN_CONFIG=eigen.json scripts/build-images.sh    # vereist Docker op je laptop
```

### 3. Eerste node

Nieuw cluster:

```bash
npm run eigen -- wake scaleway nl-ams-1 DEV1-S
```

Of maak van je bestaande losse server de eerste node: draai op de server `npm run eigen -- first-node <publiek-ip>` en herstart de app.

Binnen een paar minuten vult het cluster zich zelf aan tot het aantal in `policy` (standaard 2 data-nodes + 1 witness). Volg het in **🐌 Waar draai ik**.

### 4. Dagelijks gebruik

| Wil je… | Doe |
|---|---|
| zien waar alles draait | tab **🐌 Waar draai ik** of `npm run eigen -- status` |
| verhuizen (bijv. alles naar NL) | ↪ Verhuizen op een node-kaart. Nieuwe node erbij → bijwerken → leiderschap overdragen → oude weg |
| extra kopie | + Data-node |
| kosten naar bijna nul | 😴 Slapen. Alles wordt weggeschreven en gecontroleerd, daarna gaan alle servers weg |
| wakker maken | `npm run eigen -- wake` (kiest standaard de plek uit het manifest) |
| iets terughalen van gisteren | `npm run eigen -- restore herstel.sqlite --until 2026-10-08T14:00` |
| back-ups testen | 🧯 Brandoefening, of `npm run eigen -- drill` vanaf je laptop |
| nieuwe versie uitrollen | gaat vanzelf (zie hieronder), of **Nu bijwerken** onder 🐌 Waar draai ik → Software |

## Bijwerken naar een nieuwe versie

Elke build op `main` maakt nieuwe images met een versienummer (`<package.json-versie>.<bouwnummer>`). De leider kijkt
elke 6 uur in de registry (het pakket moet op openbaar staan) of er een nieuwere versie is, en doet dan wat jij
hebt ingesteld onder **🐌 Waar draai ik → Software**:

| Stand | Wat er gebeurt |
|---|---|
| Automatisch bijwerken (standaard) | 's nachts tussen 03:00 en 05:00 (instelbaar) |
| Alleen melden | melding in de gebeurtenissen en bij Gezondheid; jij kiest **Nu bijwerken** |
| Uit | niet kijken, niet bijwerken |

Zo gaat een update:

1. Alleen als alle servers gezond zijn. De doelversie ligt vast als `image@sha256:…`, zodat elke server precies
   hetzelfde krijgt, ook servers die tijdens de update nieuw worden aangemaakt.
2. Eén server tegelijk: eerst de witness, dan de andere dataservers, de leider als laatste (na het overdragen van
   de leiding). Je cloud blijft al die tijd werken.
3. **Op de plek zelf**: de app vraagt de updater op de server (`/opt/eigen/eigen-update.sh`, door cloud-init
   geïnstalleerd, gestart via systemd) om de nieuwe images te laden. Die accepteert alleen vaste versies uit de
   eigen registry-map, start ze, en kijkt tot 5 minuten of de server gezond terugkomt met de nieuwe versie. Zo
   niet, dan zet hij zelf de vorige versie terug, stopt de update en blijven de andere servers onaangeroerd.
   Hetzelfde IP-adres, geen gegevens kopiëren.
4. Servers van vóór deze functie (zonder updater) worden **vervangen** door een nieuwe server met de nieuwe versie.
5. De eerste dataserver bewaart de nieuwe images ook in je eigen opslag (`images/…`), zodat nieuwe servers ook
   zonder de registry kunnen starten.

Let op bij het ontwikkelen: een update laat oude en nieuwe versies even naast elkaar draaien. Wijzigingen aan de
databasestructuur moeten dus met oude volgers kunnen leven (nieuwe kolommen of tabellen pas gebruiken als alle
servers zijn bijgewerkt).

## Eerlijk over de grenzen

- **Live API's niet getest.** De adapters voor Hetzner, Scaleway en UpCloud volgen de API-documentatie en zijn getest tegen nagebootste API's, niet tegen echte accounts. Begin met `provider-test` en één handmatige `spawn` per aanbieder. De S3-client is getest tegen de officiële AWS-testvector en een S3-server (moto).
- **Mailreputatie.** Elke nieuwe server heeft een nieuw IP-adres. Bij Hetzner moet je poort 25 laten openzetten, en ook andere aanbieders blokkeren die vaak standaard. Gebruik daarom `SMTP_RELAY` (bijv. Scaleway TEM, Frans) voor uitgaande mail: dan maakt verhuizen niets uit voor je bezorging.
- **DNS-01-certificaten** vereisen het Caddy-image uit `Dockerfile.caddy` (modules `caddy-dns/desec`, `caddy-dns/hetzner` en, voor de Eigen Cloud Dienst, `caddy-dns/acmedns`). Controleer of je Hetzner-zone al naar de Cloud-API is gemigreerd.
- **deSEC** hanteert standaard een minimale TTL van 1 uur. Dat is geen probleem voor failover (die hangt niet van DNS af), alleen voor het toevoegen van nieuwe IP-adressen.
- **Witness**: elke node die stemt maar geen data heeft volstaat, dus ook een Raspberry Pi thuis in Rotterdam (`kind: "witness"`, handmatig).
- **De aanbieder van een draaiende server** kan in theorie altijd bij het geheugen. Versleuteling beschermt je opslag, je back-ups en de perioden waarin alles slaapt.
- **Tijd**: de nodes vergelijken tijdstempels (±60 s), dus NTP moet aan staan. Cloud-init installeert chrony.

## Testen

```bash
npm test                      # alle tests, waaronder end-to-end tests van het cluster, de console, de dienst en het bijwerken
SKIP_CLUSTER=1 npm test       # zonder de clustertest
```

De clustertest start echte processen (lokale "aanbieder") en doorloopt: vermenigvuldigen → repliceren → doorsturen → bestanden → secundaire MX → leider doden (failover) → zelfherstel → leider bevriezen met een niet-gerepliceerde schrijfactie (fencing + zelfherstel van de oude leider) → herstel naar een tijdstip → brandoefening → tijdmachine → de leider zelf verhuizen → slapen → wekken.
De consoletest doorloopt de hele assistent tot een draaiend cluster, stuurt een instelling door, test de back-up, laat slapen, wekt (en controleert dat de data terug is) en herstelt op een "nieuwe computer" met alleen de sleutel.
