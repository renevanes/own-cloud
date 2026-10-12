# Versleuteling en toegang

Eigen Cloud heeft versleutelde back-ups en een versleutelde beheerkluis. De actieve
cloud is geen end-to-end versleutelde mailbox of fotobibliotheek.

| Gegevens | Bescherming en toegang |
|---|---|
| Browser/app naar cloud | HTTPS. De server ontsleutelt verzoeken en verwerkt hun inhoud. |
| Actieve SQLite-database, mail, bijlagen, foto's en thumbnails | Gewone serverbestanden. De app scheidt gebruikers met toegangscontroles; iemand met voldoende serverrechten kan inhoud en sleutels lezen. Schijfversleuteling is afhankelijk van de serverconfiguratie/aanbieder. |
| Objectopslag/back-ups | Geauthenticeerde AES-GCM-versleuteling met afgeleide cloudsleutels. Alleen objectopslagcredentials geven geen leesbare cloudinhoud, maar objectnamen en groottes kunnen zichtbaar zijn. De master-/herstelsleutel geeft wel toegang. |
| Node-naar-node | Berichten en bestandsoverdracht zijn versleuteld en geauthenticeerd met afgeleide clustersleutels. Data-nodes hebben de cloudsleutel; witnesses krijgen alleen de sleutel voor clusterberichten, geen database-/blobsleutel. |
| Beheerkluis | Versleuteld met de wachtwoordzin; Android ontgrendelt via de apparaatbeveiliging. Maak zelf een veilige kopie van kluis en herstelblad. |
| Accountbeveiliging | Wachtwoordhashes, gehashte herstelcodes/app-wachtwoorden en versleutelde MFA-secrets. De actieve server kan MFA-secrets ontsleutelen om codes te controleren. |
| Offline browsergegevens en ZIP-export | Leesbare lokale gegevens beschermd door het apparaat/browserprofiel. Gebruik een vertrouwd apparaat; een gedeelde of onbeveiligde computer geeft anderen mogelijk toegang. |
| Internetmail | SMTP tussen mailservers gebruikt beschikbare STARTTLS; externe aflevering heeft geen gegarandeerde end-to-end versleuteling. Ontvangende servers kunnen de mail lezen. |

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
