# Twee perspectieven: aanbieder en consument

Vastgelegd na het interview van 11 oktober 2026 (bijgesteld: elke aanbieder is zijn eigen platform). Dit is het doel;
wat al gebouwd is staat in BROKER.md en de README.

## In het kort

Eén app, twee rollen. **Consumenten** gebruiken hun cloud (mail, agenda, foto's) en regelen hun abonnement.
**Aanbieders** draaien zelf de Eigen Cloud Dienst, met hun eigen accounts, prijzen en huisstijl, en beheren hun
klanten. Er is geen centraal platform dat aanbieders goedkeurt of geld afroomt: de software is open source en elke
aanbieder is zelfstandig. Aanbieders verbeteren de software samen via GitHub.

```
Open-source project (GitHub: renevanes/own-cloud)
   ├─ beheerders van de repository (eerst Rene): keuren wijzigingen en de lijst van aanbieders goed
   ├─ centraal en gedeeld: de app in de releases · de lijst van aanbieders · de gratis-adressendienst
   └─ Aanbieder A, B, … — elk een eigen Dienst met eigen Scaleway, Mollie, deSEC, prijzen, merk
        ├─ medewerkers: eigenaar · beheer · support · financiën
        └─ consumenten → hun cloud → gebruikers (gezin)
```

## Besluiten

| Onderwerp | Besluit |
|---|---|
| Model | Elke aanbieder draait zelf een Dienst (de huidige src/broker), met eigen Scaleway-organisatie, Mollie, deSEC en mailadres. Geen goedkeuring door Rene, geen afdracht. |
| Waar beheren | In dezelfde app: wie bij een Dienst als medewerker inlogt, krijgt het gedeelte *Aanbieder*. |
| Dienst opzetten | Vanuit de app, net als een cloud: accounts koppelen (Scaleway, Mollie, deSEC, mail), de app zet de Dienst op een server en houdt hem bij met de rollende updates. Docker volgens BROKER.md blijft mogelijk. |
| Bijdragen | Via GitHub: voorstellen (pull requests) die de beheerders van de repository beoordelen. Wat zij samenvoegen komt in de volgende versie voor iedereen. |
| Jouw rol (Rene) | Aanbieder zoals ieder ander, én beheerder van de repository. |
| Centraal | (1) De app in de releases, voor alle aanbieders. (2) De lijst van aanbieders: een bestand in de repository; een aanbieder voegt zich toe met een pull request. (3) De gratis-adressendienst. |
| Gratis adressen | Een centrale adressendienst beheert een gedeelde zone (bijv. `naam.eigencloud.nl`). Aanbieders op de lijst vragen met hun sleutel een naam aan; die verwijst door (NS/DS) naar de DNS van hun eigen Dienst. |
| Koppeling consument ↔ aanbieder | Uitnodigingslink of code van de aanbieder, of kiezen uit de lijst in de app. |
| Rollen binnen een aanbieder | Eigenaar (alles, ook medewerkers), Beheer (klanten, clouds, berichten), Support (inzien, hulpvragen), Financiën (betalingen, facturen, achterstanden). |
| Inloggen medewerkers | Code per mail, daarna verplicht vingerafdruk (toestelsleutel) of een authenticator-app. |
| Huisstijl | Naam, logo, accentkleur en contact van de aanbieder in de app, na koppeling. De app heet Eigen Cloud. |
| Geld | Volledig zelfstandig: eigen Mollie, eigen prijzen, facturen op naam van de aanbieder (zoals de Dienst nu al doet). |
| Privacy | Medewerkers zien alleen technische gegevens: status, gezondheid, opslaggebruik, versie, kosten. Nooit mail, agenda of foto's. |
| Routes voor de consument | Alle routes blijven: via een aanbieder (eerste keuze), zelf met één Scaleway-sleutel, of zelf per onderdeel. |
| Overstappen | Naar een andere aanbieder = verhuizen met de bestaande verhuisfunctie: nieuwe servers bij de nieuwe aanbieder, gegevens versleuteld overgezet, oude opgeruimd. Ook naar zelf beheren. |
| Volgorde | Alles in één keer. |

## Aanbieder: wat hij kan (in de app, per rol)

- Zijn Dienst opzetten, koppelen aan zijn accounts, bijwerken en bewaken.
- Klanten en abonnementen: zoeken, status, opschorten, hervatten, opzeggen, opruimen.
- Geld: betalingen, facturen, achterstanden, terugbetalen, omzet per maand.
- Servers en kosten: wat draait er per klant, gezondheid, opslaggebruik, versie, kosten bij Scaleway naast de prijs.
- Aanbod: bundels en prijzen, prijs per extra gebruiker, voorwaarden en privacy, huisstijl.
- Uitnodigingslinks en codes; zichzelf aanmelden voor de lijst (de app maakt het voorstel klaar).
- Hulpvragen beantwoorden; berichten en storingen aan eigen klanten; automatische meldingen bij ongezonde clouds.
- Medewerkers uitnodigen met een rol.

## Consument: wat hij kan

- Alles wat er nu is: cloud gebruiken, opzetten, abonnement, facturen, bijwerken, opnieuw instellen.
- Een aanbieder kiezen uit de lijst of via een uitnodiging; daarna diens huisstijl en contact in de app.
- **Hulp vragen** in de app, met antwoord van de aanbieder (en een melding).
- **Berichten en storingen** van zijn aanbieder; automatisch een melding als zijn eigen cloud ongezond is.
- **Overstappen** naar een andere aanbieder of naar zelf beheren (verhuizen).
- **Gezin en extra gebruikers**: meer mensen in één cloud, elk met eigen mail, agenda en foto's. Aantal per bundel, extra tegen een prijs per gebruiker die de aanbieder bepaalt.

## Wat er technisch bij komt (schets)

- **Dienst** (src/broker): medewerkers met rollen en tweede inlogstap (toestelsleutel, TOTP); beheer-API met rechtencontrole; huisstijl; uitnodigingscodes; hulpvragen en berichten; prijs per extra gebruiker; technische status van clouds (ondertekend, zonder inhoud); verhuizen naar een andere Dienst.
- **Dienst opzetten vanuit de app**: zelfde aanpak als een cloud (server bij Scaleway, image van ghcr.io, rollende updates, back-up van de database naar eigen opslag).
- **Lijst van aanbieders**: `aanbieders.json` in de repository (naam, adres van de Dienst, land, contact, sleutel); de app leest hem uit de releases.
- **Gratis-adressendienst**: kleine centrale dienst (draait bij Rene) die namen in de gedeelde zone uitgeeft aan aanbieders op de lijst, met hun sleutel ondertekend.
- **App**: gedeelte *Aanbieder*; kiezen van een aanbieder; huisstijl; hulp, berichten, overstappen.
- **Cloud** (src/): meerdere gebruikers (nu is er één mailbox en één wachtwoord): eigen mailbox, agenda en foto's per gebruiker, beheerd door de eerste gebruiker; limiet uit de bundel. Dit is het grootste onderdeel.

## Nog te regelen (buiten de code)

- Een domein voor de gedeelde gratis adressen, bij deSEC, met een hogere zonelimiet.
- Een bijdragegids (CONTRIBUTING.md) en regels voor de lijst van aanbieders (bijv. KvK, contact, voorwaarden).
- Juridisch per aanbieder: eigen voorwaarden en verwerkersovereenkomst met consumenten.
