import type { ClusterConfig } from "./config.js";

/**
 * Het opstartscript voor een nieuwe server. Bevat GEEN geheimen: alleen een tijdelijke download-URL
 * (verloopt na 2 uur) en een eenmalige join-token. De echte configuratie staat versleuteld in de opslag
 * en wordt na het aansluiten verwijderd — dus ook als de aanbieder de user-data bewaart, lekt er niets bruikbaars.
 */
export function userData(c: ClusterConfig, opts: { nodeId: string; kind: "data" | "witness"; bootstrapUrl: string; joinToken: string; imageUrl?: string; caddyUrl?: string }) {
  const domain = c.domain ?? "example.nl";
  const appImage = c.image.ref ?? "eigen-cloud:latest";
  const caddyImage = (c.image as { caddyRef?: string }).caddyRef ?? "eigen-caddy:latest";

  const loadImage = (url: string | undefined, ref: string) =>
    url ? `curl -fsSL --retry 5 "${url}" | gunzip | docker load` : `docker pull ${ref}`;

  const appService = `  app:
    image: ${appImage}
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
    image: ${caddyImage}
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
`;
}

/** Caddyfile met DNS-01 (werkt ook als cloud.<domein> naar meerdere servers wijst). */
export function caddyfile(c: ClusterConfig): string | null {
  if (!c.domain) return null;
  const d = c.dns.find((x) => x.type === "desec" || x.type === "hetzner");
  const dnsLine = d?.type === "desec" ? `dns desec {\n\t\t\ttoken ${d.token}\n\t\t}` : d ? `dns hetzner ${d.token}` : "";
  const tls = d ? `\ttls {\n\t\t${dnsLine}\n\t}\n` : "";
  return `{\n\temail postmaster@${c.domain}\n}\ncloud.${c.domain}, mail.${c.domain} {\n${tls}\tencode zstd gzip\n\trequest_body {\n\t\tmax_size 8GB\n\t}\n\treverse_proxy 127.0.0.1:3000\n}\n`;
}

/** Tijdelijke download-links voor de images in je eigen opslag (als ze daar staan). */
export async function imageUrls(store: import("./stores.js").ObjectStore) {
  const out: { imageUrl?: string; caddyUrl?: string } = {};
  if (await store.head("images/eigen-cloud.tar.gz").catch(() => false)) out.imageUrl = store.presignGet("images/eigen-cloud.tar.gz", 7200);
  if (await store.head("images/eigen-caddy.tar.gz").catch(() => false)) out.caddyUrl = store.presignGet("images/eigen-caddy.tar.gz", 7200);
  return out;
}
