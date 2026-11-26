// Number pool (2026-11-23, Zaib): the owner keeps a pool of WhatsApp
// numbers in number-pool.json. A business CLAIMS one number from the
// pool (one number per business) and that number becomes its own
// WhatsApp number (business.phone). Claiming is NOT linking — it never
// sets business.linked; the number still has to be linked on the
// Connect page with a pairing code. Releasing a number returns it to
// the pool. Pure claim/release logic lives here so it can be tested
// without I/O; server.js does the load/save around it. Sync JSON file
// I/O, same pattern as src/store.js.
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');

// Claim rules (2026-11-26, Zaib approved multi-account pairing):
//   EXCLUSIVE_TAKE = true — a number claimed by one business can NEVER
//   be claimed by another business. Flipping this to false is the
//   pending copy-vs-take decision — Zaib has NOT answered it yet, so
//   do NOT change exclusivity here.
//   ONE_PER_ACCOUNT = true — one pool number per ACCOUNT, not per
//   business. A business holding one claimed number CAN claim another
//   one for a second linked WhatsApp account. business.claimedPhones
//   tracks every number the business holds; business.claimedPhone and
//   business.phone stay the FIRST (primary) number for backward
//   compatibility with anything that reads the single-number fields.
const EXCLUSIVE_TAKE = true;
const ONE_PER_ACCOUNT = true;

const POOL_FILE = path.join(store.DATA_DIR, 'number-pool.json');

function loadPool() {
  try {
    const data = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
    if (data && Array.isArray(data.numbers)) {
      // Old pool files have no history — it starts empty, never crashes.
      return { numbers: data.numbers, history: Array.isArray(data.history) ? data.history : [] };
    }
    return { numbers: [], history: [] };
  } catch (_) {
    return { numbers: [], history: [] };
  }
}

function savePool(pool) {
  fs.mkdirSync(store.DATA_DIR, { recursive: true });
  fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2));
  return pool;
}

// Same rules as normalizePhone in server.js: strip non-digits, then
// turn Pakistani local numbers into international form —
// 03114033546 -> 923114033546, 3114033546 -> 923114033546. A number
// already in international form (923...) passes through unchanged.
// Returns '' when the value cannot be a 10-15 digit phone number.
function normalizePoolPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('03')) d = '92' + d.slice(1);
  else if (d.length === 10 && d.startsWith('3')) d = '92' + d;
  if (!d || d.length < 10 || d.length > 15) return '';
  return d;
}

// Add raw phone strings to the pool. Pure function, no I/O.
// Skipped (already in the pool in any status, or already owned as some
// business's phone/claimedPhone) and invalid entries are reported, not
// added. A duplicate inside `phones` itself counts as skipped on its
// second occurrence, because the first one just joined the pool.
function addNumbersToPool(pool, phones, inUsePhones) {
  pool.numbers = Array.isArray(pool.numbers) ? pool.numbers : [];
  const inPool = new Set(pool.numbers.map((n) => n.phone));
  const inUse = new Set();
  for (const v of inUsePhones || []) {
    const d = String(v || '').replace(/\D/g, '');
    if (d) inUse.add(d);
    const n = normalizePoolPhone(v);
    if (n) inUse.add(n);
  }
  const added = [];
  const skipped = [];
  const invalid = [];
  for (const raw of phones || []) {
    const phone = normalizePoolPhone(raw);
    if (!phone) {
      invalid.push(raw);
      continue;
    }
    if (inPool.has(phone) || inUse.has(phone)) {
      skipped.push(phone);
      continue;
    }
    pool.numbers.push({ phone, status: 'available', claimedBy: null, claimedAt: null });
    inPool.add(phone);
    added.push(phone);
  }
  return { added, skipped, invalid };
}

// Claim one pool number for a business. Pure function, no I/O — the
// caller saves the pool and the business afterwards. Rules in order:
// (1) the phone must be valid, (2) the number must be in the pool and
// available — with EXCLUSIVE_TAKE a number claimed by one business can
// never be claimed by another, (3) with ONE_PER_ACCOUNT a business may
// hold one number per ACCOUNT, so holding one claimed number does NOT
// block claiming another for a second account. On success the pool
// entry and the business are mutated in place: the number joins
// business.claimedPhones, and business.claimedPhone / business.phone
// are set only when the business holds no number yet (they stay the
// primary/first number — a second claim never overwrites them).
// Claiming is NOT linking — business.linked is never touched here.
function claimNumber(pool, business, phone) {
  const normalized = normalizePoolPhone(phone);
  if (!normalized) return { ok: false, error: 'Valid phone number is required, 10-15 digits' };
  const entry = (pool.numbers || []).find((n) => n.phone === normalized);
  if (!entry || entry.status !== 'available') {
    return { ok: false, error: 'This number is not available — it was already claimed or was never added to the pool.' };
  }
  if (EXCLUSIVE_TAKE && entry.claimedBy && entry.claimedBy !== business.id) {
    return { ok: false, error: 'This number is not available — it was already claimed or was never added to the pool.' };
  }
  if (!ONE_PER_ACCOUNT && business.claimedPhone) {
    return { ok: false, error: 'This business already claimed ' + business.claimedPhone + ' — one number per business. Release it first to claim another.' };
  }
  entry.status = 'claimed';
  entry.claimedBy = business.id;
  entry.claimedAt = new Date().toISOString();
  business.claimedPhones = Array.isArray(business.claimedPhones)
    ? business.claimedPhones
    : (business.claimedPhone ? [business.claimedPhone] : []);
  if (!business.claimedPhones.includes(normalized)) business.claimedPhones.push(normalized);
  if (!business.claimedPhone) business.claimedPhone = normalized;
  if (!business.phone) business.phone = normalized;
  return { ok: true, phone: normalized };
}

// Release a number back to the pool. Pure function, no I/O — the
// caller saves the pool and the business afterwards. Only the business
// that claimed the number can release it, and only a claimed number
// can be released. The number leaves business.claimedPhones; when it
// was the first (primary) claimed number, the next claimed number is
// promoted to claimedPhone / phone, and when nothing is claimed any
// more both are cleared. A number the business paired but never
// claimed is untouched here — release only ever frees pool claims.
function releaseNumber(pool, business, phone) {
  const normalized = normalizePoolPhone(phone);
  const entry = (pool.numbers || []).find((n) => n.phone === normalized);
  if (!entry || entry.status !== 'claimed') return { ok: false, error: 'Number is not claimed' };
  if (entry.claimedBy !== business.id) return { ok: false, error: 'This number was claimed by another business' };
  entry.status = 'available';
  entry.claimedBy = null;
  entry.claimedAt = null;
  business.claimedPhones = Array.isArray(business.claimedPhones)
    ? business.claimedPhones.filter((p) => p !== normalized)
    : (business.claimedPhone && business.claimedPhone !== normalized ? [business.claimedPhone] : []);
  if (business.claimedPhone === normalized) {
    const next = business.claimedPhones[0] || '';
    if (next) {
      business.claimedPhone = next;
      if (business.phone === normalized) business.phone = next;
    } else {
      delete business.claimedPhone;
      if (business.phone === normalized) business.phone = '';
    }
  }
  // A released number must not linger as a pairable account: drop its
  // accounts[] entry (if any), so this business cannot re-pair a number
  // another business now holds — WhatsApp would revoke one of the two
  // sessions. Then re-mirror the primary account (same rule as
  // syncPrimaryLinkFields in whatsapp.js). When the last account goes,
  // the linked flag is cleared only if the dropped entry itself was
  // linked — a legacy business with linked=true but no accounts[]
  // entries keeps its flag.
  if (Array.isArray(business.accounts)) {
    let droppedLinked = false;
    const kept = [];
    for (const a of business.accounts) {
      if (a && a.phone === normalized) { if (a.linked === true) droppedLinked = true; }
      else kept.push(a);
    }
    if (kept.length !== business.accounts.length) {
      business.accounts = kept;
      if (kept.length > 0) {
        const p = kept[0];
        if (p.phone) business.phone = p.phone;
        business.linked = p.linked === true;
        business.linkedAt = p.linked === true ? (p.linkedAt || business.linkedAt || null) : null;
      } else if (droppedLinked) {
        business.linked = false;
        business.linkedAt = null;
      }
    }
  }
  return { ok: true, phone: normalized };
}

// Upload history (2026-11-23, Zaib: "vah record bhi sev hoga"): every
// admin upload is saved in the pool file, so the record survives a
// restart and the dashboard can show how many numbers were ever
// uploaded. `result` is the { added, skipped, invalid } arrays from
// addNumbersToPool. History is capped so the file never grows without
// bound — the oldest entries drop off first.
const POOL_HISTORY_MAX = 50;

function recordPoolUpload(pool, result) {
  pool.numbers = Array.isArray(pool.numbers) ? pool.numbers : [];
  pool.history = Array.isArray(pool.history) ? pool.history : [];
  pool.history.push({
    at: new Date().toISOString(),
    added: Array.isArray(result && result.added) ? result.added.slice() : [],
    skipped: Array.isArray(result && result.skipped) ? result.skipped.slice() : [],
    invalid: Array.isArray(result && result.invalid) ? result.invalid.slice() : [],
  });
  while (pool.history.length > POOL_HISTORY_MAX) pool.history.shift();
  return pool.history[pool.history.length - 1];
}

// One-time migration (2026-11-23): the pool existed before upload history
// was tracked — a pool that already holds numbers but has no history gets
// one seed entry for those numbers, so "numbers uploaded" is true from the
// first dashboard load. Runs once: after the seed, history is non-empty,
// so a second call does nothing. Never throws on a malformed pool.
function seedPoolHistoryIfMissing(pool) {
  pool.numbers = Array.isArray(pool.numbers) ? pool.numbers : [];
  pool.history = Array.isArray(pool.history) ? pool.history : [];
  if (pool.numbers.length === 0 || pool.history.length > 0) return false;
  pool.history.push({
    at: new Date().toISOString(),
    added: pool.numbers.map((n) => n.phone),
    skipped: [],
    invalid: [],
  });
  return true;
}

// Total numbers ever uploaded to the pool (sum of every history entry's
// added list) — the dashboard's "numbers uploaded" card. Releases do
// not subtract: the number WAS uploaded, and the pool list itself shows
// what is still there.
function totalNumbersUploaded(pool) {
  let total = 0;
  for (const h of (pool && pool.history) || []) total += (h.added || []).length;
  return total;
}

module.exports = { POOL_FILE, loadPool, savePool, normalizePoolPhone, addNumbersToPool, claimNumber, releaseNumber, recordPoolUpload, totalNumbersUploaded, seedPoolHistoryIfMissing, POOL_HISTORY_MAX, EXCLUSIVE_TAKE, ONE_PER_ACCOUNT };
