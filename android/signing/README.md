# Ondertekening en overgang naar een nieuwe sleutel

De eerder gepubliceerde sleutel is blootgesteld. Gebruik hem niet voor nieuwe releases.
Hij staat nog in oude Git-commits; verwijderen trekt eerdere kopieën niet in.

Release-builds gebruiken uitsluitend ANDROID_KEYSTORE, ANDROID_KEYSTORE_PASSWORD,
ANDROID_KEY_ALIAS en ANDROID_KEY_PASSWORD. Zonder alle vier stopt de build.
GitHub Actions verwacht ANDROID_KEYSTORE_BASE64 plus de drie wachtwoord/alias-secrets.
Sla de nieuwe sleutel ook versleuteld buiten GitHub op. Debug-builds hebben hun eigen sleutel.

Maak de sleutel buiten de repository met scripts/android-signing.sh. Het script toont geen
wachtwoorden of sleutelinhoud. Voeg de waarden zelf toe onder GitHub → Settings → Secrets
and variables → Actions. Gebruik een uniek wachtwoord en bescherm de release-branch.

Voor versie 1.17 is een nieuwe sleutel gemaakt. De openbare SHA-256-vingerafdruk staat in
[certificate-sha256.txt](certificate-sha256.txt); Gradle weigert een andere sleutel, ook bij
samengestelde taken zoals `assemble`. Het private sleutelbestand en de wachtwoorden horen
uitsluitend in een veilige externe back-up en de vier GitHub Actions-secrets.

Een private JSON met de vier secret-namen kan met `chmod 600` worden beschermd en met
`python3 scripts/android-ci-secrets.py /veilige/map/ci-secrets.json --repo renevanes/own-cloud`
worden geïnstalleerd. Dit gebruikt je ingelogde GitHub CLI en stuurt waarden via stdin;
het toont de waarden niet. `ANDROID_KEYSTORE_BASE64` is base64 van het volledige nieuwe
PKCS12-keystorebestand. Lokaal gebruik je het bestandspad als `ANDROID_KEYSTORE`.
Maak je later een andere sleutel, leg dan bewust ook de nieuwe certificaatvingerafdruk vast.

## Bestaande installaties

De updater accepteert uitsluitend dezelfde ondertekenaar. Een blootgestelde oude sleutel
is geen betrouwbare basis om een nieuwe ondertekenaar automatisch goed te keuren.

1. Inventariseer bestaande installaties en maak een versleutelde kluis-export.
2. Publiceer de nieuwe certificaatvingerafdruk via een onafhankelijk gecontroleerd kanaal.
3. Installeer de nieuwe APK na controle. Weigert Android de gewijzigde ondertekening,
   verwijder dan de oude app en installeer opnieuw.
4. Herstel de kluis en meld de cloud opnieuw aan; cloudgegevens blijven op de servers.
5. Trek oude app-sessies in via Account → Apparaten; controleer foto-back-up en agenda-sync.

De updater accepteert geen willekeurige certificaten uit netwerkmetadata en schakelt de
handtekeningcontrole nooit uit. De testinstallaties mogen voor deze overgang schoon worden hersteld.
Zie [RELEASE-1.17.md](../../RELEASE-1.17.md) voor de servermigratie en beperkingen van terugzetten.
