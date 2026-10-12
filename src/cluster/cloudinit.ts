import type { ClusterConfig } from "./config.js";
import { getAdapter } from "./adapters.js";
import { dnsFields } from "./dns.js";

/**
 * Het opstartscript voor een nieuwe server. Bevat GEEN geheimen: alleen een tijdelijke download-URL
 * (verloopt na 2 uur) en een eenmalige join-token. De echte configuratie staat versleuteld in de opslag
 * en wordt na het aansluiten verwijderd — dus ook als de aanbieder de user-data bewaart, lekt er niets bruikbaars.
 */
export function userData(c: ClusterConfig, opts: { nodeId: string; kind: "data" | "witness"; bootstrapUrl: string; joinToken: string; imageUrl?: string; caddyUrl?: string; appImage?: string; caddyImage?: string }) {
  const domain = c.domain ?? "example.nl";
  // Bij een update staat de doelversie vast (image@sha256:…), zodat nieuwe servers precies die versie krijgen.
  const appImage = opts.appImage ?? c.image.ref ?? "eigen-cloud:latest";
  const caddyImage = opts.caddyImage ?? (c.image as { caddyRef?: string }).caddyRef ?? "eigen-caddy:latest";
  const allowedPrefix = updatePrefix(c.image.ref);

  const loadImage = (url: string | undefined, ref: string) =>
    url ? `curl -fsSL --retry 5 "${url}" | gunzip | docker load` : `docker pull ${ref}`;

  const appService = `  app:
    image: ${appImage}  # eigen-app
    restart: unless-stopped
    network_mode: host
    env_file: /opt/eigen/bootstrap.env
    environment:
      - DATA_DIR=/data
      - HTTP_PORT=3000
      - SMTP_PORT=25
      - CLUSTER_PORT=${c.clusterPort}
      - TLS_CERT_FILE=/caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/mail.${domain}/mail.${domain}.crt
      - TLS_KEY_FILE=/caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/mail.${domain}/mail.${domain}.key
    volumes:
      - /opt/eigen/data:/data
      - /opt/eigen/caddy:/caddy:ro`;

  // De app schrijft na het aansluiten zelf /data/Caddyfile (mét DNS-token); Caddy herlaadt dan automatisch (--watch).
  const caddyService = `  caddy:
    image: ${caddyImage}  # eigen-caddy
    restart: unless-stopped
    network_mode: host
    command: caddy run --config /etc/eigen/Caddyfile --adapter caddyfile --watch
    volumes:
      - /opt/eigen/data:/etc/eigen:ro
      - /opt/eigen/caddy:/data`;

  return `#!/bin/bash
# Eigen Cloud — ${opts.kind}-node ${opts.nodeId} (cluster ${c.cluster})
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y ca-certificates curl ufw chrony
systemctl enable --now chrony
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
ufw allow 22/tcp; ufw allow ${c.clusterPort}/tcp
${opts.kind === "data" ? "ufw allow 25/tcp; ufw allow 80/tcp; ufw allow 443/tcp" : ""}
ufw --force enable
mkdir -p /opt/eigen/data /opt/eigen/caddy
umask 077
cat > /opt/eigen/bootstrap.env <<'EOF'
NODE_ID=${opts.nodeId}
BOOTSTRAP_URL=${opts.bootstrapUrl}
JOIN_TOKEN=${opts.joinToken}
EOF
${loadImage(opts.imageUrl ?? c.image.url, appImage)}
${opts.kind === "data" ? loadImage(opts.caddyUrl ?? (c.image as { caddyUrl?: string }).caddyUrl, caddyImage) : ""}
${opts.kind === "data" ? `echo ':80 {\n\trespond "eigen-cloud start op" 503\n}' > /opt/eigen/data/Caddyfile` : ""}
cat > /opt/eigen/docker-compose.yml <<'EOF'
services:
${appService}
${opts.kind === "data" ? caddyService : ""}
EOF
cd /opt/eigen && docker compose up -d
${allowedPrefix ? updaterInstall(allowedPrefix, c.clusterPort) : "# geen updates op afstand: image zonder registry-pad"}
`;
}

/** Alleen images uit dezelfde registry-map mogen via een update binnenkomen (bijv. "ghcr.io/renevanes/"). */
export function updatePrefix(ref: string | undefined): string | null {
  const m = /^([a-z0-9.-]+\.[a-z]{2,}(?::\d+)?\/(?:[a-z0-9._-]+\/)*)[a-z0-9._-]+(?:[:@].*)?$/.exec(ref ?? "");
  return m ? m[1] : null;
}

/**
 * Updates op de server zelf, zonder SSH: de app schrijft een verzoek in /opt/eigen/data/update-request.json; systemd
 * ziet dat en draait eigen-update.sh. Dat haalt de nieuwe images op (alleen vaste versies uit de eigen registry-map),
 * start ze, controleert of de server gezond terugkomt en zet anders de vorige versie terug.
 */
export function updaterInstall(prefix: string, clusterPort: number) {
  return `printf '%s\\n' '${prefix}' > /opt/eigen/update-allowed
cat > /opt/eigen/eigen-update.sh <<'UPDATER'
${updaterScript()}
UPDATER
chmod 700 /opt/eigen/eigen-update.sh
echo 'CLUSTER_PORT=${clusterPort}' > /opt/eigen/update.env
cat > /etc/systemd/system/eigen-update.path <<'EOF'
[Path]
PathModified=/opt/eigen/data/update-request.json
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/eigen-update.service <<'EOF'
[Unit]
Description=Eigen Cloud bijwerken
[Service]
Type=oneshot
EnvironmentFile=/opt/eigen/update.env
ExecStart=/opt/eigen/eigen-update.sh
EOF
systemctl daemon-reload && systemctl enable --now eigen-update.path
echo '{"v":1}' > /opt/eigen/data/updater.json`;
}

/** Het updatescript op de server (bash + python3, dat bij cloud-init altijd aanwezig is). Te testen met EIGEN_ROOT. */
export function updaterScript() {
  return `#!/bin/bash
# Eigen Cloud — server bijwerken naar een vaste versie, met automatisch terugzetten als hij niet gezond terugkomt.
set -uo pipefail
ROOT="\${EIGEN_ROOT:-/opt/eigen}"
REQ="$ROOT/data/update-request.json"; RES="$ROOT/data/update-result.json"; COMPOSE="$ROOT/docker-compose.yml"
PORT="\${CLUSTER_PORT:-7946}"; HEALTH_SECONDS="\${EIGEN_UPDATE_HEALTH_SECONDS:-300}"
[ -f "$REQ" ] || exit 0
field() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print("" if v is None else v)' "$REQ" "$1"; }
ID=$(field id); APP=$(field app); CADDY=$(field caddy); VERSION=$(field version); SAVE_APP=$(field saveApp); SAVE_CADDY=$(field saveCaddy)
[ -n "$ID" ] || exit 0
if [ -f "$RES" ] && python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("id")==sys.argv[2] else 1)' "$RES" "$ID"; then exit 0; fi
result() { # result <ok> <rolledBack> <saved> <bericht>
  python3 - "$RES" "$ID" "$VERSION" "$1" "$2" "$3" "$4" <<'PY'
import json, sys, time, os
f, i, v, ok, rb, saved, msg = sys.argv[1:8]
tmp = f + ".tmp"
json.dump({"id": i, "version": v, "ok": ok == "1", "rolledBack": rb == "1", "saved": saved == "1", "error": msg or None, "at": int(time.time() * 1000)}, open(tmp, "w"))
os.replace(tmp, f)
PY
}
ALLOWED=$(head -n1 "$ROOT/update-allowed" 2>/dev/null)
valid() { [[ -n "$ALLOWED" && "$1" == "$ALLOWED"* && "$1" =~ ^[a-z0-9./:_-]+@sha256:[0-9a-f]{64}$ ]]; }
valid "$APP" || { result 0 0 0 "app-image niet toegestaan: $APP"; exit 0; }
HAS_CADDY=0; grep -q '# eigen-caddy$' "$COMPOSE" && HAS_CADDY=1
if [ "$HAS_CADDY" = 1 ]; then valid "$CADDY" || { result 0 0 0 "caddy-image niet toegestaan: $CADDY"; exit 0; }; fi
docker pull -q "$APP" >/dev/null || { result 0 0 0 "downloaden van $APP mislukt"; exit 0; }
if [ "$HAS_CADDY" = 1 ]; then docker pull -q "$CADDY" >/dev/null || { result 0 0 0 "downloaden van $CADDY mislukt"; exit 0; }; fi
cp "$COMPOSE" "$COMPOSE.prev"
sed -i -E "s|^(    image: ).*(  # eigen-app)$|\\1$APP\\2|" "$COMPOSE"
[ "$HAS_CADDY" = 1 ] && sed -i -E "s|^(    image: ).*(  # eigen-caddy)$|\\1$CADDY\\2|" "$COMPOSE"
(cd "$ROOT" && docker compose up -d) >/dev/null 2>&1
HEALTH_URL="\${HEALTH_URL:-http://127.0.0.1:$PORT/cluster/health}"; CADDY_HEALTH_URL="\${CADDY_HEALTH_URL-http://127.0.0.1:3000/healthz}"
healthy() {
  local body
  body=$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null) || return 1
  python3 -c 'import json,sys; sys.exit(0 if json.loads(sys.argv[1]).get("version")==sys.argv[2] else 1)' "$body" "$VERSION" || return 1
  if [ "$HAS_CADDY" = 1 ] && [ -n "$CADDY_HEALTH_URL" ]; then curl -fsS --max-time 3 "$CADDY_HEALTH_URL" >/dev/null 2>&1 || return 1; fi
}
ok=0
for _ in $(seq 1 $((HEALTH_SECONDS / 3))); do if healthy; then ok=1; break; fi; sleep 3; done
if [ "$ok" != 1 ]; then
  cp "$COMPOSE.prev" "$COMPOSE"
  (cd "$ROOT" && docker compose up -d) >/dev/null 2>&1
  result 0 1 0 "nieuwe versie kwam niet gezond op; vorige versie teruggezet"
  exit 0
fi
saved=0
if [ -n "$SAVE_APP" ]; then
  # Kopie in je eigen opslag: nieuwe servers kunnen dan ook zonder de registry starten.
  T=$(mktemp -d)
  if docker tag "$APP" "eigen-cloud:$VERSION" && docker save "eigen-cloud:$VERSION" | gzip -1 > "$T/app.tgz" && curl -fsS -X PUT -T "$T/app.tgz" "$SAVE_APP" >/dev/null; then saved=1; fi
  if [ "$saved" = 1 ] && [ -n "$SAVE_CADDY" ] && [ "$HAS_CADDY" = 1 ]; then
    { docker tag "$CADDY" "eigen-caddy:$VERSION" && docker save "eigen-caddy:$VERSION" | gzip -1 > "$T/caddy.tgz" && curl -fsS -X PUT -T "$T/caddy.tgz" "$SAVE_CADDY" >/dev/null; } || saved=0
  fi
  rm -rf "$T"
fi
result 1 0 "$saved" ""
docker image prune -f >/dev/null 2>&1 || true`;
}

// ───────── De Eigen Cloud Dienst van een aanbieder, op één eigen server ─────────

export interface DienstInit {
  /** Hostnaam van de Dienst, bijv. "dienst.vanes.nl" (Caddy haalt het certificaat met HTTP-01). */
  host: string;
  /** Mailadres voor Let's Encrypt (de eigenaar). */
  email: string;
  /** Inhoud van /srv/dienst/dienst.env (BROKER_*, MOLLIE_*, …), in deze volgorde. */
  env: [string, string][];
  /** Images om te starten (tag of vaste versie) en de tags waarop de dagelijkse controle naar nieuwe versies kijkt. */
  appImage: string;
  caddyImage: string;
  appRef: string;
  caddyRef: string;
  /**
   * Ook de gratis-adressendienst (node dist/adressen/main.js, zelfde image) op deze server: eigen hostnaam bij Caddy,
   * /srv/dienst/adressen.env (ADRES_*) en zijn database in /srv/dienst/adressen (de Dienst neemt hem mee in zijn back-up).
   */
  adressen?: { host: string; env: [string, string][] };
}

/** Eén waarde in dienst.env: letterlijk (de Dienst leest het bestand zelf), dus zonder regelovergangen. */
export function dienstEnvFile(env: [string, string][]) {
  for (const [k, v] of env) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`Ongeldige naam ${k}`);
    if (/[\r\n]/.test(v)) throw new Error(`${k} mag geen regelovergang bevatten`);
  }
  return env.map(([k, v]) => `${k}=${v}`).join("\n");
}

/**
 * Het opstartscript voor de server van een Dienst. Anders dan bij een cloud staan de geheimen hier wél in (in
 * /srv/dienst/dienst.env, alleen leesbaar voor root): de server hoort alleen bij de aanbieder zelf, en de console haalt
 * de user-data bij Scaleway weg zodra de Dienst bereikbaar is. Docker, de Dienst (`node dist/broker/main.js`), Caddy
 * met HTTPS (HTTP-01), de updater (dezelfde als op een cloud) en een dagelijkse controle op een nieuwe versie.
 */
export function dienstUserData(o: DienstInit) {
  if (!/^[a-z0-9.-]+$/.test(o.host) || !/^[^\s@'"]+@[^\s@'"]+$/.test(o.email)) throw new Error("Ongeldig adres of e-mailadres");
  const ad = o.adressen;
  if (ad && !/^[a-z0-9.-]+$/.test(ad.host)) throw new Error("Ongeldige hostnaam voor de adressendienst");
  const prefix = updatePrefix(o.appRef);
  return `#!/bin/bash
# Eigen Cloud Dienst — ${o.host}
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y ca-certificates curl ufw chrony python3
systemctl enable --now chrony
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp
ufw --force enable
umask 077
mkdir -p /srv/dienst/data /srv/dienst/caddy${ad ? " /srv/dienst/adressen" : ""}
cat > /srv/dienst/dienst.env <<'EOF'
${dienstEnvFile(o.env)}
EOF
chmod 600 /srv/dienst/dienst.env
${ad ? `cat > /srv/dienst/adressen.env <<'EOF'
${dienstEnvFile(ad.env)}
EOF
chmod 600 /srv/dienst/adressen.env
` : ""}printf '%s\\n' '${o.appRef}' '${o.caddyRef}' > /srv/dienst/update-refs
cat > /srv/dienst/Caddyfile <<'EOF'
{
\temail ${o.email}
}
${o.host} {
\tencode zstd gzip
\treverse_proxy 127.0.0.1:4100
}
${ad ? `${ad.host} {
\tencode zstd gzip
\treverse_proxy 127.0.0.1:4200
}
` : ""}EOF
cat > /srv/dienst/docker-compose.yml <<'EOF'
services:
  app:
    image: ${o.appImage}  # eigen-app
    restart: unless-stopped
    network_mode: host
    command: ["node", "dist/broker/main.js"]
    stop_grace_period: 2m
    environment:
      - BROKER_ENV_FILE=/etc/dienst/dienst.env
      - BROKER_DATA_DIR=/data
      - BROKER_HOST=127.0.0.1
      - BROKER_PORT=4100
      - BROKER_TRUST_PROXY=loopback
    volumes:
      - /srv/dienst/data:/data
      - /srv/dienst/dienst.env:/etc/dienst/dienst.env:ro
${ad ? `      - /srv/dienst/adressen:/adressen
  adressen:
    image: ${o.appImage}  # eigen-app
    restart: unless-stopped
    network_mode: host
    command: ["node", "dist/adressen/main.js"]
    env_file: /srv/dienst/adressen.env
    environment:
      - ADRES_DATA_DIR=/data
      - ADRES_HOST=127.0.0.1
      - ADRES_PORT=4200
      - ADRES_TRUST_PROXY=loopback
      - ADRES_LOKAAL_SLEUTEL=/dienst/aanbieder.key
      - ADRES_WACHT_OP=/dienst/dienst.sqlite
    volumes:
      - /srv/dienst/adressen:/data
      - /srv/dienst/data:/dienst:ro
` : ""}  caddy:
    image: ${o.caddyImage}  # eigen-caddy
    restart: unless-stopped
    network_mode: host
    command: caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
    volumes:
      - /srv/dienst/Caddyfile:/etc/caddy/Caddyfile:ro
      - /srv/dienst/caddy:/data
EOF
docker pull ${o.appImage}
docker pull ${o.caddyImage}
cd /srv/dienst && docker compose up -d
${prefix ? dienstUpdaterInstall(prefix) : "# geen updates op afstand: image zonder registry-pad"}
`;
}

/** Updater (zelfde script als op een cloud, met de gezondheid van de Dienst) en de dagelijkse controle op een nieuwe versie. */
export function dienstUpdaterInstall(prefix: string) {
  return `printf '%s\\n' '${prefix}' > /srv/dienst/update-allowed
cat > /srv/dienst/eigen-update.sh <<'UPDATER'
${updaterScript()}
UPDATER
cat > /srv/dienst/dienst-check.sh <<'CHECK'
${dienstCheckScript()}
CHECK
chmod 700 /srv/dienst/eigen-update.sh /srv/dienst/dienst-check.sh
cat > /srv/dienst/update.env <<'EOF'
EIGEN_ROOT=/srv/dienst
HEALTH_URL=http://127.0.0.1:4100/v1/status
CADDY_HEALTH_URL=
EOF
cat > /etc/systemd/system/dienst-update.path <<'EOF'
[Path]
PathModified=/srv/dienst/data/update-request.json
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/dienst-update.service <<'EOF'
[Unit]
Description=Eigen Cloud Dienst bijwerken
[Service]
Type=oneshot
EnvironmentFile=/srv/dienst/update.env
ExecStart=/srv/dienst/eigen-update.sh
EOF
cat > /etc/systemd/system/dienst-check.service <<'EOF'
[Unit]
Description=Eigen Cloud Dienst: nieuwe versie zoeken
[Service]
Type=oneshot
EnvironmentFile=/srv/dienst/update.env
ExecStart=/srv/dienst/dienst-check.sh
EOF
cat > /etc/systemd/system/dienst-check.timer <<'EOF'
[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload && systemctl enable --now dienst-update.path dienst-check.timer
echo '{"v":1}' > /srv/dienst/data/updater.json`;
}

/**
 * Dagelijks (systemd-timer): kijkt met de code uit het draaiende image (resolveImage in updates.ts) welke versie de tag
 * in de registry heeft. Is die nieuwer dan wat /v1/status meldt, dan komt er een verzoek voor eigen-update.sh, met vaste
 * versies (image@sha256). Een versie die al eens mislukte, wordt niet opnieuw geprobeerd. Te testen met EIGEN_ROOT.
 */
export function dienstCheckScript() {
  return `#!/bin/bash
# Eigen Cloud Dienst — kijken of er een nieuwere versie is; zo ja: een verzoek voor eigen-update.sh.
set -uo pipefail
ROOT="\${EIGEN_ROOT:-/srv/dienst}"; HEALTH_URL="\${HEALTH_URL:-http://127.0.0.1:4100/v1/status}"
REQ="$ROOT/data/update-request.json"; RES="$ROOT/data/update-result.json"; COMPOSE="$ROOT/docker-compose.yml"
APP_REF=$(sed -n 1p "$ROOT/update-refs" 2>/dev/null); CADDY_REF=$(sed -n 2p "$ROOT/update-refs" 2>/dev/null)
[ -n "$APP_REF" ] || exit 0
CUR_IMAGE=$(sed -nE 's|^    image: (.*)  # eigen-app$|\\1|p' "$COMPOSE" | head -n1)
[ -n "$CUR_IMAGE" ] || exit 0
NOW=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version") or "")') || exit 0
REL=$(docker run --rm --network host --entrypoint node "$CUR_IMAGE" --input-type=module -e 'const { resolveImage } = await import("/app/dist/cluster/updates.js"); const app = await resolveImage(process.argv[1]); const caddy = process.argv[2] ? await resolveImage(process.argv[2]) : null; console.log(JSON.stringify({ version: app.version, app: app.pinned, caddy: caddy ? caddy.pinned : null }));' "$APP_REF" "$CADDY_REF" 2>/dev/null | tail -n1) || exit 0
python3 - "$REL" "$NOW" "$REQ" "$RES" <<'PY'
import json, os, sys, time
rel, now, req, res = sys.argv[1:5]
try:
    r = json.loads(rel)
except Exception:
    sys.exit(0)
def parse(v):
    try:
        return [int(x) for x in str(v).split(".")]
    except Exception:
        return None
new, cur = parse(r.get("version") or ""), parse(now)
if not new or not cur or not r.get("app"):
    sys.exit(0)
n = max(len(new), len(cur))
if new + [0] * (n - len(new)) <= cur + [0] * (n - len(cur)):
    sys.exit(0)
try:
    last = json.load(open(res))
    if last.get("version") == r["version"] and not last.get("ok"):
        sys.exit(0)
except Exception:
    pass
tmp = req + ".tmp"
json.dump({"id": "auto-%s-%d" % (r["version"], int(time.time())), "app": r["app"], "caddy": r.get("caddy"), "version": r["version"]}, open(tmp, "w"))
os.replace(tmp, req)
PY`;
}

/** Caddyfile met DNS-01 (werkt ook als cloud.<domein> naar meerdere servers wijst). */
export function caddyfile(c: ClusterConfig): string | null {
  if (!c.domain) return null;
  // De eerste DNS-koppeling waarvan de adapter een Caddy-module heeft (deSEC, Hetzner, Scaleway, OVHcloud) én waarvoor
  // de velden compleet zijn. Anders (bijv. Exoscale): geen DNS-01, Caddy valt terug op HTTP-01 (zie PROVIDERS.md).
  let d: ClusterConfig["dns"][number] | undefined;
  let dnsLine = "";
  for (const x of c.dns) {
    const mod = getAdapter(x.type)?.dns?.caddy;
    if (!mod) continue;
    // Via de Eigen Cloud Dienst: het token werkt alleen bij de dienst, dus certificaten via diens acme-dns-adres.
    const line = x.api && x.acme ? `dns acmedns {\n\t\t\tusername ${x.acme.username}\n\t\t\tpassword ${x.acme.password}\n\t\t\tsubdomain ${x.acme.subdomain}\n\t\t\tserver_url ${x.acme.server_url}\n\t\t}`
      : x.api ? ""
      : mod({ token: String(x.token), ...dnsFields(x) });
    if (x.api || line) { d = x; dnsLine = line; break; }
  }
  const tls = d && dnsLine ? `\ttls {\n\t\t${dnsLine}\n\t}\n` : "";
  return `{\n\temail postmaster@${c.domain}\n}\ncloud.${c.domain}, mail.${c.domain} {\n${tls}\tencode zstd gzip\n\trequest_body {\n\t\tmax_size 8GB\n\t}\n\treverse_proxy 127.0.0.1:3000\n}\n`;
}

/** Tijdelijke download-links voor de images in je eigen opslag (als ze daar staan). */
export async function imageUrls(store: import("./stores.js").ObjectStore) {
  const out: { imageUrl?: string; caddyUrl?: string } = {};
  if (await store.head("images/eigen-cloud.tar.gz").catch(() => false)) out.imageUrl = store.presignGet("images/eigen-cloud.tar.gz", 7200);
  if (await store.head("images/eigen-caddy.tar.gz").catch(() => false)) out.caddyUrl = store.presignGet("images/eigen-caddy.tar.gz", 7200);
  return out;
}
