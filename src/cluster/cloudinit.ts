import type { ClusterConfig } from "./config.js";

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
healthy() {
  local body
  body=$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/cluster/health" 2>/dev/null) || return 1
  python3 -c 'import json,sys; sys.exit(0 if json.loads(sys.argv[1]).get("version")==sys.argv[2] else 1)' "$body" "$VERSION" || return 1
  if [ "$HAS_CADDY" = 1 ]; then curl -fsS --max-time 3 http://127.0.0.1:3000/healthz >/dev/null 2>&1 || return 1; fi
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

/** Caddyfile met DNS-01 (werkt ook als cloud.<domein> naar meerdere servers wijst). */
export function caddyfile(c: ClusterConfig): string | null {
  if (!c.domain) return null;
  const d = c.dns.find((x) => x.type === "desec" || x.type === "hetzner");
  // Via de Eigen Cloud Dienst: het token werkt alleen bij de dienst, dus certificaten via diens acme-dns-adres.
  const dnsLine = d?.api && d.acme ? `dns acmedns {\n\t\t\tusername ${d.acme.username}\n\t\t\tpassword ${d.acme.password}\n\t\t\tsubdomain ${d.acme.subdomain}\n\t\t\tserver_url ${d.acme.server_url}\n\t\t}`
    : d?.api ? ""
    : d?.type === "desec" ? `dns desec {\n\t\t\ttoken ${d.token}\n\t\t}` : d ? `dns hetzner ${d.token}` : "";
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
