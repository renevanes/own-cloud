/**
 * Een heel kleine S3-nepserver (path-style, zonder handtekeningcontrole) voor tests van de beheerconsole:
 * buckets aanmaken/verwijderen, versiebeheer, object-lock in GOVERNANCE-modus en ListObjectVersions.
 */
import http from "node:http";

type Version = { id: string; body: Buffer | null; lockedUntil: number };
type Bucket = { lock: boolean; versioning: boolean; retentionDays: number; objects: Map<string, Version[]> };

export function fakeS3() {
  const buckets = new Map<string, Bucket>();
  let n = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const u = new URL(req.url!, "http://x");
      const [, bucketName, ...rest] = decodeURIComponent(u.pathname).split("/");
      const key = rest.join("/");
      const body = Buffer.concat(chunks);
      const send = (s: number, xml = "") => { res.writeHead(s, { "content-type": "application/xml" }); res.end(xml); };
      const err = (s: number, code: string) => send(s, `<Error><Code>${code}</Code></Error>`);
      if (!bucketName) return send(200, `<ListAllMyBucketsResult><Buckets>${[...buckets.keys()].map((b) => `<Bucket><Name>${b}</Name></Bucket>`).join("")}</Buckets></ListAllMyBucketsResult>`);
      const b = buckets.get(bucketName);
      if (!key) {
        if (req.method === "HEAD") return send(b ? 200 : 404);
        if (req.method === "PUT" && u.searchParams.has("versioning")) { if (!b) return err(404, "NoSuchBucket"); b.versioning = /Enabled/.test(body.toString()); return send(200); }
        if (req.method === "PUT" && u.searchParams.has("object-lock")) {
          if (!b) return err(404, "NoSuchBucket");
          if (!b.lock) return err(409, "InvalidBucketState");
          b.retentionDays = Number(/<Days>(\d+)<\/Days>/.exec(body.toString())?.[1] ?? 0);
          return send(200);
        }
        if (req.method === "PUT") {
          if (b) return err(409, "BucketAlreadyOwnedByYou");
          const lock = req.headers["x-amz-bucket-object-lock-enabled"] === "true";
          buckets.set(bucketName, { lock, versioning: lock, retentionDays: 0, objects: new Map() });
          return send(200);
        }
        if (!b) return err(404, "NoSuchBucket");
        if (req.method === "GET" && u.searchParams.get("list-type") === "2") {
          const pfx = u.searchParams.get("prefix") ?? "";
          const items = [...b.objects].filter(([k, vs]) => k.startsWith(pfx) && vs[vs.length - 1]?.body).map(([k, vs]) => `<Contents><Key>${k}</Key><Size>${vs[vs.length - 1].body!.length}</Size></Contents>`);
          return send(200, `<ListBucketResult>${items.join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`);
        }
        if (req.method === "GET" && u.searchParams.has("versions")) {
          const items = [...b.objects].flatMap(([k, vs]) => vs.map((v) => v.body ? `<Version><Key>${k}</Key><VersionId>${v.id}</VersionId></Version>` : `<DeleteMarker><Key>${k}</Key><VersionId>${v.id}</VersionId></DeleteMarker>`));
          return send(200, `<ListVersionsResult>${items.join("")}</ListVersionsResult>`);
        }
        if (req.method === "DELETE") {
          if ([...b.objects.values()].some((vs) => vs.length)) return err(409, "BucketNotEmpty");
          buckets.delete(bucketName);
          return send(204);
        }
        return err(400, "NotSupported");
      }
      if (!b) return err(404, "NoSuchBucket");
      const vs = b.objects.get(key) ?? [];
      if (req.method === "PUT") {
        const v = { id: b.versioning ? `v${++n}` : "null", body, lockedUntil: b.retentionDays ? Date.now() + b.retentionDays * 86400_000 : 0 };
        b.objects.set(key, b.versioning ? [...vs, v] : [v]);
        return send(200);
      }
      const cur = vs[vs.length - 1];
      if (req.method === "GET" || req.method === "HEAD") return cur?.body ? (res.writeHead(200), res.end(req.method === "GET" ? cur.body : undefined)) : err(404, "NoSuchKey");
      if (req.method === "DELETE") {
        const vid = u.searchParams.get("versionId");
        if (vid) {
          const v = vs.find((x) => x.id === vid);
          if (!v) return send(204);
          if (v.lockedUntil > Date.now() && req.headers["x-amz-bypass-governance-retention"] !== "true") return err(403, "AccessDenied");
          b.objects.set(key, vs.filter((x) => x !== v));
          return send(204);
        }
        if (b.versioning) b.objects.set(key, [...vs, { id: `v${++n}`, body: null, lockedUntil: 0 }]);
        else b.objects.delete(key);
        return send(204);
      }
      return err(400, "NotSupported");
    });
  });
  const listening = new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)));
  return { buckets, listening, close: () => new Promise<void>((r) => server.close(() => r())) };
}
