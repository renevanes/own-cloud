/** Herkent de fout die SQLite geeft als deze node (nu) niet mag schrijven. */
export function isNotLeader(e: unknown): boolean {
  return e instanceof Error && /NOT_LEADER/.test(e.message);
}
