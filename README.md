# Eigen Cloud — mail, agenda en foto's in eigen beheer

Eén eigen server die Gmail, Google Agenda en Google Foto's vervangt. Alles draait op één goedkope VPS, alle data staat in één map (`data/`) die je zelf beheert.

| Onderdeel | Wat het doet |
|---|---|
| **Mail** | Eigen SMTP-server ontvangt mail voor je domein, versturen met DKIM-handtekening (direct of via relay), mappen, Gmail-labels, gesprekken, zoeken (full-text), bijlagen. HTML-mail wordt veilig getoond: geen scripts, externe afbeeldingen standaard geblokkeerd. |
| **Agenda** | Meerdere agenda's, terugkerende afspraken (blijven goed over zomer-/wintertijd), losse herhaling verwijderen, herinneringen, `.ics` import/export, **privé iCal-feed** om op je telefoon te abonneren. |
| **Foto's** | Upload (ook slepen), automatische thumbnails, EXIF-datum/camera/GPS, tijdlijn per maand, favorieten, albums, video's met spoelen, ontdubbeling op inhoud. |
| **Import** | Volledige migratie vanuit Google Takeout: Gmail (`.mbox` met labels/gelezen/ster), Agenda (`.ics` per agenda), Foto's (met Google's JSON-metadata en albums). |

Techniek: Node.js 22 + TypeScript, Fastify, SQLite (één bestand, makkelijk te back-uppen), sharp/ffmpeg, Caddy voor automatische HTTPS. Webapp werkt op telefoon en is als app op je startscherm te zetten.

---

## 1. Server bij Hetzner

1. Maak een Cloud-server: **CX22** of groter, Ubuntu 24.04, locatie Falkenstein/Nürnberg/Helsinki. Voor veel foto's: koppel een **Volume** (bijv. 500 GB) en zet `data/` daarop.
2. **Poort 25 openzetten:** Hetzner blokkeert uitgaande poort 25 standaard bij nieuwe accounts. Vraag na je eerste betaalde factuur via de Cloud Console een *"Request to unblock port 25"* aan. Tot die tijd: zet `SMTP_RELAY` (bijv. Amazon SES) in `.env`.
3. **Reverse DNS (PTR):** zet in de Cloud Console de reverse DNS van het IPv4-adres op `mail.jouwdomein.nl`. Zonder dit wordt je mail vaak als spam gezien.
4. Installeer Docker:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```

## 2. DNS-records

Vervang `jouwdomein.nl` en `1.2.3.4` door je eigen domein en server-IP:

| Type | Naam | Waarde |
|---|---|---|
| A | `cloud.jouwdomein.nl` | `1.2.3.4` |
| A | `mail.jouwdomein.nl` | `1.2.3.4` |
| MX | `jouwdomein.nl` | `10 mail.jouwdomein.nl` |
| TXT | `jouwdomein.nl` | `v=spf1 mx -all` *(met SES: `v=spf1 mx include:amazonses.com -all`)* |
| TXT | `eigen._domainkey.jouwdomein.nl` | *(output van stap 3 hieronder)* |
| TXT | `_dmarc.jouwdomein.nl` | `v=DMARC1; p=quarantine; rua=mailto:rene@jouwdomein.nl` |

## 3. Installeren

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

## 4. Je Google-data verhuizen

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

## 5. Op je telefoon

- **Webapp:** open `https://cloud.jouwdomein.nl` in Chrome → menu → *Toevoegen aan startscherm*.
- **Agenda in je telefoonagenda:** abonneer je op `https://cloud.jouwdomein.nl/ical/<ICAL_TOKEN>/agenda.ics` (bijv. met de app *ICSx⁵*). Afspraken maak je in de webapp; de feed is alleen-lezen.
- **API voor een eigen app** (bijv. een module in Rene's Tools): `POST /api/login` geeft een `token`; stuur daarna `Authorization: Bearer <token>` mee. Endpoints staan in `src/*/routes.ts`.

## 6. Back-ups

Alles staat in `data/`. Simpelste aanpak: Hetzner **Storage Box** + dagelijkse `restic`- of `borg`-back-up van `data/`. Maak voor de database een consistente kopie:

```bash
sqlite3 data/eigen-cloud.sqlite ".backup data/backup.sqlite"
```

## 7. Ontwikkelen

```bash
npm install
npm run set-password
npm run dev          # http://localhost:3000, SMTP op poort 2525
npm test             # 10 tests: SMTP, versturen+DKIM, imports, zomertijd, foto's
```

## Nog niet ingebouwd (logische volgende stappen)

- **Spamfilter** — nu komt alles in de inbox. Volgende stap: SPF/DKIM-controle bij ontvangst en/of Rspamd ervoor zetten.
- **IMAP/CalDAV** — nodig als je ook bestaande mail-/agenda-apps wilt gebruiken in plaats van de eigen webapp of app.
- **Push-meldingen** voor nieuwe mail en agendaherinneringen.
- **Foto's automatisch uploaden** vanaf je telefoon (past goed als tool in Rene's Tools via de upload-API).
- **Gezichten/zoeken op inhoud** in foto's.
