# Versie 1.17: aanbevelingen uit de codecontrole

Deze versie past de beveiligings- en herstelproblemen uit de controle toe en voegt
de voorgestelde functies toe. De bestaande wijzigingen uit 1.15 en 1.16 blijven behouden.
De bestaande APK's en clouds zijn testinstallaties; een schone overgang is toegestaan.

## Overgang

1. Maak voor het bijwerken een hersteltest en bewaar je versleutelde kluis en herstelblad
   buiten de telefoon. Bewaar ook een herstelpunt van vóór deze versie.
2. Configureer de nieuwe Android-sleutel zoals beschreven in
   [android/signing/README.md](android/signing/README.md). De release-build controleert
   het certificaat tegen de vastgelegde vingerafdruk en stopt bij ontbrekende secrets.
3. Android accepteert deze nieuwe ondertekenaar niet als gewone update van de oude APK.
   Verwijder de oude testapp, installeer de nieuwe APK en herstel de kluis. Cloudgegevens
   blijven op de servers. Meld opnieuw aan en controleer foto-back-up en agendasynchronisatie.
4. Laat alle dataservers bijwerken. Nieuwe functies die tabellen schrijven blijven
   geblokkeerd zolang een dataserver de nieuwe schemamogelijkheid niet meldt.
5. Extra gebruikers moeten hun privé iCal-abonnement opnieuw toevoegen: hun URL gebruikt
   nu een geheim dat niet uit de URL van de eigenaar kan worden berekend. De eigenaar
   houdt zijn bestaande URL. Een iCal-URL geeft leestoegang; houd hem privé.

De startup- en herstelcode voeren vier genummerde migraties uit voordat replicatie
begint. `_schema_migrations` en tijdelijke reserveringen zijn lokaal; nieuwe account-,
mail-, import-, DAV- en deeltabellen gaan mee in replicatie en back-ups. De upgrade
ondersteunt oudere dataservers uit 1.14–1.16 zolang nieuwe functies nog niet schrijven.
Zodra nieuwe tabellen gebruikt zijn, is teruggaan naar 1.16 of ouder geen veilige
binary rollback: herstel het oude herstelpunt met de oude versie. Wijzigingen sinds
dat herstelpunt worden daarbij niet behouden. De updater blijft vóór activering
van de nieuwe functies zijn bestaande gezondheidscontrole en terugzetpad gebruiken.

## Wat is toegepast

| Aanbeveling | Implementatie |
|---|---|
| Blootgestelde Android-sleutel vervangen | Oude bestanden verwijderd, nieuwe certificaatpin, verplichte secrets, lint als releasecontrole, schone herinstallatie. Eerdere Git-kopieën van de oude sleutel blijven blootgesteld. |
| Kwaadaardige mailkop veilig weergeven | Namen en adressen worden geëscapet, hoofdscherm heeft CSP, browsercontrole gebruikt een echte opgeslagen mail met een kwaadaardige kop. |
| Veilige sessiegeheimen | Productiestart weigert ontbrekende, lege, korte en bekende ontwikkelgeheimen. Ontwikkelmodus blijft beschikbaar. |
| Sessies werkelijk intrekken | Alle gebruikers hebben sessiegeneraties en geregistreerde apparaten; wachtwoordwijziging, uitloggen en apparaatbeheer trekken toegang in. |
| Betrouwbare bevestiging | Metadata en vereiste bestanden hebben een tweede duurzame kopie voordat HTTP/SMTP succes meldt; onzekere uitkomsten en herhaalde verzoeken krijgen expliciete verwerking. |
| Het beste herstelpunt kiezen | Doorlopende ketens, daadwerkelijk herstelde voortgang en integriteitscontrole bepalen de keuze; gaten en beschadigde snapshots hebben regressietests. |
| Invoer en werk begrenzen | Fastify-schema's, stabiele paginering, opslagreserveringen, streamende SMTP en exports, begrensde archieven, werkpools en subprocess-timeouts. |
| Tests en releases verbeteren | Alleen-lezen PR-controles voor Node, browsers, Java en Android; geserialiseerde publicatie, vaste versiereferenties, matching commits/APK-hashes en gezamenlijke promotie. |
| Imports laten overleven | Blokken, hashes, voortgang en jobs staan in de database; bronblokken gaan mee naar andere servers. Hervatten, stoppen, verwijderen en opruimen zijn beschikbaar. |
| Volledig herstelbewijs | De brandoefening controleert ieder verwezen bestand, inclusief importblokken en Postvak uit; overzicht toont ontbrekende/beschadigde bestanden, tijd en achterstand. |
| Java/TypeScript overeenkomst | Versiebeheerd API-contract, mogelijkheidsoverzicht en gezamenlijke overstapfixtures; kopiëren en overstapvoorbeelden staan in afzonderlijke modules. |
| Heldere versleuteling | [TRUST.md](TRUST.md) beschrijft actieve servergegevens, versleutelde back-ups, beheerderstoegang, exports en lokale browsergegevens. |
| Mailuitbreidingen | Bewaarde concepten, Postvak uit met status per ontvanger, vaste Message-ID, veilige retries, optionele Rspamd-controle en eigen mailregels. |
| Andere agenda- en contact-apps | CalDAV/CardDAV discovery, collecties, query/multiget, voorwaardelijk wijzigen/verwijderen, vCard 3/4 en eigen sync-wachtwoorden met scopes. |
| Klant-MFA en apparaten | Authenticator met eenmalig verbruikte codes, tien herstelcodes, apparaatlijst, intrekken van andere apparaten en aparte sync-wachtwoorden. |
| Delen in het gezin | Agenda's en albums delen met lokale gebruikers, expliciete acceptatie, lees-/schrijfrechten en intrekken. |
| Gegevens meenemen | ZIP met originele bestanden, metadata, agenda en contacten en een SHA-256-bestandenlijst; overstappen controleert ook eerder gekopieerde bestanden. |
| Overstapvoorstel en aanbiedersoverzicht | Werkelijke abonnementskosten of expliciet onbekende eigen kosten, overgangsfase en integriteitsstatus; medewerkersoverzicht respecteert bestaande rollen. |
| Foto's organiseren | Eigen kaart, handmatige tags en lokale tekstherkenning met Nederlands/Engels; OCR-jobs blijven bewaard. |
| Offline gebruiken | Optionele, selectieve cache en wachtrij voor agenda-, contact- en conceptwijzigingen, revisieconflicten en wissen bij uitloggen. |

## Bevestiging en retries

In clustermodus betekent een bevestiging: de vastgelegde databasevolgorde staat op
een andere dataserver of in een herstelbare objectopslagketen, en ieder benodigd
bestand heeft eveneens een onafhankelijke duurzame kopie. Een witness stemt alleen;
zijn stem is geen tweede gegevenskopie. Een onbereikbare standby kan worden opgevangen
door bereikbare objectopslag. Eén losse server heeft geen tweede-kopiegarantie.

HTTP geeft bij timeout of verlies van leiderschap `503`, `uncertain: true` en een
`operationId`. De schrijfactie kan dan al lokaal uitgevoerd zijn. Geef JSON-wijzigingen
een `Idempotency-Key` en hergebruik die met precies hetzelfde verzoek. De webapp
doet dit bij netwerkfouten en onzekere antwoorden. De server bewaart de oorspronkelijke
uitkomst; hetzelfde nummer met andere inhoud geeft `409`. Multipartuploads en
inlog-/beveiligingsverzoeken worden niet als volledige antwoordkopie opgeslagen.
Imports gebruiken vaste blokposities en hashes; contacten, afspraken en concepten
hebben revisiecontrole. Andere clients kunnen ondersteuning ontdekken via
`/api/capabilities`; zie [contracts/cloud-api-v1.json](contracts/cloud-api-v1.json).

SMTP geeft `451` als ontvangen mail nog geen tweede kopie heeft. Een retry wordt
ontdubbeld per gebruiker op Message-ID of een stabiele inhoudshash zonder de eigen
toegevoegde Received-kop. De secundaire MX bewaart zijn lokale spool totdat de leider
duurzame opslag bevestigt. Postvak uit legt intentie en Message-ID vóór verzending
vast. Ontvangers die expliciet tijdelijk zijn geweigerd kunnen opnieuw geprobeerd
worden; bevestigde ontvangers worden overgeslagen. Een verbroken verbinding met een
onbekende uitkomst wordt vastgehouden als **onzeker**. Controleer die ontvanger voordat
je handmatig meldt dat het bericht wel of niet is aangekomen. SMTP kan geen precies
eenmaal-aflevering garanderen wanneer de ontvangstbevestiging verloren gaat.

## Opslag, import, spam en fotoverwerking

De eigenaar stelt onder Opslag een standaardlimiet of limiet per gebruiker in;
`0` betekent onbeperkt binnen de beschikbare schijfruimte. Reserveringen houden ook
ruimte vrij voor gelijktijdig werk en minimaal 64 MiB vrije schijf. De limiet telt
mail, bijlagen, foto-originelen, concepten, Postvak uit en ontvangen importblokken;
kleine databasevelden en thumbnails hebben daarnaast fysieke schijfbewaking.

Er zijn maximaal 50 bestanden per uploadverzoek en 8 GiB per bestand, 20 MiB per
importblok, 100 bewaarde uploads per gebruiker en 50 MiB per inkomend mailbericht.
Archiefuitpakken is begrensd op beschikbare ruimte en maximaal 32 GiB/100.000 bestanden.
Verwerk grotere Takeout-exports in kleinere delen. Imports kunnen reeds opgeslagen
inhoud bij hervatten opnieuw bezoeken; vaste bronidentiteiten voorkomen dubbelen.
Nieuwere agenda-edits blijven behouden. Voltooide imports ruimen staging op nadat
doelbestanden duurzaam bevestigd zijn. Stoppen behoudt reeds geïmporteerde gegevens;
verwijder ongebruikte uploads zelf. Onvolledige oude lokale uploads moeten opnieuw
worden aangeboden als hun oorspronkelijke server verdwijnt vóór adoptie en kopiëren.

Spamcontrole is optioneel. Start voor een losse Docker-installatie
`docker compose --profile spam up -d`, en stel in de app `http://rspamd:11333/` in,
of gebruik `RSPAMD_URL`. Vertrouw uitsluitend een scanner die je beheert. Het antwoord
is begrensd; timeouts bewaren mail met een zichtbare melding. Een spamadvies verplaatst
mail naar Spam; het weigert de SMTP-ontvangst niet. Door afzenders meegestuurde
Authentication-Results worden niet als scannerbewijs gebruikt.

Tekstherkenning draait lokaal met Tesseract (`eng+nld` in het server-image), één taak
tegelijk, maximaal 60 seconden, 40 megapixels en 100 MiB per foto. Resultaten en fouten
staan bij de foto. Automatische gezichtsherkenning is niet onderdeel van deze versie;
mensen en onderwerpen kun je zelf als tags toevoegen.

## Synchronisatie, offline gebruik en export

Maak in Account een app-wachtwoord met alleen CalDAV, alleen CardDAV of beide.
Gebruik je cloudadres als gebruikersnaam en de discovery-URL
`https://cloud.jouwdomein/.well-known/caldav` of `/.well-known/carddav`.
App-wachtwoorden verlopen na een jaar en vervallen bij het intrekken van alle sessies.
De iCal-feed blijft alleen lezen; CalDAV is voor wijzigen. Query's ondersteunen
tijdsbereiken, component-/eigenschapfilters en tekstvergelijking. `sync-collection`
en afzonderlijke eigenschapparameterfilters geven expliciet een fout. Querybereiken
zijn maximaal 400 dagen en antwoorden maximaal 10.000 bronnen. Snel terugkerende
afspraken hebben extra limieten tegen onbegrensd rekenwerk. Er is geen test met een
fysiek Android-apparaat of iedere externe DAV-client; protocol- en browserchecks
controleren de hier beschreven paden.

Offline opslag is standaard uit. Schakel hem alleen op een vertrouwd apparaat in;
geopende geselecteerde gegevens worden maximaal 24 uur, 100 MiB en 300 cache-items
bewaard. De wachtrij bevat maximaal 50 wijzigingen/2 MiB en geen opgeslagen bearer-
tokens of wachtwoorden. Een oude revisie wordt als conflict vastgehouden: haal de
actuele gegevens op, pas je wijziging bewust opnieuw toe en verwijder de oude poging.
Uitloggen, een 401 en wisselen van account/generatie/cloudidentiteit wissen de private
cache en wachtrij. Een offline telefoon weet niet meteen dat zijn sessie elders is
ingetrokken; de cache vervalt uiterlijk na 24 uur of bij de volgende verbinding.

Export bevat alleen je eigen gegevens, originele mail/bijlagen/foto's, contacten,
agenda, concepten, Postvak uit, regels, tags en OCR, met een volledige bestandenlijst.
Het bevat geen accountgeheimen, beheerkluis, import-staging of bestanden die alleen
door iemand anders met je gedeeld zijn. Een ontbrekend origineel is een fout; er wordt
geen complete export geclaimd wanneer een vereist bestand niet leesbaar is.
De ZIP is niet versleuteld. Bewaar hem op een veilige plek.

## Verificatie

De vereiste controles zijn `npm run typecheck`, `npm run build`, `npm test`,
`npm run test:browser`, `android/compile-check.sh`, `android/core/test.sh` en
`gradle :app:lintRelease :app:assembleRelease` met de nieuwe ondertekensleutel.
PR-controles bouwen de debug-APK zonder toegang tot signing secrets. De releaseworkflow
publiceert APK en beide server-images als één versieset en bevordert `latest` alleen
als de commit nog steeds de nieuwste main-commit is.

Nieuwe regressietests staan in [test/features.test.ts](test/features.test.ts),
[test/recovery.test.ts](test/recovery.test.ts) en [test/browser/app.spec.ts](test/browser/app.spec.ts).
De bestaande cluster-, rollback-, migratie- en Java/TypeScript-goldentests blijven behouden.
