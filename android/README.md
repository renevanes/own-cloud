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
Je sleutels staan in een kluis op de telefoon (PBKDF2 + AES-256-GCM), te ontgrendelen met je wachtwoordzin of vingerafdruk
(Android Keystore). Schermafbeeldingen van de beheerconsole zijn geblokkeerd; Google-back-up van de app staat uit.

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

Eerste keer: vul het adres van je cloud in (bijv. `vanes.nl` → `https://cloud.vanes.nl`) en log in. Blijf ingelogd:
de achtergrondtaken gebruiken je inlogsessie (30 dagen geldig, vernieuwd als je inlogt). Daarna in de app
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
          updates), ShareActivity, Biometrics. Alleen Android-framework, geen bibliotheken.
```

Testen zonder Android-toolchain: `core/test.sh` (alle kern-tests, ook de console-routes van begin tot start) en
`compile-check.sh` (app-code compileert tegen de Android 34-API). Wat alleen op een echt toestel te testen is:
de WebView, toestemmingen, JobScheduler, agenda-provider en vingerafdruk — doe die rondgang bij de eerste APK.
