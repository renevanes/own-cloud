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
Je sleutels staan in een kluis op de telefoon (PBKDF2 + AES-256-GCM), te ontgrendelen met je wachtwoordzin of vingerafdruk
(Android Keystore). Schermafbeeldingen van de beheerconsole zijn geblokkeerd; Google-back-up van de app staat uit.

## Installeren

Download de nieuwste `eigen-cloud-x.y.z.apk` bij de [Releases](https://github.com/renevanes/eigen-cloud/releases/latest)
op je telefoon en open hem (sta *installeren uit deze bron* toe). Nieuwe versies meldt de app zelf.

Eerste keer: vul het adres van je cloud in (bijv. `vanes.nl` → `https://cloud.vanes.nl`) en log in. Blijf ingelogd:
de achtergrondtaken gebruiken je inlogsessie (30 dagen geldig, vernieuwd als je inlogt). Daarna in de app
**Instellingen → Telefoon** de foto-back-up, agenda en meldingen aanzetten.

## Bouwen

De APK wordt gebouwd door GitHub Actions (`.github/workflows/android.yml`): eerst de tests van de Java-kern, dan
`gradle :app:assembleRelease`, ondertekend met jouw sleutel. Bij een tag `v1.2.3` komt hij in een Release.
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
