import type { FastifyRequest } from "fastify";

export const revisionTag = (kind: string, id: string | number, revision: number) => `"${kind}-${id}-${revision}"`;
export function checkRevision(req: FastifyRequest, tag: string | null) {
  const match = req.headers["if-match"], none = req.headers["if-none-match"];
  if (match && (!tag || (match !== "*" && !String(match).split(/,\s*/).includes(tag))))
    throw Object.assign(new Error("Dit is op een ander apparaat gewijzigd. Haal de nieuwste versie op."), { statusCode: 412 });
  if (none && tag && (none === "*" || String(none).split(/,\s*/).includes(tag)))
    throw Object.assign(new Error("Dit bestaat al. Haal de nieuwste versie op."), { statusCode: 412 });
}
