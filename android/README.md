# Eigen Cloud voor Android

Een app voor je eigen cloud, zonder Google Play-diensten of Firebase. Twee delen:

**Je cloud** — mail, agenda en foto's (dezelfde schermen als in de browser), plus wat alleen een app kan:

| | |
|---|---|
| Foto-back-up | Nieuwe foto's en video's gaan automatisch naar je cloud, met de plaats waar ze gemaakt zijn. Alleen via wifi en/of tijdens opladen is in te stellen. Bij de eerste keer kies je: *alles wat er al op staat* of *alleen nieuwe*. Dubbele bestanden herkent de cloud zelf. |
| Agenda | Je cloud-agenda verschijnt als agenda *Eigen Cloud* in de agenda-app van je telefoon, met herinneringen. Alleen lezen: wijzigen doe je in de app. |
| Meldingen | Nieuwe mail, en als er iets mis is met je cloud. De app kijkt zelf elk kwartier en meteen bij openen (er is geen Google-push), dus een melding kan tot een kwartier later komen. |
| Delen | *Delen → Eigen Cloud* vanuit de galerij of een andere app. |
| Downloads en uploads | Bijlagen en foto's downloaden naar *Downloads*; bestanden kiezen voor import of upload. |

**Beheer** — dezelfde beheerconsole als op de computer, op je telefoon:
zelf een cloud opzetten bij Hetzner, Scaleway of UpCloud (opslag, servers met live prijzen, deSEC/Hetzner-DNS, mail-relay),
starten, laten slapen, wakker maken, back-ups testen, en herstellen met alleen je herstelsleutel.
De app praat daarvoor rechtstreeks met de aanbieders en met je servers; er zit geen dienst van ons tussen.
Kies je toch voor de **Eigen Cloud Dienst**, dan regel je ook dat helemaal in de app: bestellen, betalen met iDEAL
(de betaalpagina opent in de app, je bank-app springt vanzelf open), facturen bekijken en afdrukken/als PDF bewaren,
bundel wisselen, betaalmethode wijzigen, achterstand betalen, opzeggen of terugdraaien, verhuiscode van je domein,
en op een nieuwe telefoon herstellen met alleen je e-mailadres, de code uit de mail en je herstelsleutel.
Je sleutels staan in een kluis op de telefoon (AES-256-GCM). Standaard zit die achter je **vingerafdruk**: geen
wachtwoordzin om te bedenken of te typen (zie *Instellen zonder wachtwoorden* hieronder). Liever een wachtwoordzin? Dat kan
ook (PBKDF2), eventueel met de vingerafdruk erbij. Schermafbeeldingen van de beheerconsole zijn geblokkeerd; Google-back-up
van de app staat uit.

## Instellen zonder wachtwoorden

| Waar | Standaard | Alternatief |
|---|---|---|
| Kluis aanmaken (nieuwe cloud, *Aanbieder worden*, herstellen) | **Met je vingerafdruk**: de app maakt een willekeurige sleutel en zet die achter een sleutel in de beveiligde hardware van de telefoon (Android Keystore) die alleen na je vingerafdruk werkt; vanaf Android 11 ook na de pincode, het patroon of het wachtwoord van de telefoon. Eén keer bevestigen, verder niets. | *Liever een wachtwoordzin* (zoals voorheen). Geen vingerafdruk of schermvergrendeling ingesteld? Dan zegt de app dat, met *Vingerafdruk instellen* (de instellingen van Android) of een wachtwoordzin. Android 8: alleen een wachtwoordzin. |
| Kluis openen | De vraag om je vingerafdruk verschijnt meteen. | *Pincode van je telefoon* (Android 11+), *Wachtwoordzin gebruiken* (als je er een hebt), of *Lukt het niet?* → kluis wissen en herstellen met je herstelsleutel. |
| Wachtwoord van je cloud | **De app maakt een sterk wachtwoord** (`xxxxx-xxxxx-xxxxx-xxxxx`, ±99 bits), bewaart het in de kluis en logt na het starten zelf in. *Kluis → Wachtwoord tonen* (na je vingerafdruk) voor een andere app; voor agenda/contacten liever een apart sync-wachtwoord in je cloud. | *Zelf een wachtwoord kiezen* (met *Genereer een sterk wachtwoord*). |
| Inloggen bij je cloud (*Verbinden*) | Eerste keer adres + wachtwoord in de app zelf (met de code uit je authenticator-app als je die hebt); daarna is opnieuw inloggen (na 30 dagen of na uitloggen) één tik met je vingerafdruk. Op een telefoon die de cloud zelf opzette: helemaal niet inloggen. | *Wachtwoord intypen*; *Over Eigen Cloud → Inloggen → uitzetten*. |
| Sleutels en tokens van aanbieders | *Plakken* naast elk geheim veld: leest het klembord, haalt spaties, regeleinden en aanhalingstekens weg en maakt het klembord daarna leeg (Android 9+: `clearPrimaryClip`). | Gewoon plakken of typen. |
| Beheer van een Dienst (medewerkers) | Vingerafdruk eerst: de vraag verschijnt meteen bij de tweede inlogstap. Bewust zonder pincode. | De code uit je authenticator-app. |

Komt er een vingerafdruk bij, dan zet Android de sleutels uit. De app legt dat uit en biedt de pincode (als die het nog
doet), je wachtwoordzin (*Kluis → Ook een wachtwoordzin instellen*, als je die hebt gekozen) of je herstelsleutel aan,
en stelt daarna de vingerafdruk opnieuw in. Zie [TRUST.md](../TRUST.md).

## Versies

Elke wijziging is een nieuwe versie: 1.1, 1.2, … (`VERSION` in de hoofdmap; app en servers hebben hetzelfde nummer).
Bij elke versie hoort een paar regels in `changelog.json`. De app laat die na een update één keer zien
(*Nieuw in versie X.Y*), de updatemelding noemt wat er nieuw is, en onder **Instellingen → Telefoon → Wat is er nieuw**
staat het hele overzicht. Elke versie is één commit *Versie X.Y* en krijgt een eigen release `vX.Y` op GitHub met
`Eigen-Cloud-vX.Y.apk`.

```sh
scripts/bump.sh "Wat er voor de gebruiker veranderd is" "Nog iets"   # versie +0.1 en regels in het wijzigingslog
scripts/publish.sh                                                    # tests, commit "Versie X.Y", push naar main
```
`publish.sh` stopt als het wijzigingslog niet bij `VERSION` past of als er intussen een nieuwere versie op GitHub
staat (een andere sessie): eerst `git pull --rebase`, dan opnieuw `scripts/bump.sh`. De CI weigert een push waarvan de
versie al bestaat.

## Automatische updates

Elke versie op `main` wordt door GitHub Actions gebouwd en gepubliceerd. De app kijkt bij het openen (hooguit eens per
half uur) en op de achtergrond (elke paar uur), ook als je cloud nog niet draait. Hij zoekt op drie plekken en neemt
de hoogste versie:

1. de nieuwste **release op GitHub** (`update.json` en `Eigen-Cloud-vX.Y.apk`), zonder inloggen (de repository is openbaar);
2. het pakket `eigen-cloud-app` op **ghcr.io** (als dat op Public staat);
3. **je eigen cloud** (`/app/update.json`, ingelogd; elk server-image bevat de app van dezelfde build).

Hij controleert altijd de SHA-256 en of de nieuwe versie met dezelfde sleutel is ondertekend. Via wifi installeert hij
zichzelf (vanaf Android 12 zonder tik, nadat je één keer *apps installeren* hebt toegestaan); anders zie je
*Nieuwe versie* met wat er nieuw is en een knop **Bijwerken**. Bij elke versie meldt GitHub Actions of de app en de
servers hun updates zonder inloggen kunnen ophalen. De vaste ondertekensleutel staat in `android/signing/`.

## Installeren

Eerste keer: download de app van je eigen cloud (**Instellingen → Telefoon → App downloaden**, ingelogd), of de
nieuwste `Eigen-Cloud-vX.Y.apk` bij de [Releases](https://github.com/renevanes/own-cloud/releases/latest), en open
hem (sta *installeren uit deze bron* toe). Daarna werkt de app zichzelf bij.

Eerste keer: vul het adres van je cloud in (bijv. `vanes.nl` → `https://cloud.vanes.nl`) en log in; vink *Voortaan
inloggen met je vingerafdruk* aan. Blijf ingelogd: de achtergrondtaken gebruiken je inlogsessie (30 dagen geldig,
vernieuwd als je inlogt; daarna één tik met je vingerafdruk). In je cloud staat de telefoon bij *Apparaten en sessies* als
"Eigen Cloud-app op …". Daarna in de app
**Instellingen → Telefoon** de foto-back-up, agenda en meldingen aanzetten.

## Bouwen

De APK wordt gebouwd door GitHub Actions (`.github/workflows/android.yml`): eerst de tests van de Java-kern, dan
`gradle :app:assembleRelease`, ondertekend met jouw sleutel. Elke nieuwe versie in `package.json` op `main` komt als Release online.
De vier secrets staan bovenaan dat workflow-bestand beschreven.

Zelf bouwen: Android Studio (of JDK 17 + Android SDK 34 + Gradle 8.9) en in deze map `gradle :app:assembleDebug`.
De schermen van de console komen bij het bouwen uit `web-console/` en `web/shared/` (één bron voor computer en telefoon).

## Opbouw

```
android/
  core/   nl.eigencloud.core — Java zonder Android: versleuteling (zelfde formaten als de servers), kluis,
          aanbieders (Hetzner/Scaleway/UpCloud), S3-opslag, DNS, SMTP-test, cluster-RPC en ConsoleApi
          (dezelfde /api-routes als src/console/server.ts). Getest met test.sh tegen de TypeScript-code.
  app/    nl.eigencloud.app — MainActivity (cloud in WebView + brug EigenPhone), ConsoleActivity
          (web-console + brug EigenNative → ConsoleApi), SyncJob (JobScheduler: foto's, agenda, meldingen,
          updates), ShareActivity, Biometrics (vingerafdruk en de DeviceLock van de kluis), CloudLogin (inloggen
          bij je cloud, achter je vingerafdruk), DeviceSecrets (geheimen voor de achtergrond, zonder vingerafdruk).
          Alleen Android-framework, geen bibliotheken.
```

Testen zonder Android-toolchain: `core/test.sh` (alle kern-tests, ook de console-routes van begin tot start) en
`compile-check.sh` (app-code compileert tegen de Android 34-API; `ANDROID_JAR=/pad/naar/android.jar` als de SDK niet
op de standaardplek staat). Lint (`gradle lint`) draait alleen in de CI.

**Geheimen voor de achtergrond** (bijv. een app-wachtwoord dat de synchronisatie zonder jou moet kunnen lezen): gebruik
`DeviceSecrets.put(context, naam, waarde)` / `DeviceSecrets.get(context, naam)`. Versleuteld met een AES-sleutel in de
Android Keystore zonder vingerafdruk, met de naam als extra gegevens; weg bij *App helemaal opnieuw instellen*. Wat jij
moet bevestigen (kluis, inloggen, wachtwoord tonen) gaat via `Biometrics`/`CloudLogin`. Wat alleen op een echt toestel te testen is:
de WebView, toestemmingen, JobScheduler, agenda-provider en vingerafdruk — doe die rondgang bij de eerste APK.
