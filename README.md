# Eigen Cloud — mail, agenda en foto's in eigen beheer

Je eigen vervanger voor Gmail, Google Agenda en Google Foto's, op servers die jij kiest bij Europese aanbieders. Je cloud bewaakt, herstelt en verhuist zichzelf, en kan gaan slapen als je hem even niet nodig hebt. Alles is te regelen via een gewone webinterface; je hebt geen opdrachtregel nodig.

| Onderdeel | Wat het doet |
|---|---|
| **Mail** | Eigen SMTP-server ontvangt mail voor je domein, versturen met DKIM-handtekening (direct of via relay), mappen, Gmail-labels, gesprekken, zoeken (full-text), bijlagen. HTML-mail wordt veilig getoond: geen scripts, externe afbeeldingen standaard geblokkeerd. |
| **Agenda** | Meerdere agenda's, terugkerende afspraken (blijven goed over zomer-/wintertijd), losse herhaling verwijderen, herinneringen, `.ics` import/export, **privé iCal-feed** om op je telefoon te abonneren. |
| **Foto's** | Upload (ook slepen), automatische thumbnails, EXIF-datum/camera/GPS, tijdlijn per maand, favorieten, albums, video's met spoelen, ontdubbeling op inhoud. |
| **Overstappen** | Sleep je Google Takeout-zips in de browser: mail (met labels), agenda's en foto's (met Google's metadata en albums) komen er in één keer in. Hervat vanzelf na een verbroken verbinding. |
| **Gezondheid** | Controleert elk kwartier je DNS, mailbeveiliging (SPF, DKIM, DMARC, reverse DNS), certificaat, back-ups en servers. Repareert wat kan zelf, en mailt je anders wat er moet gebeuren. |
| **Tijdmachine** | Kies een moment in het verleden en zet per ongeluk verwijderde of veranderde mails, afspraken en foto's terug. |
| **Beheerconsole** | Installatie-assistent op je eigen computer of je telefoon: kluis met je sleutels, opslag en servers koppelen (met live prijzen), domein, mail, en daarna een overzicht met kaart, wekken, slapen en herstellen. |
| **Naast Gmail** | Proefperiode *naast Gmail* (je mail komt nog bij Gmail binnen en wordt elke paar minuten opgehaald) of *Gmail als vangnet* na het overstappen. Instellingen → Gmail. |
| **Bijwerken** | Servers werken zichzelf 's nachts bij naar de nieuwste versie, één voor één, en zetten zichzelf terug als de nieuwe versie niet goed opstart. Zie [CLUSTER.md](CLUSTER.md#bijwerken-naar-een-nieuwe-versie). |
| **Android-app** | Alles van de webapp, plus automatische foto-back-up, je agenda in de agenda-app van je telefoon, meldingen bij nieuwe mail of problemen, *Delen → Eigen Cloud*, en de beheerconsole met vingerafdruk-ontgrendeling. Zonder Google-diensten. Zie [android/README.md](android/README.md). |

> Het eerdere Lovable-project uit deze repository staat bewaard in de branch `archief/lovable`.

Techniek: Node.js 22 + TypeScript, Fastify, SQLite (één bestand, makkelijk te back-uppen), sharp/ffmpeg, Caddy voor automatische HTTPS. Webapp werkt op telefoon en is als app op je startscherm te zetten.

---

## Snel starten

**Wat je nodig hebt**
- Een eigen domeinnaam (bijvoorbeeld bij een Nederlandse registrar).
- Een account bij één of meer Europese aanbieders: [Scaleway](https://console.scaleway.com) (Amsterdam), [Hetzner](https://console.hetzner.com) (Duitsland/Finland) of [UpCloud](https://hub.upcloud.com). Bij dezelfde aanbieders koop je ook de opslag voor back-ups.
- Een gratis account bij [deSEC](https://desec.io) voor DNS (aanbevolen).
- Optioneel: een mail-relay (Scaleway TEM of Brevo), en een e-mailadres buiten je nieuwe domein voor meldingen.

**Zo start je**
1. Installeer [Node.js 22](https://nodejs.org) op je computer.
2. Pak deze map uit. Op Windows dubbelklik je **`beheer.cmd`**; op Mac/Linux draai je `npm install && npm run beheer`.
3. Je browser opent de beheerconsole. Volg de stappen:
   - **Jij en je domein** — domein, e-mailadres, inlogwachtwoord, meldadres en een wachtwoordzin voor de kluis.
   - **Herstelsleutel** — schrijf hem op of druk het herstelblad af.
   - **Opslag** — koppel een werkkopie en een back-up, bij voorkeur in twee landen. Buckets, versiebeheer en object-lock worden automatisch ingesteld.
   - **Servers** — koppel aanbieders; je kiest daarna *Alles in Nederland*, *Nederland en Duitsland* of *Spreid over Europa*, met de actuele maandprijs erbij.
   - **Domein** — de console zet het domein klaar bij deSEC en vertelt welke nameservers je bij je registrar invult.
   - **Mail versturen** — relay testen met een testbericht.
   - **Starten** — één klik. Binnen ±10 minuten draait je cloud op drie servers.
4. Open je cloud, ga naar **Instellingen → Importeren uit Google** en sleep je Takeout-bestanden erin.

**Geen domein of accounts?** Kies in de eerste stap *Gratis adres*: de console maakt dan zelf een gratis account bij [deSEC](https://desec.io) (open source, non-profit) met een naam als `vanes.dedyn.io` — je typt alleen een plaatje over en klikt op de link in je mail. Wil je niets zelf afsluiten, kies dan in de stap *Zelf of via de dienst* een abonnement bij de **Eigen Cloud Dienst**: die regelt je domein, DNS, servers, opslag en mail-relay in één bedrag per maand, betaald met iDEAL. Je herstelsleutel blijft ook dan alleen bij jou. Zie [BROKER.md](BROKER.md) voor wie de dienst aanbiedt.

**Liever vanaf je telefoon?** Installeer de [Android-app](android/README.md) en kies *Nieuwe Eigen Cloud opzetten*: dezelfde stappen, en je sleutels staan versleuteld op je telefoon (ontgrendelen met vingerafdruk).

Bewaar het bestand `~/.eigen-cloud/kluis.json` gerust in je back-up of synchronisatiemap: het is versleuteld met je wachtwoordzin. Op een andere computer of telefoon kies je in de console **Ik heb al een Eigen Cloud** en vul je je herstelsleutel en de gegevens van één opslag in (de bucketnaam mag je leeg laten; de console zoekt hem zelf). Heb je een abonnement bij de Eigen Cloud Dienst, dan is het nog eenvoudiger: **Herstellen via de Eigen Cloud Dienst** vraagt alleen je e-mailadres, de code uit de mail en je herstelsleutel.

**Abonnement beheren** doe je in de console zelf (paneel *Abonnement* op het overzicht): facturen bekijken en afdrukken, een andere bundel kiezen (je cloud krijgt meteen de nieuwe aantallen servers), je betaalmethode wijzigen, een mislukte incasso alsnog betalen, opzeggen of het opzeggen terugdraaien, en de verhuiscode van je domein opvragen. In de app opent de betaalpagina van Mollie in de app zelf en springt je bank-app vanzelf open.

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
npm run dienst       # de Eigen Cloud Dienst (centrale betaalde dienst), zie BROKER.md
npm test             # mail, agenda, foto's, import, instellingen, gezondheid, versleuteling, Gmail,
                     # replicatie, aanbieders, cluster end-to-end en de console end-to-end
android/core/test.sh # Java-kern van de Android-app tegen de TypeScript-code, moto (S3) en een echte cluster-node
android/compile-check.sh  # app-code compileren tegen de Android-API (zonder Android Studio)
```

## Meerdere servers, verhuizen en slapen

Zie **[CLUSTER.md](CLUSTER.md)**: Eigen Cloud als cluster over meerdere Europese aanbieders, met failover, zelfherstel, versleutelde back-ups (ook naar een tijdstip), verhuizen, en slapen/wekken.

## Nog niet ingebouwd (logische volgende stappen)

- **Spamfilter** — nu komt alles in de inbox. Volgende stap: SPF/DKIM-controle bij ontvangst en/of Rspamd ervoor zetten.
- **Live-test bij de aanbieders** — de koppelingen met Hetzner, Scaleway en UpCloud volgen hun API-documentatie maar zijn nog niet tegen echte accounts gedraaid. De console test inloggen en prijzen ophalen meteen bij het koppelen.
- **IMAP/CalDAV** — nodig als je ook bestaande mail-/agenda-apps wilt gebruiken in plaats van de eigen webapp of app.
- **Directe push-meldingen** — de app kijkt nu elk kwartier zelf (zonder Google-diensten). Sneller kan met een eigen push-dienst zoals UnifiedPush/ntfy.
- **Agenda op de telefoon bewerken** — de telefoonagenda volgt de cloud nu alleen (lezen); wijzigen doe je in de app.
- **iPhone-app** — nu alleen de webapp op het startscherm.
- **Gezichten/zoeken op inhoud** in foto's.
