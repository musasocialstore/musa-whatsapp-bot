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
// (1) the phone must be valid, (2) the business must not already hold
// a claimed number, (3) the number must be in the pool and available.
// On success the pool entry and the business are mutated in place:
// the number becomes the business's own number (business.phone) —
// claiming is NOT linking, business.linked is never touched here.
function claimNumber(pool, business, phone) {
  const normalized = normalizePoolPhone(phone);
  if (!normalized) return { ok: false, error: 'Valid phone number is required, 10-15 digits' };
  if (business.claimedPhone) {
    return { ok: false, error: 'This business already claimed ' + business.claimedPhone + ' — one number per business. Release it first to claim another.' };
  }
  const entry = (pool.numbers || []).find((n) => n.phone === normalized);
  if (!entry || entry.status !== 'available') {
    return { ok: false, error: 'This number is not available — it was already claimed or was never added to the pool.' };
  }
  entry.status = 'claimed';
  entry.claimedBy = business.id;
  entry.claimedAt = new Date().toISOString();
  business.claimedPhone = normalized;
  business.phone = normalized;
  return { ok: true, phone: normalized };
}

// Release a number back to the pool. Pure function, no I/O — the
// caller saves the pool and the business afterwards. Only the business
// that claimed the number can release it, and only a claimed number
// can be released. The business's own number is cleared only when it
// is the released number.
function releaseNumber(pool, business, phone) {
  const normalized = normalizePoolPhone(phone);
  const entry = (pool.numbers || []).find((n) => n.phone === normalized);
  if (!entry || entry.status !== 'claimed') return { ok: false, error: 'Number is not claimed' };
  if (entry.claimedBy !== business.id) return { ok: false, error: 'This number was claimed by another business' };
  entry.status = 'available';
  entry.claimedBy = null;
  entry.claimedAt = null;
  if (business.claimedPhone === normalized) {
    delete business.claimedPhone;
    if (business.phone === normalized) business.phone = '';
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

// Total numbers ever uploaded to the pool (sum of every history entry's
// added list) — the dashboard's "numbers uploaded" card. Releases do
// not subtract: the number WAS uploaded, and the pool list itself shows
// what is still there.
function totalNumbersUploaded(pool) {
  let total = 0;
  for (const h of (pool && pool.history) || []) total += (h.added || []).length;
  return total;
}

module.exports = { POOL_FILE, loadPool, savePool, normalizePoolPhone, addNumbersToPool, claimNumber, releaseNumber, recordPoolUpload, totalNumbersUploaded, POOL_HISTORY_MAX };
