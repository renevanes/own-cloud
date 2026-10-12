const windows = new Map<string, { count: number; until: number }>();

/** Fixed windows with a bounded key set, used before costly account operations. */
export function checkRateLimit(key: string, limit = 20, windowMs = 10 * 60_000) {
  const now = Date.now();
  let w = windows.get(key);
  if (!w || w.until <= now) {
    if (windows.size >= 5000) for (const [k, v] of windows) { if (v.until <= now) windows.delete(k); }
    if (windows.size >= 5000) windows.delete(windows.keys().next().value!);
    w = { count: 0, until: now + windowMs }; windows.set(key, w);
  }
  if (++w.count > limit) throw Object.assign(new Error("Te veel pogingen. Probeer het later opnieuw."), { statusCode: 429 });
}
