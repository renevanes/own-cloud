package nl.eigencloud.core;

import java.io.IOException;
import java.util.Map;

/**
 * Port of src/cluster/cloudinit.ts. The start script for a new server contains no secrets: only a temporary
 * download URL (expires after 2 hours) and a one-time join token.
 */
public final class CloudInit {
    private CloudInit() {}

    /** Options for {@link #userData}. imageUrl/caddyUrl may be null. */
    public static final class Options {
        public String nodeId;
        /** "data" or "witness". */
        public String kind;
        public String bootstrapUrl;
        public String joinToken;
        public String imageUrl;
        public String caddyUrl;
        /** Vaste versie (image@sha256:…) in plaats van de ingestelde ref; null = ingestelde ref. */
        public String appImage;
        public String caddyImage;

        public Options(String nodeId, String kind, String bootstrapUrl, String joinToken) {
            this.nodeId = nodeId;
            this.kind = kind;
            this.bootstrapUrl = bootstrapUrl;
            this.joinToken = joinToken;
        }

        /** Sets image download URLs (see {@link #imageUrls}). */
        public Options images(String imageUrl, String caddyUrl) {
            this.imageUrl = imageUrl;
            this.caddyUrl = caddyUrl;
            return this;
        }
    }

    private static String or(Object v, String dflt) { return v == null ? dflt : Json.jsString(v); }

    private static String loadImage(String url, String ref) {
        return url != null && !url.isEmpty() ? "curl -fsSL --retry 5 \"" + url + "\" | gunzip | docker load" : "docker pull " + ref;
    }

    /** The cloud-init user-data script (byte-identical to the TS version). */
    public static String userData(Map<String, Object> c, Options o) {
        Map<String, Object> image = Json.map(c, "image");
        if (image == null) image = Json.obj();
        String domain = or(c.get("domain"), "example.nl");
        String appImage = o.appImage != null ? o.appImage : or(image.get("ref"), "eigen-cloud:latest");
        String caddyImage = o.caddyImage != null ? o.caddyImage : or(image.get("caddyRef"), "eigen-caddy:latest");
        String allowedPrefix = updatePrefix(image.get("ref") == null ? null : Json.jsString(image.get("ref")));
        String port = Json.jsString(c.get("clusterPort"));
        boolean data = "data".equals(o.kind);

        String appService = "  app:\n"
                + "    image: " + appImage + "  # eigen-app\n"
                + "    restart: unless-stopped\n"
                + "    network_mode: host\n"
                + "    env_file: /opt/eigen/bootstrap.env\n"
                + "    environment:\n"
                + "      - DATA_DIR=/data\n"
                + "      - HTTP_PORT=3000\n"
                + "      - SMTP_PORT=25\n"
                + "      - CLUSTER_PORT=" + port + "\n"
                + "      - TLS_CERT_FILE=/caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/mail." + domain + "/mail." + domain + ".crt\n"
                + "      - TLS_KEY_FILE=/caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/mail." + domain + "/mail." + domain + ".key\n"
                + "    volumes:\n"
                + "      - /opt/eigen/data:/data\n"
                + "      - /opt/eigen/caddy:/caddy:ro";

        String caddyService = "  caddy:\n"
                + "    image: " + caddyImage + "  # eigen-caddy\n"
                + "    restart: unless-stopped\n"
                + "    network_mode: host\n"
                + "    command: caddy run --config /etc/eigen/Caddyfile --adapter caddyfile --watch\n"
                + "    volumes:\n"
                + "      - /opt/eigen/data:/etc/eigen:ro\n"
                + "      - /opt/eigen/caddy:/data";

        String imageUrl = o.imageUrl != null ? o.imageUrl : (image.get("url") != null ? Json.jsString(image.get("url")) : null);
        String caddyUrl = o.caddyUrl != null ? o.caddyUrl : (image.get("caddyUrl") != null ? Json.jsString(image.get("caddyUrl")) : null);

        return "#!/bin/bash\n"
                + "# Eigen Cloud — " + o.kind + "-node " + o.nodeId + " (cluster " + Json.jsString(c.get("cluster")) + ")\n"
                + "set -euo pipefail\n"
                + "export DEBIAN_FRONTEND=noninteractive\n"
                + "apt-get update -y && apt-get install -y ca-certificates curl ufw chrony\n"
                + "systemctl enable --now chrony\n"
                + "command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh\n"
                + "ufw allow 22/tcp; ufw allow " + port + "/tcp\n"
                + (data ? "ufw allow 25/tcp; ufw allow 80/tcp; ufw allow 443/tcp" : "") + "\n"
                + "ufw --force enable\n"
                + "mkdir -p /opt/eigen/data /opt/eigen/caddy\n"
                + "umask 077\n"
                + "cat > /opt/eigen/bootstrap.env <<'EOF'\n"
                + "NODE_ID=" + o.nodeId + "\n"
                + "BOOTSTRAP_URL=" + o.bootstrapUrl + "\n"
                + "JOIN_TOKEN=" + o.joinToken + "\n"
                + "EOF\n"
                + loadImage(imageUrl, appImage) + "\n"
                + (data ? loadImage(caddyUrl, caddyImage) : "") + "\n"
                + (data ? "echo ':80 {\n\trespond \"eigen-cloud start op\" 503\n}' > /opt/eigen/data/Caddyfile" : "") + "\n"
                + "cat > /opt/eigen/docker-compose.yml <<'EOF'\n"
                + "services:\n"
                + appService + "\n"
                + (data ? caddyService : "") + "\n"
                + "EOF\n"
                + "cd /opt/eigen && docker compose up -d\n"
                + (allowedPrefix != null ? UpdaterInstall.text(allowedPrefix, port) : "# geen updates op afstand: image zonder registry-pad") + "\n";
    }

    private static final java.util.regex.Pattern PREFIX = java.util.regex.Pattern.compile("^([a-z0-9.-]+\\.[a-z]{2,}(?::\\d+)?/(?:[a-z0-9._-]+/)*)[a-z0-9._-]+(?:[:@].*)?$");

    /** Registry-map waaruit updates mogen komen ("ghcr.io/renevanes/"), of null. */
    public static String updatePrefix(String ref) {
        java.util.regex.Matcher m = PREFIX.matcher(ref == null ? "" : ref);
        return m.matches() ? m.group(1) : null;
    }

    /** Caddyfile with DNS-01; null when the config has no domain. */
    public static String caddyfile(Map<String, Object> c) {
        if (!Json.truthy(c.get("domain"))) return null;
        String domain = Json.jsString(c.get("domain"));
        Map<String, Object> d = null;
        for (Object x : Json.listAt(c, "dns")) {
            String t = Json.str(x, "type");
            if ("desec".equals(t) || "hetzner".equals(t)) { d = Json.asMap(x); break; }
        }
        String token = d == null ? null : (d.get("token") == null ? "undefined" : Json.jsString(d.get("token")));
        Map<String, Object> acme = d == null ? null : Json.map(d, "acme");
        boolean viaService = d != null && Json.truthy(d.get("api"));
        String dnsLine = viaService && acme != null
                ? "dns acmedns {\n\t\t\tusername " + Json.jsString(acme.get("username")) + "\n\t\t\tpassword " + Json.jsString(acme.get("password"))
                  + "\n\t\t\tsubdomain " + Json.jsString(acme.get("subdomain")) + "\n\t\t\tserver_url " + Json.jsString(acme.get("server_url")) + "\n\t\t}"
                : viaService ? ""
                : d != null && "desec".equals(d.get("type")) ? "dns desec {\n\t\t\ttoken " + token + "\n\t\t}" : d != null ? "dns hetzner " + token : "";
        String tls = d != null && !dnsLine.isEmpty() ? "\ttls {\n\t\t" + dnsLine + "\n\t}\n" : "";
        return "{\n\temail postmaster@" + domain + "\n}\ncloud." + domain + ", mail." + domain + " {\n" + tls
                + "\tencode zstd gzip\n\trequest_body {\n\t\tmax_size 8GB\n\t}\n\treverse_proxy 127.0.0.1:3000\n}\n";
    }

    /** Temporary download links for the images in your own storage (if they are there). Keys: imageUrl, caddyUrl. */
    public static Options imageUrls(ObjectStore store, Options into) {
        if (headQuiet(store, "images/eigen-cloud.tar.gz")) into.imageUrl = store.presignGet("images/eigen-cloud.tar.gz", 7200);
        if (headQuiet(store, "images/eigen-caddy.tar.gz")) into.caddyUrl = store.presignGet("images/eigen-caddy.tar.gz", 7200);
        return into;
    }

    private static boolean headQuiet(ObjectStore s, String key) {
        try {
            return s.head(key);
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    // ───────── De Eigen Cloud Dienst van een aanbieder (dienstUserData in cloudinit.ts) ─────────

    /** Wat er op de server van een Dienst komt. env: paren {naam, waarde} in vaste volgorde. */
    public static final class DienstInit {
        public String host, email, appImage, caddyImage, appRef, caddyRef;
        public java.util.List<String[]> env = new java.util.ArrayList<>();
    }

    private static final java.util.regex.Pattern ENV_NAME = java.util.regex.Pattern.compile("^[A-Z][A-Z0-9_]*$");
    private static final java.util.regex.Pattern HOST = java.util.regex.Pattern.compile("^[a-z0-9.-]+$");
    private static final java.util.regex.Pattern MAIL = java.util.regex.Pattern.compile("^[^\\s@'\"]+@[^\\s@'\"]+$");

    /** dienst.env: regels NAAM=waarde, letterlijk (de Dienst leest het bestand zelf); geen regelovergangen. */
    public static String dienstEnvFile(java.util.List<String[]> env) {
        StringBuilder b = new StringBuilder();
        for (String[] kv : env) {
            if (!ENV_NAME.matcher(kv[0]).matches()) throw new IllegalArgumentException("Ongeldige naam " + kv[0]);
            if (kv[1].indexOf('\n') >= 0 || kv[1].indexOf('\r') >= 0) throw new IllegalArgumentException(kv[0] + " mag geen regelovergang bevatten");
            if (b.length() > 0) b.append('\n');
            b.append(kv[0]).append('=').append(kv[1]);
        }
        return b.toString();
    }

    /** Het opstartscript voor de server van een Dienst (tekst gelijk aan de TS-versie). */
    public static String dienstUserData(DienstInit o) {
        if (!HOST.matcher(o.host).matches() || !MAIL.matcher(o.email).matches()) throw new IllegalArgumentException("Ongeldig adres of e-mailadres");
        String prefix = updatePrefix(o.appRef);
        String head = DienstTemplates.HEAD.replace("@@HOST@@", o.host).replace("@@EMAIL@@", o.email)
                .replace("@@APP_IMAGE@@", o.appImage).replace("@@CADDY_IMAGE@@", o.caddyImage)
                .replace("@@APP_REF@@", o.appRef).replace("@@CADDY_REF@@", o.caddyRef)
                .replace("@@ENV@@", dienstEnvFile(o.env));
        return head + (prefix != null ? DienstTemplates.UPDATER.replace("@@PREFIX@@", prefix) : "# geen updates op afstand: image zonder registry-pad") + "\n";
    }

    /** Het updatescript (updaterScript in cloudinit.ts). */
    public static String updaterScript() { return UpdaterInstall.script(); }

    /** De dagelijkse versiecontrole op de server van een Dienst (dienstCheckScript in cloudinit.ts). */
    public static String dienstCheckScript() {
        String t = DienstTemplates.UPDATER;
        int a = t.indexOf("<<'CHECK'\n") + "<<'CHECK'\n".length();
        return t.substring(a, t.indexOf("\nCHECK\n", a));
    }
}
