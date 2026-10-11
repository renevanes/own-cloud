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
- **providers**: inloggegevens per aanbieder (Hetzner, Scaleway, UpCloud, Exoscale, OVHcloud; velden per aanbieder in [PROVIDERS.md](PROVIDERS.md)). Test ze met `npm run eigen -- provider-test hetzner`.
- **dns**: deSEC-token (gratis, Berlijn), of DNS bij Hetzner, Scaleway, Exoscale of OVHcloud (`type` = id van de aanbieder; overige sleutels in `fields`). Zet bij je registrar de NS-records van die aanbieder (en eventueel een tweede).
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

## Meerdere gebruikers: schema en rollende updates

Een cloud kan meerdere gebruikers hebben (gezin, extra gebruikers), elk met eigen mail, agenda's en foto's. De
eigenaar is gebruiker 1 en staat **niet** in een tabel: zijn wachtwoord en adres blijven in `settings`
(`password_hash`, `mail_from`), zoals altijd. Extra gebruikers staan in de nieuwe tabel `users` (id 2, 3, …; een
verwijderde gebruiker blijft als lege rij staan zodat een id nooit opnieuw wordt uitgedeeld).

**Schemawijziging (src/userSchema.ts), alleen DDL, op elke server lokaal bij het starten:**

- `messages`, `calendars`: kolom `user_id INTEGER NOT NULL DEFAULT 1` via `ALTER TABLE … ADD COLUMN`. Bestaande rijen
  horen daarmee zonder één schrijfactie bij de eigenaar.
- `events`, `photos`, `albums`: tabel opnieuw opgebouwd (SQLite-procedure: zonder foreign keys, kopie, oude weg,
  hernoemen) met `user_id DEFAULT 1` en de unieke sleutel per gebruiker (`UNIQUE(user_id, uid)`, `(user_id, sha256)`,
  `(user_id, name)`), zodat twee mensen dezelfde uitnodiging, foto of albumnaam kunnen hebben. Rij-id's blijven gelijk.
  De kopie gaat buiten de triggers om, dus er komt niets in `_changelog`; elke server doet het zelf en komt op
  dezelfde inhoud uit.
- `messages`: unieke Message-ID per gebruiker (`messages_user_msgid`) in plaats van over de hele cloud.
- Nieuwe tabel `users`. Wordt vanzelf gerepliceerd (alle tabellen zonder `_` ervoor), maar pas beschreven als de
  eigenaar iemand toevoegt.

De migratie schrijft nooit rijen. Daardoor werkt ze ook op een volger (waar schrijven geblokkeerd is), en ze draait
ook bij **herstel uit de back-up** vóórdat de wijzigingen na de snapshot worden toegepast (`backup.ts`): een snapshot
van een oudere versie plus nieuwere wijzigingen geeft zo de juiste eigenaar per rij.

**Waarom dit veilig is tijdens een rollende update (oude en nieuwe servers naast elkaar):**

- Toepassen (`applyOne` in changelog.ts) gebruikt alleen kolommen die de ontvangende database kent. Een oude volger
  die een wijziging mét `user_id` krijgt, slaat die kolom over zonder fout; een nieuwe volger die een wijziging
  zonder `user_id` krijgt (van een oude leider), vult de standaard 1 in. Zolang er alleen een eigenaar is, is dat
  in beide richtingen precies goed.
- Een **onbekende tabel** laat het toepassen wel mislukken (de hele portie wordt teruggedraaid, niets half; de volger
  loopt achter tot hij is bijgewerkt). En een oude server zou `user_id` van een extra gebruiker negeren. Daarom:
  **gebruikers toevoegen kan pas als elke dataserver de nieuwe versie draait.** Elke server meldt in `nodeInfo` welke
  mogelijkheden hij heeft (`features: ["users"]`, oudere servers melden niets); de leider houdt die bij in
  `node_info` en weigert tot dan het toevoegen met een uitleg (`runtime.usersBlocked`, `updates.usersBlocked`).
  Vóór de eerste extra gebruiker is er niets dat een oude server verkeerd kan doen.
- Bestaande sessies blijven geldig: een token zonder gebruiker (`<verloopt>.<handtekening>`) is de eigenaar. Een
  extra gebruiker krijgt `<verloopt>.<id>-<generatie>.<handtekening>`; de generatie gaat omhoog bij een nieuw
  wachtwoord, uitschakelen of verwijderen, zodat oude sessies vervallen. Het eerste deel blijft de verlooptijd (de
  Android-app leest die).
- Mail die een volger als secundaire MX aanneemt, krijgt de ontvangers uit de SMTP-envelop mee als eerste regel
  (`X-Eigen-Envelope-To`), zodat de leider hem in de juiste mailbox(en) zet. Een oude leider ziet daar een extra
  kopregel in en zet het bericht bij de eigenaar: goed zolang er nog geen extra gebruikers zijn.
- Teruggaan naar een oudere versie nádat er extra gebruikers zijn, wordt niet ondersteund (die kent `users` niet).

Bestanden (mail, bijlagen, foto's) blijven op inhoud geadresseerd en versleuteld in de opslag zoals voorheen; van wie
iets is, staat alleen in de database. Twee gebruikers met dezelfde foto delen het bestand; een bestand wordt pas lokaal
weggehaald als geen enkele rij het meer gebruikt.

## Eerlijk over de grenzen

- **Live API's niet getest.** De adapters voor Hetzner, Scaleway, UpCloud, Exoscale en OVHcloud (zie [PROVIDERS.md](PROVIDERS.md)) volgen de API-documentatie en zijn getest tegen nagebootste API's, niet tegen echte accounts. Begin met `provider-test` en één handmatige `spawn` per aanbieder. De S3-client is getest tegen de officiële AWS-testvector en een S3-server (moto).
- **Mailreputatie.** Elke nieuwe server heeft een nieuw IP-adres. Bij Hetzner moet je poort 25 laten openzetten, en ook andere aanbieders blokkeren die vaak standaard. Gebruik daarom `SMTP_RELAY` (bijv. Scaleway TEM, Frans) voor uitgaande mail: dan maakt verhuizen niets uit voor je bezorging.
- **DNS-01-certificaten** vereisen het Caddy-image uit `Dockerfile.caddy` (modules `caddy-dns/desec`, `caddy-dns/hetzner` en, voor de Eigen Cloud Dienst, `caddy-dns/acmedns`). Met DNS bij Scaleway, Exoscale of OVHcloud gebruikt Caddy HTTP-01 (zie PROVIDERS.md). Controleer of je Hetzner-zone al naar de Cloud-API is gemigreerd.
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
