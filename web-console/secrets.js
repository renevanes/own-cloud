// Wachtwoorden die niemand hoeft te bedenken of te typen, en geheimen plakken vanaf de pagina van een aanbieder.
// Dezelfde regels als android/core …/Passwords.java (de golden-tests vergelijken beide).

/** 31 goed leesbare tekens: geen i, l, o, 0 of 1. */
export const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const GROUPS = 4;
export const GROUP_LENGTH = 5;
export const PATTERN = new RegExp(`^[${ALPHABET}]{5}(-[${ALPHABET}]{5}){3}$`);
export const MAX_PASTE = 4096;

/** Willekeurig getal 0 ≤ n < max zonder voorkeur (afwijzen boven het grootste veelvoud). */
function uniform(max, rnd) {
  const limit = 256 - (256 % max);
  for (;;) {
    const b = new Uint8Array(16);
    rnd(b);
    for (const x of b) if (x < limit) return x % max;
  }
}

/** Sterk wachtwoord, bijv. "kq7mx-2hfpw-9rtzc-v4nsd": ongeveer 99 bits. */
export function generatePassword(rnd = (b) => globalThis.crypto.getRandomValues(b)) {
  const groups = [];
  for (let g = 0; g < GROUPS; g++) {
    let s = "";
    for (let i = 0; i < GROUP_LENGTH; i++) s += ALPHABET[uniform(ALPHABET.length, rnd)];
    groups.push(s);
  }
  return groups.join("-");
}

/** Sterkte van generatePassword in bits. */
export const passwordBits = () => GROUPS * GROUP_LENGTH * Math.log2(ALPHABET.length);

const INVISIBLE = /[\u00AD\u200B\u200C\u200D\u2060\uFEFF]/g;
const SPACES = /[\t\u000B\f\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
const LINES = /\r\n|[\r\n\u0085\u2028\u2029]/;
const QUOTES = [['"', '"'], ["'", "'"], ["`", "`"], ["\u201C", "\u201D"], ["\u201E", "\u201D"], ["\u2018", "\u2019"], ["\u00AB", "\u00BB"]];
const trimSpaces = (s) => s.replace(/^ +| +$/g, "");

/**
 * Een sleutel of token van het klembord zoals het veld hem wil: onzichtbare tekens weg, rare spaties worden gewone,
 * de eerste niet-lege regel, zonder spaties eromheen en zonder één paar aanhalingstekens, hooguit 4096 tekens.
 */
export function normalizeSecret(text) {
  if (text == null) return "";
  const s = String(text).replace(INVISIBLE, "").replace(SPACES, " ");
  let line = "";
  for (const l of s.split(LINES)) {
    const t = trimSpaces(l);
    if (t) { line = t; break; }
  }
  for (const [a, z] of QUOTES) {
    if (line.length >= 2 && line.startsWith(a) && line.endsWith(z)) { line = trimSpaces(line.slice(a.length, line.length - z.length)); break; }
  }
  return line.length > MAX_PASTE ? line.slice(0, MAX_PASTE) : line;
}
