// Bulk Messages — number parsing + wa.me links.
// The same rules run on the server (here) and in the browser preview
// (public/bulk.js, duplicated small on purpose) — the server always
// re-validates, so a tampered preview can never sneak a bad number in.
// No ads, no premium, no admin: just the user's own numbers + message.
'use strict';

const MAX_NUMBERS = 100;

// Normalize ONE raw token to a +92... number, or null when it is not one.
// Accepts: 03XXXXXXXXX (11 digits), +92XXXXXXXXXX, 92XXXXXXXXXX.
// Anything else (short numbers, letters, wrong country) is invalid.
function normalizeNumber(raw) {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Strip the separators people paste: spaces, dashes, brackets, dots.
  s = s.replace(/[\s\-().]/g, '');
  if (/^03\d{9}$/.test(s)) return '+92' + s.slice(1);
  if (/^\+92\d{10}$/.test(s)) return s;
  if (/^92\d{10}$/.test(s)) return '+' + s;
  return null;
}

// Split a pasted blob (commas, newlines, semicolons, spaces) into
// { valid: [{ phone }], duplicates: n, invalid: [raw strings] }.
// Dedup is by normalized phone, keeping first-seen order.
function parseNumbers(rawText) {
  const tokens = String(rawText || '').split(/[,;\n]+/);
  const seen = new Set();
  const valid = [];
  const invalid = [];
  let duplicates = 0;
  for (const token of tokens) {
    const t = token.trim();
    if (!t) continue;
    const phone = normalizeNumber(t);
    if (!phone) { invalid.push(t); continue; }
    if (seen.has(phone)) { duplicates++; continue; }
    seen.add(phone);
    valid.push({ phone });
  }
  return { valid, duplicates, invalid };
}

// Prefilled chat link for a draft number: opens the chat on the owner's
// phone with the message already typed, so they press send when ready.
function waLink(phone, message) {
  const digits = String(phone || '').replace(/\D/g, '');
  return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(String(message || ''));
}

module.exports = { parseNumbers, normalizeNumber, waLink, MAX_NUMBERS };
