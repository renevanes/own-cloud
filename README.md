# Eigen Cloud — mail, agenda en foto's in eigen beheer

Je eigen vervanger voor Gmail, Google Agenda en Google Foto's, op servers die jij kiest bij Europese aanbieders. Je cloud bewaakt, herstelt en verhuist zichzelf, en kan gaan slapen als je hem even niet nodig hebt. Alles is te regelen via een gewone webinterface; je hebt geen opdrachtregel nodig.

| Onderdeel | Wat het doet |
|---|---|
| **Mail** | Eigen SMTP-server, DKIM, mappen, Gmail-labels, gesprekken, zoeken en bijlagen; bewaarde concepten en Postvak uit met status per ontvanger. Optionele spamcontrole en mailregels. HTML-mail heeft geen scripts; externe afbeeldingen zijn standaard geblokkeerd. |
| **Agenda en contacten** | Meerdere agenda's, terugkerende afspraken, herinneringen, `.ics` import/export, privé iCal-feed, contacten en CalDAV/CardDAV voor andere apps. Agenda's kunnen gedeeld worden. |
| **Foto's** | Upload, thumbnails, EXIF/GPS, tijdlijn, favorieten, gedeelde albums, video's, ontdubbeling, kaart, handmatige tags en lokale tekstherkenning. |
| **Overstappen** | Sleep je Google Takeout-zips in de browser: mail (met labels), agenda's en foto's (met Google's metadata en albums) komen er in één keer in. Hervat vanzelf na een verbroken verbinding. |
| **Gezondheid** | Controleert elk kwartier je DNS, mailbeveiliging (SPF, DKIM, DMARC, reverse DNS), certificaat, back-ups en servers. Repareert wat kan zelf, en mailt je anders wat er moet gebeuren. |
| **Tijdmachine** | Kies een moment in het verleden en zet per ongeluk verwijderde of veranderde mails, afspraken en foto's terug. |
| **Beheerconsole** | Installatie-assistent op je eigen computer of je telefoon: kluis met je sleutels, opslag en servers koppelen (met live prijzen), domein, mail, en daarna een overzicht met kaart, wekken, slapen en herstellen, en *Kosten*: een schatting per aanbieder en in totaal per maand (servers en opslag; slapend alleen opslag), met een budget waarboven je een melding per mail krijgt. |
| **Naast Gmail** | Proefperiode *naast Gmail* (je mail komt nog bij Gmail binnen en wordt elke paar minuten opgehaald) of *Gmail als vangnet* na het overstappen. Instellingen → Gmail. |
| **Bijwerken** | Servers werken zichzelf 's nachts bij naar de nieuwste versie, één voor één, en zetten zichzelf terug als de nieuwe versie niet goed opstart. Zie [CLUSTER.md](CLUSTER.md#bijwerken-naar-een-nieuwe-versie). |
| **Android-app** | Alles van de webapp, plus automatische foto-back-up, je agenda in de agenda-app van je telefoon, meldingen bij nieuwe mail of problemen, *Delen → Eigen Cloud*, en de beheerconsole met vingerafdruk-ontgrendeling. Zonder Google-diensten. Zie [android/README.md](android/README.md). |

> Het eerdere Lovable-project uit deze repository staat bewaard in de branch `archief/lovable`.

Techniek: Node.js 22 + TypeScript, Fastify, SQLite (één bestand, makkelijk te back-uppen), sharp/ffmpeg, Caddy voor automatische HTTPS. Webapp werkt op telefoon en is als app op je startscherm te zetten.

---

## Snel starten

**Wat je nodig hebt**
- Een eigen domeinnaam (bijvoorbeeld bij een Nederlandse registrar).
- Een account bij één of meer Europese aanbieders: [Scaleway](https://console.scaleway.com) (Amsterdam), [Hetzner](https://console.hetzner.com) (Duitsland/Finland), [UpCloud](https://hub.upcloud.com), [Exoscale](https://portal.exoscale.com) (Zwitserland, Duitsland, Oostenrijk) of [OVHcloud](https://www.ovhcloud.com/nl/public-cloud/) (Frankrijk, Duitsland, Polen). Bij dezelfde aanbieders koop je ook de opslag voor back-ups. Welke aanbieder wat kan, en hoe je er zelf een toevoegt: [PROVIDERS.md](PROVIDERS.md).
- Een gratis account bij [deSEC](https://desec.io) voor DNS (aanbevolen).
- Optioneel: een mail-relay (Scaleway TEM of Brevo), en een e-mailadres buiten je nieuwe domein voor meldingen.

**Zo start je**
1. Installeer [Node.js 22](https://nodejs.org) op je computer.
2. Pak deze map uit. Op Windows dubbelklik je **`beheer.cmd`**; op Mac/Linux draai je `npm install && npm run beheer`.
3. Je browser opent de beheerconsole. Volg de stappen:
   - **Jij en je domein** — domein, e-mailadres, inlogwachtwoord (of *Genereer een sterk wachtwoord*), meldadres en een wachtwoordzin voor de kluis.
   - **Herstelsleutel** — schrijf hem op of druk het herstelblad af.
   - **Opslag** — koppel een werkkopie en een back-up, bij voorkeur in twee landen. Buckets, versiebeheer en object-lock worden automatisch ingesteld.
   - **Servers** — koppel aanbieders; je kiest daarna *Alles in Nederland*, *Nederland en Duitsland* of *Spreid over Europa*, met de actuele maandprijs erbij.
   - **Domein** — de console zet het domein klaar bij deSEC en vertelt welke nameservers je bij je registrar invult.
   - **Mail versturen** — relay testen met een testbericht.
   - **Starten** — één klik. Binnen ±10 minuten draait je cloud op drie servers.
4. Open je cloud, ga naar **Instellingen → Importeren uit Google** en sleep je Takeout-bestanden erin.

**Waar draait je cloud?** In stap 3 kies je hoe: *Wij regelen alles* (de Eigen Cloud Dienst: geen accounts en geen sleutels, met een gratis adres of je eigen domein, betalen met iDEAL), of *één sleutel bij Scaleway*: je maakt zelf een account, kopieert één API-sleutel, en de console zet opslag, servers en mail klaar. Wie aanbieders wil combineren kiest *Zelf per onderdeel*. In elke stap kun je terug, of opnieuw beginnen (desgewenst ruimt de console dan ook op wat al bij de aanbieder is aangemaakt).

**Geen domein of accounts?** Kies in de eerste stap *Gratis adres*: de console maakt dan zelf een gratis account bij [deSEC](https://desec.io) (open source, non-profit) met een naam als `vanes.dedyn.io` — je typt alleen een plaatje over en klikt op de link in je mail. Wil je niets zelf afsluiten, kies dan in de stap *Waar je cloud draait* een abonnement bij de **Eigen Cloud Dienst**: die regelt je domein, DNS, servers, opslag en mail-relay in één bedrag per maand, betaald met iDEAL. Je herstelsleutel blijft ook dan alleen bij jou. Zie [BROKER.md](BROKER.md) voor wie de dienst aanbiedt.

**Liever vanaf je telefoon?** Installeer de [Android-app](android/README.md) en kies *Nieuwe Eigen Cloud opzetten*: dezelfde stappen, maar zonder wachtwoorden te bedenken of te typen. De kluis met je sleutels zit achter je **vingerafdruk** (vanaf Android 11 ook de pincode van je telefoon); een wachtwoordzin kan nog steeds (*Liever een wachtwoordzin*). Het wachtwoord van je cloud maakt de app zelf, bewaart het in de kluis en logt er na het starten zelf mee in; nodig voor een andere app, dan toon je het met je vingerafdruk. Sleutels van aanbieders plak je met één tik (*Plakken*; de app maakt het klembord daarna leeg). Je herstelsleutel blijft de weg terug: op een nieuwe telefoon, of als je vingerafdrukken veranderen. Zie [TRUST.md](TRUST.md).

Bewaar het bestand `~/.eigen-cloud/kluis.json` gerust in je back-up of synchronisatiemap: het is versleuteld met je wachtwoordzin. (Op de computer blijft de wachtwoordzin; inloggen met een vingerafdruk of passkey (WebAuthn) in de browser zit er niet in.) Op een andere computer of telefoon kies je in de console **Ik heb al een Eigen Cloud** en vul je je herstelsleutel en de gegevens van één opslag in (de bucketnaam mag je leeg laten; de console zoekt hem zelf). Heb je een abonnement bij de Eigen Cloud Dienst, dan is het nog eenvoudiger: **Herstellen via de Eigen Cloud Dienst** vraagt alleen je e-mailadres, de code uit de mail en je herstelsleutel.

**Abonnement beheren** doe je in de console zelf (paneel *Abonnement* op het overzicht): facturen bekijken en afdrukken, een andere bundel kiezen (je cloud krijgt meteen de nieuwe aantallen servers), je betaalmethode wijzigen, een mislukte incasso alsnog betalen, opzeggen of het opzeggen terugdraaien, en de verhuiscode van je domein opvragen. In de app opent de betaalpagina van Mollie in de app zelf en springt je bank-app vanzelf open.

**Overstappen naar een andere aanbieder** (of naar zelf beheren) doe je ook in het paneel *Abonnement*: kies
**Overstappen**, dan een aanbieder van de lijst of *Zelf beheren* (je eigen Scaleway-sleutel en een deSEC-token). De
console laat eerst zien wat er gebeurt en hoe lang je cloud ongeveer offline is. Bij een nieuwe aanbieder log je daar in,
kies je een bundel en betaal je; met **Nu overzetten** gaat je cloud slapen, gaan je gegevens versleuteld naar de nieuwe
opslag, wordt hij daar wakker en zegt de console je oude abonnement op. Je adres gaat mee: een gratis adres van de
adressendienst met de overdrachtscode, een eigen domein doordat je oude aanbieder de DNS vrijgeeft (gebruik je DNSSEC,
zet dan daarna de nieuwe DS-records bij je registrar), een domein dat via je oude aanbieder geregistreerd is met de
verhuiscode. Gaat er iets mis vóór je cloud bij de nieuwe plek draait, dan zet **Terug naar …** alles terug; de opslag
van je oude aanbieder blijft tot het einde onaangeroerd. Het overstappen gaat na een herstart van de console of de app
verder waar het was. Een gratis adres dat alleen bij je oude aanbieder hoort (`BROKER_FREE_ZONE`) kan niet mee.

**Zelf aanbieder worden?** Kies op het startscherm van de app of de console **Aanbieder worden** (in de console ook
bovenaan, op elk scherm). Een eigen cloud is daarvoor niet nodig: de console maakt dan een kluis alleen voor je Dienst
(vingerafdruk of wachtwoordzin, en een herstelsleutel, zoals bij een cloud). Vul je bedrijfsgegevens in, koppel je accounts (Scaleway, Mollie,
deSEC, mail), kies het adres en wie het in de DNS zet (je cloud, een DNS-aanbieder zoals deSEC, Scaleway, Hetzner,
Exoscale of OVHcloud, waarbij de console het record zelf zet en bijwerkt, of jijzelf), en de console zet je eigen Eigen
Cloud Dienst op een server bij de aanbieder en in de regio die je kiest (Scaleway, Hetzner, UpCloud, Exoscale of
OVHcloud; de back-ups mogen elders), met elk uur een versleutelde back-up en automatische updates.

Het eerste scherm is **Wat je nodig hebt**: per onderdeel (domein, DNS, server, Scaleway, Mollie, mail, deSEC, en
optioneel Openprovider en de gratis-adressendienst; plus voorwaarden en *Op de lijst*) of het geregeld is (✓, ! of ○),
wat het is, wat het ongeveer kost en een knop **Regelen**. Wat via een koppeling kan, doet de app: met één eigen
Scaleway-sleutel maakt hij een eigen sleutel met alleen de nodige rechten voor je Dienst (en gooit de jouwe weg), hij
maakt een deSEC-account, leest bij Mollie wat er nog aan moet, zet de mail van je Dienst bij Scaleway op (met de records
in je DNS), zet nameservers en DNSSEC goed en koopt een domein bij Openprovider (na je bevestiging, met de prijs), en zet
het IP-adres van je server op de lijst bij Openprovider. Een account openen (met je naam, betaalgegevens of een
ID-controle) doe je zelf; de app opent de juiste pagina en ziet daarna zelf dat het gelukt is. Dezelfde lijst staat later
in *Je dienst*, en bij de stap *Accounts* openen dezelfde hulpjes in een venster (bijv. **Nog geen deSEC-account? Laat de
app er een maken**). Een premium-domein (met een hogere prijs) koopt de app niet; dat doe je in het controlepaneel van
Openprovider. Bovenaan kies je **Zo gratis mogelijk beginnen** (een gratis adres `naam.dedyn.io` bij deSEC, een server op
starttegoed bij UpCloud of Exoscale, gratis mail via Scaleway; als het tegoed bijna op is verhuist de app je Dienst met
één tik naar de goedkoopste betaalde server) of **Standaard**; zie [BROKER.md](BROKER.md#gratis-beginnen).

Daarna is er één plek voor alles: **Je dienst** (op het startscherm van de app: *ESAPE beheren*, met de naam van je
Dienst). Overzicht (status, versie, klanten, omzet), Bedrijf, Accounts en sleutels, Adressendienst (ook de zonelimiet bij
deSEC), Server en back-ups (andere plek, DNS, hersteltest, opnieuw opzetten), Kosten en Updates regel je daar; Aanbod en
prijzen (ook waar de servers van elke bundel staan), Huisstijl, Medewerkers, Klanten, Hulpvragen en Berichten openen het
beheer van je Dienst meteen op die pagina. **Voorwaarden en privacy**: je Dienst host je voorwaarden, privacyverklaring en
verwerkersovereenkomst zelf; in het beheer maak je met één tik een voorbeeld uit je gegevens (geen juridisch advies: laat
het nakijken). **Op de lijst**: GitHub koppelen en *Aanmelden voor de lijst*; de app maakt het voorstel op GitHub. Wat je wijzigt en nog niet op je Dienst staat, zie je bovenaan, met **Wijzigingen
toepassen** (zonder nieuwe server). Een terminal is niet nodig. Beheerders van het project kunnen ook de
**gratis-adressendienst** laten meedraaien (zelfde server). Zie
[BROKER.md](BROKER.md#opzetten-vanuit-de-app-zonder-terminal) en [ADRESSEN.md](ADRESSEN.md).

**Welke aanbieder biedt de app aan?** De lijst `aanbieders.json` in deze repository. De regel met `"standaard": true`
(nu ESAPE) staat vooraan, maar alleen zolang die Dienst antwoordt; anders toont de app hem als *Nog niet beschikbaar* en
regel je het zelf. Zie [CONTRIBUTING.md](CONTRIBUTING.md#op-de-lijst-van-aanbieders).

**Bijwerken gaat vanzelf**: servers werken zichzelf rollend bij (zie [CLUSTER.md](CLUSTER.md)) en de Android-app haalt nieuwe versies op van ghcr.io, of van je eigen cloud als dat niet lukt.

Meer over hoe het cluster werkt: [CLUSTER.md](CLUSTER.md).

---

## Handmatig: één losse server (voor gevorderden)

Wil je geen cluster maar één server die je zelf beheert, dan kan dat ook. Je mist dan automatische back-ups, de tijdmachine en zelfherstel.

### 1. Server bij Hetzner

1. Maak een Cloud-server: **CX22** of groter, Ubuntu 24.04, locatie Falkenstein/Nürnberg/Helsinki. Voor veel foto's: koppel een **Volume** (bijv. 500 GB) en zet `data/` daarop.
2. **Poort 25 openzetten:** Hetzner blokkeert uitgaande poort 25 standaard bij nieuwe accounts. Vraag na je eerste betaalde factuur via de Cloud Console een *"Request to unblock port 25"* aan. Tot die tijd: zet `SMTP_RELAY` (bijv. Amazon SES) in `.env`.
3. **Reverse DNS (PTR):** zet in de Cloud Console de reverse DNS van het IPv4-adres op `mail.jouwdomein.nl`. Zonder dit wordt je mail vaak als spam gezien.
4. Installeer Docker:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```

### 2. DNS-records

Vervang `jouwdomein.nl` en `1.2.3.4` door je eigen domein en server-IP:

| Type | Naam | Waarde |
|---|---|---|
| A | `cloud.jouwdomein.nl` | `1.2.3.4` |
| A | `mail.jouwdomein.nl` | `1.2.3.4` |
| MX | `jouwdomein.nl` | `10 mail.jouwdomein.nl` |
| TXT | `jouwdomein.nl` | `v=spf1 mx -all` *(met SES: `v=spf1 mx include:amazonses.com -all`)* |
| TXT | `eigen._domainkey.jouwdomein.nl` | *(output van stap 3 hieronder)* |
| TXT | `_dmarc.jouwdomein.nl` | `v=DMARC1; p=quarantine; rua=mailto:rene@jouwdomein.nl` |

### 3. Installeren

```bash
git clone <deze repo> eigen-cloud && cd eigen-cloud
cp .env.example .env
nano .env                                   # domein, adres, SESSION_SECRET en ICAL_TOKEN invullen (openssl rand -hex 32)
node scripts/dkim.mjs eigen jouwdomein.nl   # maakt DKIM-sleutel + toont het DNS-record
docker compose up -d --build
docker compose exec app node dist/setPassword.js   # je inlogwachtwoord instellen
```

Open `https://cloud.jouwdomein.nl` en log in. Caddy haalt automatisch certificaten op. Na de eerste start van Caddy éénmalig `docker compose restart app`, zodat de mailserver het certificaat voor STARTTLS oppakt (en daarna eens per maand, bijv. via cron).

Test je mail-setup met [mail-tester.com](https://www.mail-tester.com) — streef naar 10/10.

### 4. Je Google-data verhuizen

1. Ga naar [takeout.google.com](https://takeout.google.com), kies **Mail**, **Agenda** en **Google Foto's**, exporteer als `.zip` (kies 50 GB per bestand).
2. Zet de bestanden op de server (bijv. `scp` naar `~/takeout/`) en pak uit: `unzip '*.zip' -d ~/takeout/uitgepakt`
3. Importeer (kan uren duren bij grote archieven; opnieuw draaien is veilig, dubbelen worden overgeslagen):

```bash
T=~/takeout/uitgepakt/Takeout
docker compose run --rm -v $T:/takeout app node dist/import/cli.js gmail  "/takeout/Mail/All mail Including Spam and Trash.mbox"
docker compose run --rm -v $T:/takeout app node dist/import/cli.js agenda "/takeout/Calendar"
docker compose run --rm -v $T:/takeout app node dist/import/cli.js fotos  "/takeout/Google Photos"
```

> De mapnamen kunnen Nederlands zijn (bijv. `Agenda`, `Google Foto's`) — kijk even met `ls $T`.

4. **Overstappen:** zet daarna de MX-records om (stap 2). Zet in Gmail een doorsturing naar je nieuwe adres voor mensen die nog je oude adres gebruiken.

### 5. Op je telefoon

- **Android-app:** zie [android/README.md](android/README.md) — met foto-back-up, agenda in je telefoon en meldingen.
- **Webapp:** open `https://cloud.jouwdomein.nl` in Chrome → menu → *Toevoegen aan startscherm*.
- **Agenda in je telefoonagenda:** abonneer je op `https://cloud.jouwdomein.nl/ical/<ICAL_TOKEN>/agenda.ics` (bijv. met de app *ICSx⁵*). Afspraken maak je in de webapp; de feed is alleen-lezen.
- **API voor een eigen app** (bijv. een module in Rene's Tools): `POST /api/login` geeft een `token`; stuur daarna `Authorization: Bearer <token>` mee. Endpoints staan in `src/*/routes.ts`.

### 6. Back-ups

Alles staat in `data/`. Simpelste aanpak: Hetzner **Storage Box** + dagelijkse `restic`- of `borg`-back-up van `data/`. Maak voor de database een consistente kopie:

```bash
sqlite3 data/eigen-cloud.sqlite ".backup data/backup.sqlite"
```

## 7. Ontwikkelen

```bash
npm install
npm run set-password
npm run dev          # http://localhost:3000, SMTP op poort 2525
npm run beheer       # beheerconsole op http://localhost:4000
npm run dienst       # de Eigen Cloud Dienst van een aanbieder, zie BROKER.md (aanbieders zetten hem op vanuit de app)
npm run adressen     # de gratis-adressendienst, zie ADRESSEN.md
npm test             # mail, agenda, foto's, import, instellingen, gezondheid, versleuteling, Gmail,
                     # replicatie, aanbieders, cluster end-to-end en de console end-to-end
android/core/test.sh # Java-kern van de Android-app tegen de TypeScript-code, moto (S3) en een echte cluster-node
android/compile-check.sh  # app-code compileren tegen de Android-API (zonder Android Studio)
```

## Versies

Eén versienummer voor de app en de servers, en bij elke wijziging omhoog: 1.1, 1.2, … Wat er per versie nieuw is
staat in [changelog.json](changelog.json); de app toont het na een update. Elke versie heeft een eigen
[release](https://github.com/renevanes/own-cloud/releases) met de APK. Werkwijze: `scripts/bump.sh "wat er veranderd is"`
en daarna `scripts/publish.sh` (zie [android/README.md](android/README.md#versies)).

## Gezin en extra gebruikers

Account biedt een authenticator, herstelcodes, apparaatbeheer en aparte sync-wachtwoorden.
Offline opslag is optioneel en alleen geschikt voor een vertrouwd apparaat. Met Export
download je je eigen gegevens en originelen, inclusief een controlelijst van alle bestanden.
Zie [de overgang en functies van 1.17](RELEASE-1.17.md) en [het toegangs- en versleutelingsmodel](TRUST.md).

Iedereen in je cloud heeft een eigen mailadres (`naam@jouwdomein`), wachtwoord, agenda's en foto's. Gebruikers zien
elkaars gegevens alleen via geaccepteerde gedeelde agenda's of albums. De eerste gebruiker is de eigenaar: die voegt onder **Instellingen → Gebruikers** mensen toe (met
een eerste wachtwoord of een uitnodigingslink), zet wachtwoorden opnieuw, schakelt iemand uit of verwijdert iemand
met al zijn gegevens. Servers, domein, mailinstellingen en Gmail-koppeling blijven bij de eigenaar. Het maximum komt
uit de instelling `max_users` (leeg of 0 = onbeperkt). Mail naar onbekende adressen op je domein komt zoals altijd
bij de eigenaar binnen. Hoe dit met het cluster samengaat staat in [CLUSTER.md](CLUSTER.md#meerdere-gebruikers-schema-en-rollende-updates).

## Meerdere servers, verhuizen en slapen

Zie **[CLUSTER.md](CLUSTER.md)**: Eigen Cloud als cluster over meerdere Europese aanbieders, met failover, zelfherstel, versleutelde back-ups (ook naar een tijdstip), verhuizen, en slapen/wekken.

## Nog niet ingebouwd (logische volgende stappen)

- **Spamfilter** — nu komt alles in de inbox. Volgende stap: SPF/DKIM-controle bij ontvangst en/of Rspamd ervoor zetten.
- **Live-test bij de aanbieders** — de koppelingen met Hetzner, Scaleway, UpCloud, Exoscale en OVHcloud volgen hun API-documentatie maar zijn nog niet tegen echte accounts gedraaid (zie [PROVIDERS.md](PROVIDERS.md) wat per aanbieder nog onzeker is). De console test inloggen en prijzen ophalen meteen bij het koppelen.
- **IMAP** — CalDAV/CardDAV zijn beschikbaar; bestaande IMAP-mailapps worden nog niet ondersteund.
- **Directe push-meldingen** — de app kijkt nu elk kwartier zelf (zonder Google-diensten). Sneller kan met een eigen push-dienst zoals UnifiedPush/ntfy.
- **Native Android-agendasynchronisatie in twee richtingen** — de ingebouwde synchronisatie leest alleen; wijzigen kan in de Eigen Cloud-app of met een aparte CalDAV-client.
- **iPhone-app** — nu alleen de webapp op het startscherm.
- **Automatische gezichtsherkenning** — tags en lokale tekstherkenning zijn beschikbaar; gezichten worden nog niet automatisch herkend.
