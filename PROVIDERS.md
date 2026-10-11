# Aanbieders — het adapter-raamwerk

Eigen Cloud draait bij aanbieders die jij kiest. Welke aanbieders dat kunnen zijn, is **open**: elke aanbieder is
één adapter in de code, en iedereen kan er een toevoegen met een pull request op GitHub. Geen enkele aanbieder is
speciaal; de console, de app en het cluster halen alles uit dezelfde lijst.

Standaard zitten erin:

| Aanbieder | Land | Servers | Opslag (S3) | DNS | Reverse DNS | Live prijzen |
|---|---|---|---|---|---|---|
| Scaleway | 🇫🇷 | ✓ Amsterdam, Parijs, Warschau | ✓ | ✓ (Domains and DNS) | — | ✓ |
| Hetzner | 🇩🇪 | ✓ Falkenstein, Neurenberg, Helsinki | ✓ | ✓ | ✓ | ✓ |
| UpCloud | 🇫🇮 | ✓ Amsterdam, Frankfurt, Helsinki, Stockholm | ✓ (eigen endpoint) | — (heeft geen DNS) | — | — |
| Exoscale | 🇨🇭 | ✓ Genève, Zürich, Frankfurt, München, Wenen, Sofia | ✓ (SOS) | ✓ | ✓ | — (geen prijs-API) |
| OVHcloud | 🇫🇷 | ✓ Gravelines, Straatsburg, Frankfurt, Warschau, Londen | ✓ | ✓ | — | ✓ (openbare catalogus) |
| deSEC | 🇩🇪 | — | — | ✓ (gratis) | — | — |
| Eigen opslag | — | — | ✓ (NAS, MinIO, Garage) | — | — | — |

Een cloud mag aanbieders mengen: servers bij de een, de back-up bij een ander, de DNS bij een derde. Hoe meer
landen en aanbieders, hoe beter je cloud een grote storing overleeft.

## Hoe het in elkaar zit

```
src/cluster/adapters/types.ts       het contract: ProviderAdapter, Provider, DnsProvider, Field, …
src/cluster/adapters/<id>.ts        één bestand per aanbieder, met één ProviderAdapter-object
src/cluster/adapters.ts             de registry: de ENIGE lijst van aanbieders
        │
        ├─ src/cluster/providers.ts makeProvider(): servers maken/opruimen (console én cluster)
        ├─ src/cluster/dns.ts       makeDns(): records bijwerken (het cluster doet dat zelf)
        ├─ src/cluster/cloudinit.ts Caddy-certificaten via DNS (als de adapter een Caddy-module heeft)
        ├─ src/console/catalog.ts   storeOffers / serverOffers / dnsOffers / fetchSizes voor de console
        └─ scripts/export-catalog.ts  catalog.json voor de Android-app
```

De adapters staan in `src/cluster/` en niet bij de console, omdat de servers van je cluster ze zelf gebruiken:
zelfherstel maakt servers bij, het opruimen zoekt vergeten servers, en de leider zet de DNS-records. De console
gebruikt dezelfde code.

### Het contract

```ts
interface ProviderAdapter {
  id: string;            // korte id, kleine letters: sleutel in config.providers, dns[].type en placement.provider
  name: string;          // merknaam, bijv. "Hetzner Cloud"
  owner: string;         // bedrijf en land, bijv. "Hetzner Online GmbH (Duitsland)"
  home: string;          // land van het bedrijf (rechtsgebied), ISO-code
  signupUrl: string;     // waar je een account maakt
  keyHelp: string;       // waar maak je de sleutel en welke rechten zijn nodig (Nederlands, gewone taal)
  fields: Field[];       // inloggegevens: { key, label, secret?, help?, optional?, placeholder? }
  servers?: {
    regions: RegionInfo[];                                   // { id, label, country, city }
    create(fields): Provider;                                // create / destroy / list / setPtr? / country
    fetchSizes(fields, region): Promise<SizeOption[]>;       // { size, label, ramGb, cpus, monthly | null }
    check?(fields): Promise<KeyCheck[]>;                     // "Sleutels controleren", alleen lezen (zie hieronder)
  };
  storage?: {
    name: string;
    regions: StorageRegion[];                                // { id, label, country, endpoint (https) }
    customEndpoint?: boolean;                                // gebruiker vult zelf het endpoint in
    keyHelp: string;
    signupUrl?: string;
  };
  dns?: {
    name?: string;
    fields?: Field[];                                        // standaard dezelfde als `fields`
    keyHelp?: string;
    connect(fields, zone): Promise<{ nameservers: string[] }>;  // sleutel en zone controleren (of zone aanmaken)
    create(name, fields, zone): DnsProvider;                 // setRecords(sub, type, values, ttl)
    caddy?(fields): string;                                  // Caddy DNS-01-regel, alleen met module in Dockerfile.caddy ("" = veld ontbreekt)
    check?(fields, zone): Promise<KeyCheck[]>;               // "Sleutels controleren" voor DNS, alleen lezen; maakt nooit een zone aan
  };
  quick?: { title; signupUrl; keysUrl };                     // "alles met één sleutel" (nu alleen Scaleway)
  testOnly?: boolean;                                        // alleen in tests zichtbaar (de aanbieder "local")
}

interface Provider {
  create(spec: { cluster, nodeId, kind, region, size, userData }): Promise<ServerInfo>;  // { serverId, ipv4, ipv6, country, monthlyCost? }
  destroy(serverId): Promise<void>;          // bestaat al niet meer = geen fout
  list(cluster): Promise<{ serverId, nodeId }[]>;  // fout bij verkeerde sleutel (zo test de console het inloggen)
  setPtr?(server, hostname): Promise<void>;
  country(region): string;
}
```

Afspraken waar een adapter zich aan houdt:

- **Terugvinden.** `create` geeft de server een label, tag of naam met het cluster en de node-id, en `list` vindt
  precies díe servers terug (niet die van een ander cluster in hetzelfde account). Het cluster ruimt alles op wat
  `list` teruggeeft en niet in het register staat; een te ruime `list` kost dus servers van iemand anders.
- **Cloud-init.** `userData` is een shellscript (cloud-init). Het bevat geen geheimen. Moet de API het in base64,
  dan codeert de adapter het.
- **Firewall.** De server zet zelf zijn firewall (ufw). Laat de aanbieder standaard niets binnen (zoals Exoscale),
  dan maakt de adapter een regel die alles doorlaat en laat het filteren aan de server.
- **DNS-waarden** komen in zonebestand-notatie: A/AAAA een adres, MX `10 mail.voorbeeld.nl.`, TXT tussen
  aanhalingstekens (lang: `"…" "…"`). Een lege lijst haalt de records weg. Zet records alleen als ze anders zijn.
- **Fouten** die de gebruiker ziet zijn Nederlands en zeggen wat hij moet doen ("Maak eerst de zone … aan").
- **Gegevens zijn data.** Alles behalve functies gaat naar de console en `catalog.json`; houd het zonder geheimen.
- **Sleutels controleren is alleen lezen.** `check` doet uitsluitend GET (of HEAD) en geeft een lijstje
  `{ id, label, ok, detail }` (helpers in `adapters/check.ts`): `ok` is `true` (✓), `false` (✗, `detail` zegt in
  gewone taal wat je waar aanpast) of `null` (?, de aanbieder laat het niet zien, of niet gecontroleerd omdat
  inloggen al mislukte). Vaste regels: `login` "Inloggen lukt", `servers` "Servers bekijken", `sizes` "Formaten en
  prijzen ophalen", `rights` "Rechten voor servers maken" / "Rechten om DNS te wijzigen", `zone` "DNS-zone bekijken".
  Rechten alleen beoordelen als de API ze echt laat zien; anders `ok: null` met "Kan de aanbieder niet laten zien;
  blijkt bij het starten". De console toont het lijstje bij elke gekoppelde aanbieder (knop "Sleutels
  controleren", route `POST /api/check`) en na een mislukte koppeling. Zonder `servers.check` gebruikt de console
  een algemene controle (`list` en `fetchSizes`). Opslag is voor elke aanbieder S3 en wordt generiek gecontroleerd
  (ListBuckets, HeadBucket, één bestandsnaam opvragen).

## Een aanbieder toevoegen

1. **Adapter schrijven.** Maak `src/cluster/adapters/<id>.ts` met één `export const <id>: ProviderAdapter`.
   Kijk naar `hetzner.ts` (eenvoudig, met token) of `exoscale.ts`/`ovh.ts` (ondertekende verzoeken). Gebruik
   `api()` en `getJson()` uit `adapters/http.ts`: die gaan via `fetch`, zodat tests een nep-API kunnen inprikken.
   Een basis-URL die tests willen omleiden mag uit een omgevingsvariabele komen (`EIGEN_<ID>_API`).
2. **In de registry zetten.** Importeer hem in `src/cluster/adapters.ts` en zet hem in `BUILTIN`. De volgorde is
   de volgorde in de console. Meer hoeft niet: de console (opslag, servers, DNS), de prijzen, de
   verspreidingsvoorstellen en `catalog.json` volgen vanzelf.
3. **Testen tegen een nagebootste API.** Zet tests in `test/adapters.test.ts` (of een eigen `test/<id>.test.ts`):
   - vervang `globalThis.fetch` door een nep-API die per verzoek antwoordt en de toestand bijhoudt (servers, records);
   - **reken in de nep-API de handtekening of het token zelf na** volgens de documentatie van de aanbieder, los van
     de adapter-code, en weiger (401/403) als het niet klopt;
   - doorloop `create` → `list` → `destroy` (ook twee keer `destroy`), `fetchSizes`, en bij DNS `connect` en
     `setRecords` (nieuw, bijwerken, niets veranderd, weghalen, MX en TXT);
   - de registrytest controleert vanzelf dat je adapter compleet is (velden, uitleg, https-endpoints).
   Het voorbeeld onderaan `test/adapters.test.ts` ("een eigen aanbieder toevoegen") laat zien dat een geregistreerde
   adapter meteen in de console staat, te koppelen is, prijzen geeft en voor DNS te kiezen is.
4. **Android.** De app leest `catalog.json` (`npx tsx scripts/export-catalog.ts`, gebeurt ook in
   `android/core/test.sh`), maar de calls naar de aanbieder (koppelen, prijzen, servers) staan in de Java-kern
   (`android/core`). Port je adapter daarheen; zie CONTRIBUTING.md.
5. **Sleutels controleren.** Geef `servers.check` en/of `dns.check` (alleen lezen, zie hierboven) en zet de
   verwachte lijstjes in `test/fixtures/key-checks.json`: die gegevens gebruiken de TS-test
   (`test/key-check.test.ts`) én de Java-test (`KeyCheckTest`), zodat console en app precies hetzelfde laten zien.
   Probeer het daarna met een echt account (zie "Testen met een echt account").
6. **Hier documenteren.** Voeg je aanbieder toe aan de tabel bovenaan en schrijf een stukje zoals hieronder: welke
   sleutel en rechten, beperkingen, en wat je níet tegen een echt account hebt kunnen testen.
7. **Pull request** zoals in CONTRIBUTING.md: `npm run typecheck`, `npm test`.

## Testen met een echt account

De tests praten alleen met nagebootste API's. Of een adapter ook bij de echte aanbieder werkt, controleer je met

```sh
HCLOUD_TOKEN=… DOMAIN=vanes.nl npm run live-check            # alles waarvan de variabelen gezet zijn
npm run live-check -- ovh desec                              # alleen deze aanbieders
```

Het script (`scripts/live-check.ts`) doet **alleen lezende verzoeken**: per aanbieder dezelfde "Sleutels
controleren" als de console, plus `fetchSizes` in elke regio (aantal formaten en de goedkoopste met prijs). Er wordt
niets aangemaakt of gewijzigd en geheimen worden niet afgedrukt. Exitcode 1 als er iets met ✗ is.

| Aanbieder | Omgevingsvariabelen |
|---|---|
| Hetzner (servers, DNS) | `HCLOUD_TOKEN` |
| Scaleway (servers, DNS) | `SCW_SECRET_KEY`, `SCW_PROJECT_ID`, optioneel `SCW_ACCESS_KEY` (dan ook de rechten via IAM) |
| UpCloud | `UPCLOUD_TOKEN`, of `UPCLOUD_USERNAME` en `UPCLOUD_PASSWORD` |
| Exoscale (servers, DNS) | `EXOSCALE_KEY`, `EXOSCALE_SECRET` |
| OVHcloud (servers, DNS) | `OVH_APP_KEY`, `OVH_APP_SECRET`, `OVH_CONSUMER_KEY`, voor servers ook `OVH_PROJECT` |
| deSEC (DNS) | `DESEC_TOKEN` |
| S3-opslag (elke aanbieder) | `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, optioneel `S3_REGION`, `S3_BUCKET` |
| Zone voor DNS | `DOMAIN` (anders alleen "zones bekijken") |

Wat elke controle gebruikt (allemaal GET):

| Aanbieder | Verzoeken | Wat `?` blijft |
|---|---|---|
| Hetzner | `/v1/servers`, `/v1/server_types`, `/v1/zones?name=` | rechten: een token is "lezen" of "lezen en schrijven", dat laat de API niet zien |
| Scaleway | `instance/v1/zones/nl-ams-1/servers` en `/products/servers`, `domain/v2beta1/dns-zones`; met toegangssleutel IAM: `api-keys/{sleutel}` → `users/{id}` (eigenaar = alles) of `applications/{id}` → `groups` → `policies` → `rules` (permission sets `InstancesFullAccess` / `DomainsDNSFullAccess` / `AllProductsFullAccess`) | rechten zonder toegangssleutel (de console zoekt hem bij Scaleway-opslag met dezelfde geheime sleutel), of als de sleutel IAM niet mag lezen |
| UpCloud | `/1.3/account`, `/1.3/server`, `/1.3/plan` | rechten (API-tokens hebben altijd API-toegang; wat ze mogen laat de API niet zien) |
| Exoscale | `/v2/instance`, `/v2/instance-type`, `/v2/dns-domain`, `/v2/api-key/{sleutel}` → `/v2/iam-role/{id}` (policy per dienst `compute`/`dns`: allow, deny of rules) | rechten bij een rol met eigen regels (CEL), of als de sleutel IAM niet mag lezen; een nog niet aangemaakte zone |
| OVHcloud | `/auth/time`, `/auth/currentCredential` (status en rechtenregels van de sleutel), `/cloud/project/{id}`, `…/instance`, `…/flavor?region=GRA11`, `/domain/zone/{zone}` | niets: de rechten staan in de sleutel zelf |
| deSEC | `/domains/`, `/domains/{zone}/` | rechten: wat een token mag schrijven ziet alleen een token met beheerrechten; een nog niet toegevoegd domein |

## Per aanbieder

### Scaleway (Frankrijk)

- **Servers**: Instances in Amsterdam (3 zones), Parijs en Warschau. Elke server krijgt een eigen IPv4-adres;
  herkend aan de tags `cluster=…` en `node=…`. Prijzen live uit de API.
- **Opslag**: Object Storage in Amsterdam, Parijs en Warschau.
- **DNS**: Domains and DNS. Het domein moet al in Scaleway staan (bij Scaleway geregistreerd, of als extern domein
  toegevoegd); de console maakt de zone niet zelf aan.
- **Sleutel**: Console → IAM → API-sleutels. Voor servers: `InstancesFullAccess`; voor opslag
  `ObjectStorageFullAccess`; voor DNS `DomainsDNSFullAccess`. Het project-ID staat bij Project → Instellingen.
- **Snelle route**: *Eén sleutel bij Scaleway* regelt opslag, servers en mail in één keer (`/api/quick/scaleway`).
  Dat is een extra van deze adapter; de rest van de code gaat niet van Scaleway uit.
- **Niet tegen een echt account getest**: DNS-notatie (MX als `data` met aparte `priority`, TXT zonder
  aanhalingstekens), en of `PATCH …/records` met `delete` een 404 geeft als er niets was.
- **Certificaten**: DNS-01 via `caddy-dns/scaleway`. Die module wil naast de geheime sleutel ook het
  organisatie-ID; de console zoekt dat bij het koppelen zelf op (`GET /account/v3/projects/{project_id}` van de zone)
  en bewaart het in de DNS-koppeling. Mag de sleutel het project niet lezen, dan blijft het bij HTTP-01 (zie onder).
- **Beperkingen**: geen reverse DNS via de adapter.

### Hetzner (Duitsland)

- **Servers**: Falkenstein, Neurenberg, Helsinki; labels `cluster`, `node`, `kind`; reverse DNS via de API.
- **Opslag**: Object Storage in Falkenstein, Neurenberg en Helsinki.
- **DNS**: de nieuwe DNS in de Cloud API (zones/rrsets). Maak de zone eerst aan in de Hetzner Console → DNS; een
  zone die nog in de oude DNS-console staat, werkt niet.
- **Sleutel**: Hetzner Console → je project → Beveiliging → API-tokens → *lezen en schrijven*. Hetzelfde token werkt
  voor servers en DNS. S3-sleutels maak je apart bij Object Storage.
- **Beperkingen**: uitgaande poort 25 is bij nieuwe accounts dicht (vraag openzetten aan of gebruik een relay).

### UpCloud (Finland)

- **Servers**: Amsterdam, Frankfurt, Helsinki, Stockholm; labels `cluster`, `node`, `kind`.
- **Opslag**: Managed Object Storage met een eigen endpoint (de gebruiker plakt het endpoint).
- **DNS**: UpCloud heeft geen DNS-dienst.
- **Sleutel**: UpCloud Hub → Account → API-tokens; zet API-toegang aan voor het account.
- **Beperkingen**: de plannen-API geeft geen prijzen; de console toont "prijs onbekend".

### Exoscale (Zwitserland)

- **Servers**: Compute API v2 op `https://api-<zone>.exoscale.com/v2`, zones `ch-gva-2`, `ch-dk-2`, `de-fra-1`,
  `de-muc-1`, `at-vie-1`, `at-vie-2`, `bg-sof-1`. Formaten `standard.<maat>` (bijv. `standard.small`); template
  *Ubuntu 24.04* (de nieuwste); cloud-init in base64; labels `cluster`, `node`, `kind`; publiek IPv4 + IPv6;
  reverse DNS via `/reverse-dns/instance/{id}`. Exoscale laat standaard geen verkeer binnen: de adapter maakt
  eenmalig de security group **eigen-cloud** die alles doorlaat (TCP, ICMP, IPv4 en IPv6); ufw op de server filtert.
- **Ondertekening** (EXO2-HMAC-SHA256): het bericht is
  `"<METHOD> <pad>\n<body>\n<waarden van de query-parameters, op naam gesorteerd>\n\n<expires>"`, de handtekening is
  `base64(HMAC-SHA256(geheim, bericht))`, en de header
  `EXO2-HMAC-SHA256 credential=<sleutel>[,signed-query-args=a;b],expires=<unix-tijd>,signature=<…>`. De tekst in de
  documentatie zegt "HMAC van het base64-gecodeerde bericht"; de referentie-implementatie (requests-exoscale-auth)
  doet base64 van de HMAC. Wij volgen de referentie-implementatie; de test rekent het zo na.
- **Opslag**: SOS in alle zones (`https://sos-<zone>.exo.io`).
- **DNS**: Exoscale DNS (v2 `dns-domain` en records). Je hebt een DNS-abonnement bij Exoscale nodig. De console maakt
  de zone zelf aan. Nameservers: `ns1.exoscale.ch`, `ns1.exoscale.com`, `ns1.exoscale.io`, `ns1.exoscale.net`.
- **Sleutel**: Portal → IAM → Rollen: een rol met de diensten *Compute* en *DNS* (en *SOS* voor opslag). Daarna IAM →
  API-sleutels → sleutel met die rol. Je krijgt een sleutel (begint met `EXO`) en een geheim.
- **Beperkingen**: geen prijs-API, dus "prijs onbekend" (de console kiest dan op geheugen); geen Caddy-module
  (certificaten via HTTP-01, zie onder).
- **Niet tegen een echt account getest**: de exacte namen van publieke templates (we zoeken op "Ubuntu 24.04"),
  `public-ip-assignment: "inet4"` samen met `ipv6-enabled: true`, of de API TXT-inhoud zonder aanhalingstekens wil
  (en lange DKIM-sleutels zelf splitst), MX-inhoud zonder punt aan het eind, en het formaat van de `labels`-filter
  (daarom filteren we de lijst zelf).

### OVHcloud (Frankrijk)

- **Servers**: Public Cloud-instances in één project, regio's `GRA11` (Gravelines), `SBG5` (Straatsburg), `DE1`
  (Frankfurt), `WAW1` (Warschau) en `UK1` (Londen). Image *Ubuntu 24.04*, uurfacturering. OVHcloud-instances hebben
  geen labels: de adapter herkent ze aan de naam `<cluster>-<node-id>` (node-id's zijn `n-<hex>`).
  Na het aanmaken wacht de adapter tot de instance een publiek IPv4-adres heeft.
- **Ondertekening**: `X-Ovh-Signature = "$1$" + sha1_hex(AS+"+"+CK+"+"+METHOD+"+"+URL+"+"+BODY+"+"+TIJD)`, met de
  servertijd uit `GET /auth/time` (zoals de officiële bibliotheken).
- **Prijzen**: uit de openbare catalogus `GET /order/catalog/public/cloud?ovhSubsidiary=FR` (zonder sleutel): de
  uurprijs van de `planCodes.hourly` van het formaat × 730. Lukt dat niet, dan "prijs onbekend".
- **Opslag**: Object Storage (S3) in `gra`, `sbg`, `de`, `waw`, `uk` (`https://s3.<regio>.io.cloud.ovh.net`).
  Sleutels: Public Cloud → Users & Roles → gebruiker met de rol *ObjectStore operator* → S3-sleutels genereren.
- **DNS**: OVHcloud DNS (`/domain/zone/{zone}/record` en daarna `/refresh`). De zone moet al bij OVHcloud staan.
- **Sleutel**: een *application key*, *application secret* en *consumer key*, plus het project-ID van je Public
  Cloud-project. Maak ze in één keer op
  <https://eu.api.ovh.com/createToken/> met precies deze rechten (vervang `{projectId}` en `{zone}`, of gebruik `*`):

  | Methode | Pad |
  |---|---|
  | GET | `/cloud/project/{projectId}/*` |
  | POST | `/cloud/project/{projectId}/instance` |
  | DELETE | `/cloud/project/{projectId}/instance/*` |
  | GET | `/domain/zone/{zone}` |
  | GET | `/domain/zone/{zone}/*` |
  | POST | `/domain/zone/{zone}/*` |
  | DELETE | `/domain/zone/{zone}/record/*` |

  (`/auth/time` en de openbare catalogus hebben geen sleutel nodig. Zonder DNS bij OVHcloud kun je de twee
  `/domain`-regels weglaten.) Een vooringevulde link staat in de code als `OVH_CREATE_TOKEN_URL`; de lijst als
  `OVH_ACCESS_RULES` (een test controleert dat elk verzoek van de adapter erdoor gedekt is).
- **Certificaten**: DNS-01 via `caddy-dns/ovh` met dezelfde drie sleutels (endpoint `ovh-eu`). De rechten hierboven
  op `/domain/zone/…` zijn genoeg (de module gebruikt GET, POST `…/record`, DELETE `…/record/*` en POST `…/refresh`).
- **Beperkingen**: geen reverse DNS via de adapter (stel hem in via het OVHcloud-beheer → Network → IP).
- **Niet tegen een echt account getest**: of `userData` platte tekst mag zijn (wij sturen het script zoals het is),
  de eenheid van `ram` bij formaten (wij gaan uit van GB, zoals bij `d2-2` = 2 GB), de prijs-eenheid in de catalogus
  (wij gaan uit van 1/100.000.000 euro), of `createToken` herhaalde parameters in de link accepteert, en of de
  record-API TXT-waarden mét aanhalingstekens teruggeeft (zo niet, dan zet de adapter ze bij elke ronde opnieuw).

### deSEC (Duitsland, alleen DNS)

- Gratis, open source, non-profit. De console kan zelf een account aanmaken (gratis adres `naam.dedyn.io`), of je
  plakt een token van <https://desec.io> (Token Management). De console zet de zone klaar.
- Minimale TTL van een uur; dat is geen probleem, want failover hangt niet van DNS af.

### Eigen opslag

- Elke S3-compatibele opslag met een eigen endpoint (NAS thuis, MinIO, Garage). Ideaal als extra back-up.

## Certificaten en DNS (Caddy)

Elke server haalt zijn eigen certificaat voor `cloud.<domein>`. Omdat dat adres naar meerdere servers wijst, werkt
dat het best via DNS-01: Caddy zet dan zelf een record bij je DNS-aanbieder. Dat kan alleen als de Caddy-module in
`Dockerfile.caddy` zit (adapter-functie `dns.caddy`):

| DNS-aanbieder | Certificaten | Caddy-module (vaste versie in `Dockerfile.caddy`) | Wat Caddy nodig heeft |
|---|---|---|---|
| deSEC | DNS-01 | `github.com/caddy-dns/desec@v1.1.0` | token |
| Hetzner | DNS-01 | `github.com/caddy-dns/hetzner/v2@v2.0.1` (Cloud DNS API) | API-token |
| Scaleway | DNS-01 | `github.com/caddy-dns/scaleway@v0.2.2` | geheime sleutel + organisatie-ID (zoekt de console zelf op) |
| OVHcloud | DNS-01 | `github.com/caddy-dns/ovh@v1.1.0` | application key, application secret, consumer key |
| Exoscale | HTTP-01 | geen: `caddy-dns/exoscale` is sinds 2024 niet bijgewerkt (libdns 0.2, bouwt niet met Caddy 2.10+) | — |
| Eigen Cloud Dienst | DNS-01 | `github.com/caddy-dns/acmedns@v0.7.0` | acme-dns-account van de dienst |

De sleutels staan, net als het Hetzner-token, direct in de `Caddyfile` die de app zelf schrijft (`/data/Caddyfile`,
bestandsrechten 600). Caddy gebruikt de eerste DNS-koppeling waarvoor de regel compleet is; ontbreekt er een
veld (bijv. geen organisatie-ID bij Scaleway), dan telt de volgende koppeling, en anders HTTP-01.

Met HTTP-01 kan de controle bij meerdere servers op een andere server uitkomen en duurt het soms even voor elke
server een certificaat heeft. Komt er een onderhouden module voor Exoscale, voeg die dan toe aan
`Dockerfile.caddy` en een `caddy`-functie aan de adapter (TS én Java, `android/core`), in één pull request.
