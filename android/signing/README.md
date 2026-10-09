# Ondertekensleutel van de app

Android installeert een update alleen als hij met **dezelfde sleutel** is ondertekend als de geïnstalleerde app.
Deze sleutel (`eigen-release.jks`) is daarom vast. Raak hem niet kwijt: met een andere sleutel moet iedereen de
app eerst verwijderen en opnieuw installeren.

**Tijdelijk staat hij in deze (privé) repository**, zodat de builds meteen met een vaste sleutel werken. Iedereen
met leestoegang tot de repository kan er APK's mee ondertekenen. Netter, en nodig als de repository ooit openbaar
wordt:

1. GitHub → repository → Settings → Secrets and variables → Actions → *New repository secret*:
   - `ANDROID_KEYSTORE_BASE64` = uitvoer van `base64 -w0 android/signing/eigen-release.jks`
   - `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` = uit `signing.properties`
2. Bewaar het `.jks`-bestand en het wachtwoord ook buiten GitHub (bijvoorbeeld bij je herstelblad).
3. Verwijder daarna `eigen-release.jks` en `signing.properties` uit de repository. Het is dezelfde sleutel, dus
   updates blijven gewoon werken.

De build gebruikt de secrets als die er zijn, anders dit bestand.

Vingerafdruk (SHA-256) van het certificaat:
`86:31:E4:B1:B1:D8:B8:06:8F:13:58:FF:E3:4F:07:3F:AF:2F:29:01:2E:D8:9A:FB:56:8B:84:19:1B:E3:DD:FB`
