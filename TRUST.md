# Versleuteling en toegang

Eigen Cloud heeft versleutelde back-ups en een versleutelde beheerkluis. De actieve
cloud is geen end-to-end versleutelde mailbox of fotobibliotheek.

| Gegevens | Bescherming en toegang |
|---|---|
| Browser/app naar cloud | HTTPS. De server ontsleutelt verzoeken en verwerkt hun inhoud. |
| Actieve SQLite-database, mail, bijlagen, foto's en thumbnails | Gewone serverbestanden. De app scheidt gebruikers met toegangscontroles; iemand met voldoende serverrechten kan inhoud en sleutels lezen. Schijfversleuteling is afhankelijk van de serverconfiguratie/aanbieder. |
| Objectopslag/back-ups | Geauthenticeerde AES-GCM-versleuteling met afgeleide cloudsleutels. Alleen objectopslagcredentials geven geen leesbare cloudinhoud, maar objectnamen en groottes kunnen zichtbaar zijn. De master-/herstelsleutel geeft wel toegang. |
| Node-naar-node | Berichten en bestandsoverdracht zijn versleuteld en geauthenticeerd met afgeleide clustersleutels. Data-nodes hebben de cloudsleutel; witnesses krijgen alleen de sleutel voor clusterberichten, geen database-/blobsleutel. |
| Beheerkluis | Op de computer versleuteld met je wachtwoordzin. Op de telefoon standaard achter je vingerafdruk (sleutel in de beveiligde hardware van de telefoon), of met een wachtwoordzin; zie hieronder. Je herstelsleutel haalt alles terug. Maak zelf een veilige kopie van het herstelblad. |
| Accountbeveiliging | Wachtwoordhashes, gehashte herstelcodes/app-wachtwoorden en versleutelde MFA-secrets. De actieve server kan MFA-secrets ontsleutelen om codes te controleren. |
| Offline browsergegevens en ZIP-export | Leesbare lokale gegevens beschermd door het apparaat/browserprofiel. Gebruik een vertrouwd apparaat; een gedeelde of onbeveiligde computer geeft anderen mogelijk toegang. |
| Internetmail | SMTP tussen mailservers gebruikt beschikbare STARTTLS; externe aflevering heeft geen gegarandeerde end-to-end versleuteling. Ontvangende servers kunnen de mail lezen. |

## De kluis op de telefoon: vingerafdruk of wachtwoordzin

In de kluis staan je hoofd-/herstelsleutel, de sleutels bij aanbieders en (alleen op de telefoon) het wachtwoord van je
cloud. De inhoud is altijd versleuteld met een kluissleutel (AES-256-GCM); verschil zit in wat die kluissleutel beschermt.

| Manier | Wat de kluissleutel beschermt | Wie de kluis kan openen |
|---|---|---|
| **Vingerafdruk** (standaard op de telefoon) | Een willekeurige kluissleutel, versleuteld met een sleutel in de Android Keystore (de beveiligde hardware van de telefoon; de sleutel is er niet uit te halen). Die sleutel werkt alleen na je vingerafdruk (elke keer opnieuw), vanaf Android 11 ook na de pincode/het patroon/het wachtwoord van de telefoon, en alleen als de telefoon ontgrendeld is. | Wie deze telefoon in handen heeft én je vingerafdruk of (Android 11+) de pincode van de telefoon. Een kopie van het kluisbestand zonder deze telefoon is onleesbaar. |
| **Vingerafdruk + wachtwoordzin** (*Kluis → Ook een wachtwoordzin instellen*) | Als hierboven, plus dezelfde kluissleutel versleuteld met een sleutel uit je wachtwoordzin (PBKDF2-SHA256, 310 000 rondes). | Ook wie het kluisbestand én je wachtwoordzin heeft. |
| **Wachtwoordzin** (*Liever een wachtwoordzin*; op de computer altijd) | De kluissleutel komt uit je wachtwoordzin (telefoon: PBKDF2; computer: scrypt). Met *Voortaan ontgrendelen met vingerafdruk* bewaart de telefoon hem ook achter een Keystore-sleutel met alleen biometrie. | Wie het kluisbestand en je wachtwoordzin heeft (of de telefoon en je vingerafdruk). |

**De pincode van je telefoon is een alternatief, geen tweede slot.** Met de vingerafdruk-kluis is de pincode van je
telefoon (Android 11+) even sterk als je vingerafdruk: iemand die je telefoon en je pincode heeft, opent de kluis. Kies een
goede schermvergrendeling. Het beheer van een Dienst (tweede inlogstap van medewerkers) gebruikt bewust alleen de
vingerafdruk, met de authenticator-app als alternatief.

**Als je vingerafdrukken veranderen.** Komt er een vingerafdruk bij (of verandert de schermvergrendeling), dan zet Android
de sleutel van de kluis voorgoed uit, zodat een nieuw toegevoegde vinger er niet bij kan. De app zegt dat en biedt aan:
de pincode van de telefoon (als de sleutel die nog toestaat), je wachtwoordzin (als je die hebt ingesteld), of
*Herstellen met je herstelsleutel*. Daarna maakt de app een nieuwe sleutel achter je huidige vingerafdrukken.

**Waarom de herstelsleutel blijft.** De vingerafdruk-sleutel bestaat alleen op deze ene telefoon. Bij een nieuwe telefoon,
een fabrieksreset, *App helemaal opnieuw instellen* of veranderde vingerafdrukken zonder wachtwoordzin is de kluis op de
telefoon niet meer te openen. Je cloud draait dan gewoon door, en met je herstelsleutel (herstelblad) en de toegang tot
één opslag, of je e-mailadres bij de Dienst, haalt de console alles terug. De versleutelde herstelkopie in je opslag
(of in de back-ups van je Dienst) is versleuteld met een sleutel uit je herstelsleutel, niet met je vingerafdruk of
wachtwoordzin; ze werkt dus voor elke manier.

**Het wachtwoord van je cloud.** Op de telefoon maakt de app het (±99 bits) en bewaart het in de kluis, dus ook in de
versleutelde herstelkopie: wie je herstelsleutel heeft, kan het lezen (die kan al je back-ups lezen). Zo logt de app na
het starten en na herstellen op een nieuwe telefoon zelf in. De cloud krijgt alleen de hash. *Wachtwoord tonen* vraagt
eerst je vingerafdruk. Voor agenda- en contactenapps zijn aparte sync-wachtwoorden beter: die trek je los in. De computer
bewaart het wachtwoord niet, alleen de hash.

**Inloggen bij je cloud met je vingerafdruk.** Na de eerste keer inloggen in de app bewaart de telefoon je adres en
wachtwoord versleuteld voor een RSA-sleutelpaar in de Keystore: versleutelen kan zonder jou (zo kan de app na het opzetten
het gemaakte wachtwoord meteen bewaren), ontsleutelen alleen na je vingerafdruk. De sessie zelf (30 dagen) staat, net als
voorheen, in de cookie van de app, omdat foto-back-up en agenda op de achtergrond werken. Uitloggen en wachtwoord wijzigen
trekken de sessie in (sessiegeneraties); een gewijzigd wachtwoord typ je daarna één keer opnieuw.

**Plakken.** *Plakken* naast een sleutel of token leest het klembord en maakt het daarna leeg (Android 9+), zodat het
geheim niet op het klembord blijft. Andere apps (of het toetsenbord) kunnen het klembord wel hebben gezien zolang het er
stond. *Kopiëren* van het wachtwoord van je cloud markeert het als gevoelig (Android 13+) en wist het na een minuut.

**Geheimen voor de achtergrond** (bijv. een app-wachtwoord dat de synchronisatie nodig heeft) staan versleuteld met een
Keystore-sleutel zonder vingerafdruk (`DeviceSecrets`): onleesbaar buiten deze telefoon, maar leesbaar voor de app zelf,
ook als jij er niet bij bent.

Op de computer verandert er niets: een wachtwoordzin, met nu ook *Genereer een sterk wachtwoord* en *Plakken*.
Inloggen met een passkey of vingerafdruk in de browser (WebAuthn) zit er niet in.

## Beheer, delen en verwerking

De eigenaar kan accounts en wachtwoorden beheren. Serverbeheerders, hostingaanbieders
met voldoende toegang tot de draaiende machine en iemand met je herstel-/master-
sleutel zijn onderdeel van het vertrouwensmodel. De aanbiederinterface toont
gezondheids-, herstel- en kostengegevens volgens medewerkersrollen; deze beperking
van de interface verandert de mogelijkheden van een beheerder met serverrechten niet.

Delen geeft geaccepteerde lokale gebruikers de gekozen rechten op een agenda of
album. Intrekken stopt volgende serververzoeken; het verwijdert geen kopie die iemand
eerder heeft gedownload. Hetzelfde geldt voor een eerder gemaakte export.

Server-side mailbezorging, zoeken, spamcontrole, EXIF-verwerking en thumbnails vereisen
dat de actieve server de inhoud kan lezen. Een ander model met end-to-end versleuteling
vereist een aparte productkeuze voor deze functies en is niet door deze release toegevoegd.
