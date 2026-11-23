// Musa WhatsApp Bot Platform — Express server.
// Dashboard: public/index.html + public/app.js + public/style.css
// Sections (in order): 1. WhatsApp Connect (pairing code + status)
//   2. Business Prompt / Plan  3. Media Upload  4. Lead Notification Settings
//   5. Leads (list + confirm -> forward by email + WhatsApp)
// API: /api/business/:id/*  — see README.md for the full list.
// Run: npm install && cp .env.example .env  (fill in keys) && npm start
'use strict';

// CRYPTO POLYFILL (2026-11-20, "Error: crypto is not defined" on Railway):
// Railway runs Node 18 and installs Baileys WITHOUT the local lockfile, so
// ^6.7.18 resolved to 6.17.16, whose lib/Utils/crypto.js calls bare
// `crypto.subtle` (WebCrypto global) — that bare name does not exist on
// Node 18, so every pairing-code request died with "crypto is not defined"
// BEFORE any code was issued (no lockout was burned). Define the global
// from Node's own webcrypto BEFORE anything requires Baileys, so the bare
// name resolves on any Node >= 16. (Baileys is also pinned to exact 6.7.24
// in package.json, which uses globalThis.crypto instead.)
if (typeof globalThis.crypto === 'undefined') {
  try { globalThis.crypto = require('crypto').webcrypto; } catch (_) {}
}

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const store = require('./src/store');
const whatsapp = require('./src/whatsapp');
const activity = require('./src/activity');
const numberPool = require('./src/number-pool');
const leads = require('./src/leads');
const ai = require('./src/ai');
const linkSetup = require('./src/linkSetup');
const bulk = require('./src/bulk');
const { execFile } = require('child_process');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_ROOT = path.join(store.DATA_DIR, 'uploads');

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
// Private live-activity page (2026-11-22, Zaib): /activity.html is
// unlisted — no link to it anywhere on the board — and token-gated.
// A missing or wrong token gets a plain 404, never a hint it exists.
// This MUST run before express.static, or the file would be served
// without the check.
app.use((req, res, next) => {
  if (req.path !== '/activity.html') return next();
  const business = store.getBusiness(businessId(req));
  if (!activity.activityTokenMatches(business, String(req.query.t || ''))) return res.status(404).send('Not found');
  next();
});
// Private admin page (2026-11-23, Zaib): /admin.html is unlisted and
// token-gated against the owner's (musa-social-store) activity token,
// same shape as the /activity.html gate above. A missing or wrong
// token gets a plain 404, never a hint it exists. This MUST run before
// express.static, or the file would be served without the check.
app.use((req, res, next) => {
  if (req.path !== '/admin.html') return next();
  const owner = store.getBusiness('musa-social-store');
  if (!activity.activityTokenMatches(owner, String(req.query.t || ''))) return res.status(404).send('Not found');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(UPLOAD_ROOT));

function businessId(req) {
  return String(req.params.id || req.query.businessId || 'musa-social-store').trim() || 'musa-social-store';
}

function cleanPhone(v) {
  return String(v || '').replace(/\D/g, '');
}

// Normalize a phone number BEFORE validation: strip spaces, dashes and
// a leading '+' (cleanPhone does that), then turn Pakistani local
// numbers into international form — 03114033546 -> 923114033546,
// 3114033546 -> 923114033546. A number already in international form
// (923...) passes through unchanged.
function normalizePhone(v) {
  let d = cleanPhone(v);
  if (d.length === 11 && d.startsWith('03')) d = '92' + d.slice(1);
  else if (d.length === 10 && d.startsWith('3')) d = '92' + d;
  return d;
}

// --- Health ---
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// --- 1. WhatsApp Connect: REAL pairing code from Baileys, in real time ---
// The code comes from sock.requestPairingCode(phone) — never invented here.
// If Baileys fails, the real error is returned and NO code is shown.
app.post('/api/business/:id/pairing-code', async (req, res) => {
  try {
    const id = businessId(req);
    const phone = normalizePhone((req.body || {}).phone);
    if (!phone || phone.length < 10 || phone.length > 15) return res.status(400).json({ error: 'Valid phone number is required, 10-15 digits, e.g. 923106865269' });
    const existing = store.getBusiness(id);
    // Refuse ONLY on a LIVE link. The stored flag survives restarts and
    // a failed disconnect, so it can say "linked" while no session
    // exists — refusing on it made re-linking impossible (Zaib hit this
    // 2026-11-21: NOT LINKED on screen, yet "already linked" on every
    // Get pairing code tap, for a new number AND the old one). A stale
    // flag is cleared here and the code is generated normally.
    if (whatsapp.isLiveLinked(id)) return res.status(409).json({ error: 'WhatsApp is already linked for this business. Disconnect first to link a different number.' });
    if (existing.linked === true) {
      existing.linked = false;
      existing.linkedAt = null;
      store.saveBusiness(existing);
    }
    const code = await whatsapp.requestPairingCode(id, phone);
    res.json({
      phone,
      pairingCode: code,
      expiresInSeconds: 60,
      instructions: 'Phone: WhatsApp > Linked Devices > Link a device > Link with phone number, then enter this code within 60 seconds.',
    });
  } catch (e) {
    // Pairing errors carry their own HTTP status: 429 = rate-limited or
    // asked too soon (wait, do NOT retry — retrying extends WhatsApp's
    // limit), 409 = a code is already being requested or already linked.
    // A plain 500 would hide the wait time from the board.
    const status = e.status || (/already linked/i.test(String(e.message || '')) ? 409 : 500);
    res.status(status).json({ error: String(e.message || e) });
  }
});

// --- LID -> phone number mapping (2026-11-22, Zaib): replies to a
// LID can land in a different chat thread than the one the customer
// watches — the receipts proved 14 old replies sit READ on the phone
// while the watched chat shows none of them. When the owner knows a
// customer's real phone number, set it here and the bot replies to
// the phone-number chat instead (see replyJidFor in src/whatsapp.js).
app.post('/api/business/:id/lid-phone', async (req, res) => {
  const id = businessId(req);
  const business = store.getBusiness(id);
  const lid = String((req.body || {}).lid || '').replace(/\D/g, '');
  const phone = normalizePhone((req.body || {}).phone);
  if (!lid || !phone || phone.length < 10 || phone.length > 15) return res.status(400).json({ error: 'lid (digits) and a valid phone number are required' });
  business.lidToPhone = business.lidToPhone || {};
  business.lidToPhone[lid] = phone;
  store.saveBusiness(business);
  res.json({ ok: true, lid, phone, replyJid: phone + '@s.whatsapp.net' });
});

app.get('/api/business/:id/status', (req, res) => {
  const id = businessId(req);
  const business = store.getBusiness(id);
  const session = whatsapp.getSession(id);
  // LIVE ONLY: the stored business.linked flag survives restarts, so it
  // can say "linked" while the socket is dead. The board must show the
  // live socket — linked only while a real connection is open.
  const linked = whatsapp.isLiveLinked(id);
  const liveStatus = linked ? 'linked' : (session.status === 'linked' ? 'disconnected' : (session.status || 'not-linked'));
  res.json({
    business: activity.publicBusiness(business),
    whatsappStatus: liveStatus,
    linked,
    pairingCode: session.pairingCode || null,
    pairingExpiresAt: session.pairingExpiresAt || null,
  });
});

// --- 7. Private live activity (2026-11-22, Zaib) ---
// What the owner used to see only in the Railway logs: link status,
// recent senders, messages received (short previews only), replies
// sent with delivery state, and connect / disconnect / Bad MAC /
// session-reset events. Token-gated: a missing or wrong token gets a
// plain 404, never a hint the page or the data exists. The token
// itself is never in the response.
app.get('/api/business/:id/activity', (req, res) => {
  const id = businessId(req);
  const business = store.getBusiness(id);
  if (!activity.activityTokenMatches(business, String(req.query.t || ''))) return res.status(404).json({ error: 'Not found' });
  const session = whatsapp.getSession(id);
  const linked = whatsapp.isLiveLinked(id);
  const events = activity.getActivityEvents(id);
  const users = activity.summarizeActivityUsers(events, business);
  res.json({
    business: { id: business.id, name: business.name },
    businessType: activity.activityBusinessType(business),
    totals: activity.activityTotals(events, users),
    linked,
    phone: business.phone || '',
    linkedAt: business.linkedAt || null,
    whatsappStatus: linked ? 'linked' : (session.status === 'linked' ? 'disconnected' : (session.status || 'not-linked')),
    users,
    events,
  });
});

// One-time token bootstrap: mints the activity token ONLY when the
// business has none yet, and returns it ONCE (with the private page
// link). After that the endpoint 404s and reveals nothing — the token
// can never be read back through the board. Call it once, right after
// deploying, and hand the link to the owner directly.
app.post('/api/business/:id/activity/token', (req, res) => {
  const id = businessId(req);
  const business = store.getBusiness(id);
  if (business.activityToken) return res.status(404).json({ error: 'Not found' });
  const token = activity.ensureActivityToken(business);
  console.log('Activity token created for', id, '(one-time mint — the token itself is never logged)');
  res.json({ token, url: '/activity.html?businessId=' + encodeURIComponent(id) + '&t=' + token });
});

// --- 8. Number pool + admin overview (2026-11-23, Zaib) ---
// The owner keeps a pool of WhatsApp numbers (number-pool.json). A
// business claims ONE number from the pool and that number becomes its
// own WhatsApp number (business.phone). Claiming is NOT linking — the
// number still has to be linked on the Connect page with a pairing
// code. All admin endpoints are gated on the owner's activity token:
// a missing or wrong token gets a plain 404, never a hint the data
// exists. The token itself is never in any response. Claim / release
// handlers are synchronous read-check-write in one handler, which is
// atomic in Node's single thread.
// Admin token helper: the token lives on the 'musa-social-store'
// business record, checked against ?t=.
function adminTokenOk(req) {
  const owner = store.getBusiness('musa-social-store');
  return activity.activityTokenMatches(owner, String(req.query.t || ''));
}

// Numbers still free to claim, in the order they were added. No token:
// the Connect page needs this list to offer a claim.
app.get('/api/pool/available', (req, res) => {
  const pool = numberPool.loadPool();
  res.json({ available: (pool.numbers || []).filter((n) => n.status === 'available').map((n) => n.phone) });
});

// Which number this business claimed (if any), and its own number.
app.get('/api/business/:id/pool/claim', (req, res) => {
  const business = store.getBusiness(businessId(req));
  res.json({ claimedPhone: business.claimedPhone || null, phone: business.phone || '' });
});

// Claim one pool number for this business. A failed claim is a 409
// with the reason; a second claim while one is held is refused by
// claimNumber (one number per business).
app.post('/api/business/:id/pool/claim', (req, res) => {
  const id = businessId(req);
  const pool = numberPool.loadPool();
  const business = store.getBusiness(id);
  const result = numberPool.claimNumber(pool, business, (req.body || {}).phone);
  if (!result.ok) return res.status(409).json({ error: result.error });
  numberPool.savePool(pool);
  store.saveBusiness(business);
  res.json({ ok: true, phone: result.phone, claimedPhone: result.phone });
});

// Admin overview: every business (live link status + activity totals,
// same live-status logic as the /status route) plus the pool as stored.
app.get('/api/admin/overview', (req, res) => {
  if (!adminTokenOk(req)) return res.status(404).json({ error: 'Not found' });
  const businesses = store.listBusinesses().map((b) => {
    const session = whatsapp.getSession(b.id);
    const linked = whatsapp.isLiveLinked(b.id);
    const events = activity.getActivityEvents(b.id);
    const users = activity.summarizeActivityUsers(events, b);
    return {
      id: b.id,
      name: b.name,
      businessType: activity.activityBusinessType(b),
      phone: b.phone || '',
      claimedPhone: b.claimedPhone || null,
      linked,
      whatsappStatus: linked ? 'linked' : (session.status === 'linked' ? 'disconnected' : (session.status || 'not-linked')),
      totals: activity.activityTotals(events, users),
    };
  });
  res.json({ businesses, pool: numberPool.loadPool().numbers || [] });
});

// Add numbers to the pool. `numbers` is a string (one per line or
// separated by commas) or an array of phone strings. Numbers already
// in the pool, or already owned as some business's phone/claimedPhone,
// are skipped, not duplicated; unusable entries are reported as
// invalid. Nothing is invented — only the numbers given are added.
app.post('/api/admin/pool', (req, res) => {
  if (!adminTokenOk(req)) return res.status(404).json({ error: 'Not found' });
  const input = (req.body || {}).numbers;
  let rawList;
  if (typeof input === 'string') rawList = input.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
  else if (Array.isArray(input)) rawList = input.map((v) => String(v).trim()).filter(Boolean);
  else return res.status(400).json({ error: 'numbers is required — enter numbers one per line, separated by commas, or as an array' });
  const inUsePhones = [];
  for (const b of store.listBusinesses()) {
    for (const v of [b.phone, b.claimedPhone]) {
      const n = numberPool.normalizePoolPhone(v);
      if (n) inUsePhones.push(n);
    }
  }
  const pool = numberPool.loadPool();
  const result = numberPool.addNumbersToPool(pool, rawList, inUsePhones);
  numberPool.savePool(pool);
  res.json(result);
});

// Admin release: return a claimed number to the pool. A number that is
// linked right now is refused — disconnect it first, then release it —
// so a live session is never pulled out from under a business.
app.post('/api/admin/pool/release', (req, res) => {
  if (!adminTokenOk(req)) return res.status(404).json({ error: 'Not found' });
  const phone = numberPool.normalizePoolPhone((req.body || {}).phone);
  const pool = numberPool.loadPool();
  const entry = (pool.numbers || []).find((n) => n.phone === phone);
  if (!entry || entry.status !== 'claimed' || !entry.claimedBy) return res.status(409).json({ error: 'Number is not claimed' });
  const business = store.getBusiness(entry.claimedBy);
  if (whatsapp.isLiveLinked(entry.claimedBy) && business.phone === phone) {
    return res.status(400).json({ error: 'This number is linked right now — disconnect it first, then release it.' });
  }
  const result = numberPool.releaseNumber(pool, business, phone);
  if (!result.ok) return res.status(409).json({ error: result.error });
  numberPool.savePool(pool);
  store.saveBusiness(business);
  res.json({ ok: true, phone: result.phone });
});

app.post('/api/business/:id/disconnect', async (req, res) => {
  // disconnect() clears the stored linked flag FIRST, so this always
  // succeeds from the board's point of view — even if the socket logout
  // throws or there was no session at all. A failed disconnect must
  // never leave the flag saying "linked" for a dead session.
  try { await whatsapp.disconnect(businessId(req)); } catch (e) { console.error('Disconnect error (flag already cleared):', (e && e.message) || e); }
  res.json({ ok: true });
});

// --- 2 + 4. Business settings: prompt, name, lead email, lead WhatsApp ---
// One endpoint, partial updates — the dashboard calls it once for the prompt
// section and once for the notification section.
app.post('/api/business/:id/settings', (req, res) => {
  const id = businessId(req);
  const business = store.getBusiness(id);
  const { name, prompt, leadEmail, leadWhatsapp } = req.body || {};
  if (name !== undefined) business.name = String(name);
  if (prompt !== undefined) business.prompt = String(prompt);
  if (leadEmail !== undefined) business.leadEmail = String(leadEmail).trim();
  if (leadWhatsapp !== undefined) business.leadWhatsapp = String(leadWhatsapp).replace(/\s/g, '');
  store.saveBusiness(business);
  res.json({ business: activity.publicBusiness(business) });
});

// --- 3. Media upload: images / voice / video ---
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_ROOT, businessId(req));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')),
  }),
  limits: { fileSize: 16 * 1024 * 1024 }, // WhatsApp media limit
  fileFilter: (req, file, cb) => {
    const ok = /^(image|video|audio)\//.test(file.mimetype);
    cb(ok ? null : new Error('Only image, video or audio files are allowed'), ok);
  },
});

app.post('/api/business/:id/media', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}, (req, res) => {
  const id = businessId(req);
  const business = store.getBusiness(id);
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  const kind = req.file.mimetype.startsWith('image/') ? 'image'
    : req.file.mimetype.startsWith('video/') ? 'video' : 'audio';
  const item = {
    id: 'media_' + Date.now(),
    kind,
    filename: req.file.filename,
    originalName: req.file.originalname,
    caption: String(req.body.caption || ''),
    // useFor: which customer question this media answers, e.g. "website design, price list"
    useFor: String(req.body.useFor || ''),
    // ownerNote (2026-11-20, Brain improvements): the owner's own words
    // about what this file is FOR — "ye offer banner hai, deal puche to
    // bhejna". Required in Brain Chat, optional on the Media page. The
    // brain analyses the picture TOGETHER with these words.
    ownerNote: String(req.body.ownerNote || req.body.caption || ''),
    // purpose (2026-11-21, Zaib): 'knowledge' = brain-only, NEVER sent
    // to a customer — the brain learns from it and answers FROM it.
    // 'customer' = the brain may send it to a customer when it fits.
    // Default is knowledge: sending the wrong picture to a customer is
    // the reported bug (a knowledge poster was sent back to the
    // customer as "our plans"); the owner flips a file to 'customer'
    // on the Media page or in Brain Chat.
    purpose: req.body.purpose === 'customer' ? 'customer' : 'knowledge',
    url: `/media/${encodeURIComponent(id)}/${encodeURIComponent(req.file.filename)}`,
    createdAt: new Date().toISOString(),
  };
  business.media = business.media || [];
  business.media.push(item);
  store.saveBusiness(business);
  res.json({ media: item });
});

app.get('/api/business/:id/media', (req, res) => {
  res.json({ media: store.getBusiness(businessId(req)).media || [] });
});

app.delete('/api/business/:id/media/:mediaId', (req, res) => {
  const id = businessId(req);
  const business = store.getBusiness(id);
  const item = (business.media || []).find((m) => m.id === req.params.mediaId);
  if (item) {
    const filePath = path.join(UPLOAD_ROOT, id, item.filename);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
  }
  business.media = (business.media || []).filter((m) => m.id !== req.params.mediaId);
  store.saveBusiness(business);
  res.json({ ok: true, media: business.media });
});

// Flip one file's purpose: knowledge (brain-only, never sent) or
// customer (the brain may send it when it fits).
app.post('/api/business/:id/media/:mediaId/purpose', (req, res) => {
  const id = businessId(req);
  const business = store.getBusiness(id);
  const item = (business.media || []).find((m) => m.id === req.params.mediaId);
  if (!item) return res.status(404).json({ error: 'Media not found' });
  const purpose = String((req.body || {}).purpose || '');
  if (purpose !== 'knowledge' && purpose !== 'customer') return res.status(400).json({ error: 'purpose must be knowledge or customer' });
  item.purpose = purpose;
  store.saveBusiness(business);
  res.json({ media: item });
});

// --- 2. Brain Chat: the owner teaches the brain in plain words ---
// Replaces the static Prompt page in the board's nav. The brain keeps
// memory (business.brainMemory + business.brainSummary, persisted in
// data/businesses.json). On first load, a saved prompt seeds the memory
// as the owner's opening message, so nothing the owner already wrote is
// lost. The reply is FAST (seconds): Gemini gets a ~14s budget, then
// the brain confirms locally from the owner's own words — the owner
// never waits a minute on "Analyzing…" and is never told "AI isn't
// connected" (see ai.brainChat / localBrainConfirmation).
function seedBrain(business) {
  business.brainMemory = Array.isArray(business.brainMemory) ? business.brainMemory : [];
  if (!business.brainMemory.length && business.prompt && String(business.prompt).trim()) {
    business.brainMemory.push({ role: 'owner', text: String(business.prompt).trim(), at: new Date().toISOString() });
    business.brainSummary = ai.distillBrainSummary(business);
    store.saveBusiness(business);
    return true;
  }
  return false;
}

app.get('/api/business/:id/brain', (req, res) => {
  const business = store.getBusiness(businessId(req));
  seedBrain(business);
  res.json({
    brainMemory: business.brainMemory || [],
    brainSummary: business.brainSummary || null,
    aiConnected: ai.isAiConfigured(),
    prompt: business.prompt || '',
  });
});

// REAL brain wipe: prompt + memory + summary are actually erased from
// the store. Settings that are NOT brain knowledge stay untouched:
// leadEmail, leadWhatsapp, phone, linked, campaigns, media.
app.post('/api/business/:id/brain/clear', (req, res) => {
  const business = store.getBusiness(businessId(req));
  business.prompt = '';
  business.brainMemory = [];
  business.brainSummary = null;
  store.saveBusiness(business);
  res.json({ cleared: true, brainMemory: [], brainSummary: null, prompt: '' });
});

// A delete-all instruction is an ACTION, not a chat topic: the brain
// used to reply "memory blank kar diya" while nothing was actually
// erased. When the owner says to delete all data, wipe it for real
// first, then confirm — never call Gemini about it (it would only
// re-summarise the old data).
const BRAIN_DELETE_CONFIRM = 'Ho gaya — maine apna saara purana data delete kar diya hai. Meri memory ab bilkul khaali hai. Ab apna naya business data batao — naam, kaam, services, prices, location — main use save kar lunga.';
const BRAIN_DELETE_WORDS = /\b(delete|remove|clear|wipe|erase|saaf|mita|mitao|bhool|khatam|khatm|ڈیلیٹ|حذف|مٹا|صاف|بھول|ختم)\b/i;
const BRAIN_DELETE_ALL_WORDS = /\b(sara|saara|sab|all|everything|pura|poora|poori|data|memory|purana|purani|yaadein|سارا|سب|پورا|تمام|ڈیٹا|میموری|پرانا)\b/i;
function isBrainDeleteAll(message) {
  const m = String(message || '');
  return BRAIN_DELETE_WORDS.test(m) && (BRAIN_DELETE_ALL_WORDS.test(m) || /new data/i.test(m));
}

// --- 2b. Setup from link (2026-11-22, Zaib): paste a website /
// Facebook / Instagram link — the board reads it and fills the brain
// itself. MERGE, never wipe: the facts are appended to the brain, the
// owner's existing prompt, memory and summary stay untouched. Brain
// Chat keeps working alongside it.
app.post('/api/business/:id/brain/setup-from-link', async (req, res) => {
  const id = businessId(req);
  const business = store.getBusiness(id);
  const url = String((req.body || {}).url || '').trim();
  if (!url) return res.status(400).json({ error: 'url is required — paste your website, Facebook or Instagram link' });
  try {
    const out = await linkSetup.setupFromLink(business, url);
    store.saveBusiness(business);
    res.json({ ok: true, url: out.url, facts: out.facts, brainMemory: business.brainMemory, brainSummary: business.brainSummary || null });
  } catch (e) {
    res.status(400).json({ error: String((e && e.message) || e) });
  }
});

app.post('/api/business/:id/brain/chat', async (req, res) => {
  const business = store.getBusiness(businessId(req));
  seedBrain(business);
  const message = String((req.body || {}).message || '').trim();
  if (!message) return res.status(400).json({ error: 'message is required — write or speak something to teach the brain' });
  if (isBrainDeleteAll(message)) {
    // Wipe first (seedBrain above may have seeded the prompt into memory;
    // the wipe removes that too), then keep ONLY this exchange so the
    // chat history honestly shows what happened. No distill, no Gemini.
    business.prompt = '';
    const now = new Date().toISOString();
    business.brainMemory = [
      { role: 'owner', text: message, at: now },
      { role: 'brain', text: BRAIN_DELETE_CONFIRM, at: now },
    ];
    business.brainSummary = null;
    store.saveBusiness(business);
    return res.json({
      reply: BRAIN_DELETE_CONFIRM,
      aiConnected: ai.isAiConfigured(),
      local: true,
      brainMemory: business.brainMemory,
      brainSummary: null,
    });
  }
  business.brainMemory = business.brainMemory || [];
  business.brainMemory.push({ role: 'owner', text: message, at: new Date().toISOString() });
  // Link in the chat (2026-11-22, Zaib: the brain told him it cannot
  // open links — it CAN: the system fetches the link and teaches the
  // brain FIRST, so the reply is what the link taught, never a refusal
  // to open it). setupFromLink merges the facts into the brain (memory
  // + prompt + summary); the reply below carries them too.
  const linkMatch = String(message).match(/https?:\/\/[^\s'")\]]+/i);
  let linkLearned = null;
  if (linkMatch) {
    try {
      const r = await linkSetup.setupFromLink(business, linkMatch[0]);
      linkLearned = { ok: true, facts: r.facts, url: r.url };
    } catch (e) {
      linkLearned = { ok: false, error: String((e && e.message) || e).slice(0, 120) };
    }
  }
  // No picture is ever created (2026-11-22, Zaib: the picture section
  // was deleted from the update). The brain answers in words only.
  const out = await ai.brainChat(business, message, linkLearned);
  let replyText = out.text;
  // If the owner asked for a design and the reply doesn't already
  // promise the team will share it, say so plainly — the word
  // "design" alone is not enough, the owner's own message often
  // contains it ("mujhe design dikhao").
  if (ai.detectImageRequest(message) && !/team will share|team.*share/i.test(replyText)) {
    replyText += ' ' + (ai.detectLanguage(message) === 'en'
      ? 'The team will share the design with you soon and confirm the final one.'
      : 'Team jald aap ko design share karegi aur final confirm karegi.');
  }
  business.brainMemory.push({ role: 'brain', text: replyText, at: new Date().toISOString() });
  business.brainMemory = business.brainMemory.slice(-100);
  // The distilled summary is a fast LOCAL parse (no AI call), so it is
  // refreshed after every chat message — AI reply or local confirmation.
  business.brainSummary = ai.distillBrainSummary(business);
  store.saveBusiness(business);
  res.json({
    reply: replyText,
    aiConnected: out.aiConnected,
    local: !!out.local,
    brainMemory: business.brainMemory,
    brainSummary: business.brainSummary || null,
  });
});

// --- 3b. Media describe: Gemini vision on a stored file ---
// Image: described directly. Video: one frame is extracted with ffmpeg
// and that frame is described; if ffmpeg is missing or extraction fails,
// the endpoint says so honestly instead of inventing a description.
// Audio: no description available (no speech-to-text here) — honest 501.
// Without a Gemini key: honest 503, no crash, nothing faked.
function mimeForFile(filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/jpeg';
}

function extractVideoFrame(videoPath) {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), 'musa-frame-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.jpg');
    execFile('ffmpeg', ['-y', '-v', 'error', '-i', videoPath, '-ss', '1', '-frames:v', '1', '-q:v', '3', out], { timeout: 30000 }, (err) => {
      if (err) return reject(new Error('ffmpeg could not extract a frame from this video (' + String(err.message || err).slice(0, 100) + ')'));
      try {
        const buf = fs.readFileSync(out);
        try { fs.unlinkSync(out); } catch (_) {}
        resolve(buf);
      } catch (e) { reject(new Error('could not read the extracted frame')); }
    });
  });
}

app.post('/api/business/:id/media/:mediaId/describe', async (req, res) => {
  const id = businessId(req);
  const business = store.getBusiness(id);
  const item = (business.media || []).find((m) => m.id === req.params.mediaId);
  if (!item) return res.status(404).json({ error: 'Media not found' });
  if (!ai.isAiConfigured()) {
    return res.status(503).json({ error: 'AI is not connected yet — no Gemini API key is set, so this file cannot be analysed yet. Add the key and try again.', aiConnected: false });
  }
  const filePath = path.join(UPLOAD_ROOT, id, item.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on the server' });
  // The owner's own words about this file (sent with the upload, or
  // with this describe call) are analysed TOGETHER with the picture —
  // the brain must know what the owner meant by it, not just the pixels.
  const ownerNote = String((req.body || {}).caption || (req.body || {}).ownerNote || item.ownerNote || item.caption || '').trim();
  try {
    let result;
    if (item.kind === 'image') {
      result = await ai.describeImage(fs.readFileSync(filePath), mimeForFile(item.filename), ownerNote);
    } else if (item.kind === 'video') {
      let frame;
      try {
        frame = await extractVideoFrame(filePath);
      } catch (e) {
        return res.status(501).json({ error: 'Video analysis is unavailable right now — ' + e.message + ' No description was faked.' });
      }
      result = await ai.describeImage(frame, 'image/jpeg', ownerNote);
    } else {
      return res.status(501).json({ error: 'Voice-note analysis is not available yet — the brain cannot listen to audio files. Write the caption and "when to send" note instead, and the brain will use those words.' });
    }
    if (!result.ok) return res.status(502).json({ error: result.error });
    item.description = result.description;
    item.analyzedAt = new Date().toISOString();
    // The brain remembers what it saw, so Brain Chat can use it too.
    // A knowledge file is remembered as knowledge-only — the brain
    // must never promise to send it (see purpose, 2026-11-21).
    business.brainMemory = business.brainMemory || [];
    const sendLine = item.purpose === 'customer'
      ? `I will send it when a customer asks about ${item.useFor || item.ownerNote || item.caption || 'something matching it'}.`
      : 'This file is for my own knowledge only — I will never send it to a customer, I will only answer from what I learned in it.';
    business.brainMemory.push({
      role: 'brain',
      text: `I analysed your ${item.kind} "${item.originalName}"${ownerNote ? ` (you said: "${ownerNote}")` : ''}: ${result.description} ${sendLine}`,
      at: new Date().toISOString(),
    });
    store.saveBusiness(business);
    res.json({ media: item, description: result.description });
  } catch (e) {
    res.status(500).json({ error: 'Could not analyse this file: ' + String((e && e.message) || e) });
  }
});

// --- 5. Leads ---
app.get('/api/business/:id/leads', (req, res) => {
  res.json({ leads: store.listLeads(businessId(req)) });
});

// Create a lead manually — real data only, no dummy defaults.
// customerNumber and wants are required; blank fields are rejected with 400.
app.post('/api/business/:id/leads', (req, res) => {
  const id = businessId(req);
  const business = store.getBusiness(id);
  const b = req.body || {};
  const customerNumber = String(b.customerNumber || b.number || '').trim();
  const wants = String(b.wants || b.message || '').trim();
  if (!customerNumber || !wants) return res.status(400).json({ error: 'customerNumber and wants are required — add real lead details, no dummy data' });
  const lead = store.addLead({
    businessId: id,
    businessName: business.name || id,
    customerName: String(b.customerName || b.name || '').trim(),
    customerNumber,
    address: String(b.address || '').trim(),
    wants,
    rawText: wants,
    status: 'new',
    source: b.source || 'dashboard-manual',
  });
  res.status(201).json({ lead });
});

// Confirm a lead: mark confirmed + forward to saved email AND saved WhatsApp.
// Graceful fallback: if Resend key / session is missing, the lead is still
// marked confirmed and the reason is returned in forwardLog.
app.post('/api/business/:id/leads/:leadId/confirm', async (req, res) => {
  const id = businessId(req);
  const business = store.getBusiness(id);
  const result = await leads.confirmLead(business, req.params.leadId, (bid, jid, text) => whatsapp.sendText(bid, jid, text));
  if (result.error) return res.status(404).json({ error: result.error });
  res.json(result);
});

// --- 6. Bulk Messages ---
// The user links their OWN device (Connect page), enters their OWN
// numbers, writes their OWN message, picks Send or Draft, and starts
// the campaign. No admin panel, no premium, no ads, no login —
// Business ID only, like the rest of the board.
// SAFETY: bulk sending can get a number flagged by WhatsApp, so sends
// are paced 8–15 seconds apart (random), the owner must confirm
// consent, and nothing ever starts on its own. There is NO cap on how
// many numbers a campaign can carry (Zaib, 2026-11-21 — unlimited).
// Draft campaigns send NOTHING:
// they are created instantly as wa.me prefilled links, and the owner
// opens each one on their phone and presses send when they want.
function getCampaign(business, campaignId) {
  return (business.campaigns || []).find((c) => c.id === campaignId) || null;
}

// Send campaigns run one by one through the linked session. Runs in the
// background (the endpoint returns immediately) and never crashes the
// server: every single send is try/caught and recorded on its number.
async function runCampaign(businessId, campaignId) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Chunked wait: sleep in 1-second slices and re-read the campaign
  // status each second, so an urgent Stop takes effect within ~1s
  // instead of after a 15-second sleep. Returns true while the
  // campaign is still running.
  async function waitPaced(seconds) {
    for (let i = 0; i < seconds; i++) {
      await wait(1000);
      const business = store.getBusiness(businessId);
      const campaign = getCampaign(business, campaignId);
      if (!campaign || campaign.status !== 'running') return false;
    }
    return true;
  }
  try {
    // Campaign attachment (2026-11-21, Zaib): one picture, video or
    // voice note may ride with the campaign. Loaded once here, sent
    // with every number — a missing file falls back to text only.
    let bulkMedia = null;
    let bulkBuffer = null;
    {
      const business0 = store.getBusiness(businessId);
      const campaign0 = getCampaign(business0, campaignId);
      if (campaign0 && campaign0.mediaId) {
        bulkMedia = (business0.media || []).find((m) => m.id === campaign0.mediaId) || null;
        if (bulkMedia) {
          const filePath = path.join(UPLOAD_ROOT, businessId, bulkMedia.filename);
          if (fs.existsSync(filePath)) bulkBuffer = fs.readFileSync(filePath);
        }
      }
    }
    let first = true;
    for (;;) {
      let business = store.getBusiness(businessId);
      let campaign = getCampaign(business, campaignId);
      if (!campaign || campaign.type !== 'send' || campaign.status !== 'running') return;
      let n = campaign.numbers.find((x) => x.status === 'pending');
      if (!n) break;
      // Pacing: 8–15 random seconds BETWEEN sends (never back-to-back).
      // The first number goes out immediately.
      if (!first) {
        if (!(await waitPaced(8 + Math.floor(Math.random() * 8)))) return;
        // Re-read after the wait: a Stop may have landed mid-wait, and
        // the send below must not go out after a stop.
        business = store.getBusiness(businessId);
        campaign = getCampaign(business, campaignId);
        if (!campaign || campaign.status !== 'running') return;
        n = campaign.numbers.find((x) => x.status === 'pending');
        if (!n) break;
      }
      first = false;
      try {
        const session = whatsapp.getSession(businessId);
        if (!session.sock || (business.linked !== true && session.status !== 'linked')) {
          throw new Error('WhatsApp got disconnected');
        }
        await bulk.sendBulkMessage(session.sock, n.phone.replace(/\D/g, '') + '@s.whatsapp.net', bulkMedia, bulkBuffer, campaign.message);
        n.status = 'sent';
        n.error = '';
      } catch (e) {
        n.status = 'failed';
        n.error = String((e && e.message) || e).slice(0, 120);
      }
      campaign.sentCount = campaign.numbers.filter((x) => x.status === 'sent').length;
      campaign.failedCount = campaign.numbers.filter((x) => x.status === 'failed').length;
      store.saveBusiness(business);
    }
    // Loop ended: every number is done. Mark 'done' ONLY when the
    // campaign is still running — a paused campaign keeps status
    // 'paused' with its counts saved, so Continue can resume it.
    const business = store.getBusiness(businessId);
    const campaign = getCampaign(business, campaignId);
    if (campaign && campaign.status === 'running' && !campaign.numbers.some((x) => x.status === 'pending')) {
      campaign.status = 'done';
      campaign.sentCount = campaign.numbers.filter((x) => x.status === 'sent').length;
      campaign.failedCount = campaign.numbers.filter((x) => x.status === 'failed').length;
      store.saveBusiness(business);
    }
  } catch (e) {
    console.error('Bulk campaign failed:', e && e.message);
  }
}

// Create a campaign. Draft = instant, nothing is sent. Send = ready to start.
app.post('/api/business/:id/campaigns', (req, res) => {
  const id = businessId(req);
  const business = store.getBusiness(id);
  const b = req.body || {};
  const message = String(b.message || '').trim();
  const type = b.type === 'draft' ? 'draft' : 'send';
  if (!message) return res.status(400).json({ error: 'message is required — write the message to send' });
  const parsed = bulk.parseNumbers(b.numbers || '');
  if (!parsed.valid.length) {
    return res.status(400).json({ error: 'No valid numbers found — enter numbers like +923106865269, one per line or separated by commas', valid: 0, duplicates: parsed.duplicates, invalid: parsed.invalid });
  }
  // Optional attachment (2026-11-21, Zaib): one picture, video or voice
  // note, uploaded first on the Media page or in the wizard. It must
  // exist in this business's media — a made-up id is refused.
  let mediaId = null, mediaKind = null, mediaName = null;
  if (b.mediaId) {
    const item = (business.media || []).find((m) => m.id === String(b.mediaId));
    if (!item) return res.status(400).json({ error: 'Attachment not found — upload the picture, video or voice note first' });
    mediaId = item.id; mediaKind = item.kind; mediaName = item.originalName || item.filename;
  }
  business.campaigns = business.campaigns || [];
  const campaign = {
    id: 'cmp_' + Date.now(),
    type,
    message,
    mediaId, mediaKind, mediaName,
    numbers: parsed.valid.map((v) => ({ phone: v.phone, status: type === 'draft' ? 'draft' : 'pending', error: '' })),
    status: type === 'draft' ? 'draft' : 'ready',
    createdAt: new Date().toISOString(),
    sentCount: 0,
    failedCount: 0,
  };
  business.campaigns.push(campaign);
  store.saveBusiness(business);
  res.status(201).json({ campaign, valid: parsed.valid.length, duplicates: parsed.duplicates, invalid: parsed.invalid });
});

// Start a campaign (async — returns immediately, sends in background).
// Send campaigns start as-is. A DRAFT campaign becomes a send campaign
// when the owner starts it: the BOT sends it from the server, 8–15s
// apart — the owner's phone WhatsApp never opens. A draft just sits
// saved on the board until the owner taps Send all now / Start.
app.post('/api/business/:id/campaigns/:campaignId/start', (req, res) => {
  const id = businessId(req);
  const business = store.getBusiness(id);
  const campaign = getCampaign(business, req.params.campaignId);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status === 'running') return res.status(400).json({ error: 'Campaign is already running' });
  if (campaign.status === 'done') return res.status(400).json({ error: 'Campaign is already finished' });
  const session = whatsapp.getSession(id);
  if (!whatsapp.isLiveLinked(id)) return res.status(400).json({ error: 'WhatsApp not linked — link it on the Connect page first' });
  // Draft → send conversion happens ONLY after the linked check passes,
  // so a failed start never changes a saved draft.
  if (campaign.type === 'draft') {
    campaign.type = 'send';
    campaign.numbers.forEach((n) => { if (n.status === 'draft') n.status = 'pending'; });
  }
  campaign.status = 'running';
  store.saveBusiness(business);
  // Fire and forget — the runner paces sends 8–15s apart and records each result.
  runCampaign(id, campaign.id);
  res.json({ status: 'running', campaign });
});

// Stop a running campaign URGENTLY: the runner checks the status every
// second while pacing, so the stop takes effect within ~1s. The campaign
// becomes 'paused' — Continue (/start) resumes it from the first
// 'pending' number. Anything else is a 400.
app.post('/api/business/:id/campaigns/:campaignId/stop', (req, res) => {
  const id = businessId(req);
  const business = store.getBusiness(id);
  const campaign = getCampaign(business, req.params.campaignId);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status !== 'running') return res.status(400).json({ error: 'Campaign is not running' });
  campaign.status = 'paused';
  store.saveBusiness(business);
  res.json({ status: 'paused', campaign });
});

// List campaigns, newest first (numbers included — no cap on count).
app.get('/api/business/:id/campaigns', (req, res) => {
  const business = store.getBusiness(businessId(req));
  const list = (business.campaigns || []).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json({ campaigns: list });
});

// One campaign. Draft numbers carry their wa.me link so the owner can open them.
app.get('/api/business/:id/campaigns/:campaignId', (req, res) => {
  const business = store.getBusiness(businessId(req));
  const campaign = getCampaign(business, req.params.campaignId);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  const out = { ...campaign };
  if (campaign.type === 'draft') {
    out.numbers = campaign.numbers.map((n) => ({ ...n, waLink: bulk.waLink(n.phone, campaign.message) }));
  }
  res.json({ campaign: out });
});

// Send one number now (draft campaigns, or a failed number in any campaign).
app.post('/api/business/:id/campaigns/:campaignId/send-one', async (req, res) => {
  const id = businessId(req);
  const business = store.getBusiness(id);
  const campaign = getCampaign(business, req.params.campaignId);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  const phone = bulk.normalizeNumber((req.body || {}).phone || '');
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  const n = campaign.numbers.find((x) => x.phone === phone);
  if (!n) return res.status(404).json({ error: 'Number is not in this campaign' });
  const session = whatsapp.getSession(id);
  if (!whatsapp.isLiveLinked(id)) return res.status(400).json({ error: 'WhatsApp not linked — link it on the Connect page first' });
  try {
    // The campaign's attachment (if any) rides along, same as the runner.
    const media = campaign.mediaId ? (business.media || []).find((m) => m.id === campaign.mediaId) : null;
    let buffer = null;
    if (media) {
      const filePath = path.join(UPLOAD_ROOT, id, media.filename);
      if (fs.existsSync(filePath)) buffer = fs.readFileSync(filePath);
    }
    await bulk.sendBulkMessage(session.sock, n.phone.replace(/\D/g, '') + '@s.whatsapp.net', media, buffer, campaign.message);
    n.status = 'sent';
    n.error = '';
  } catch (e) {
    n.status = 'failed';
    n.error = String((e && e.message) || e).slice(0, 120);
    campaign.failedCount = campaign.numbers.filter((x) => x.status === 'failed').length;
    campaign.sentCount = campaign.numbers.filter((x) => x.status === 'sent').length;
    store.saveBusiness(business);
    return res.status(502).json({ error: 'Send failed: ' + n.error, campaign });
  }
  campaign.sentCount = campaign.numbers.filter((x) => x.status === 'sent').length;
  campaign.failedCount = campaign.numbers.filter((x) => x.status === 'failed').length;
  if (campaign.numbers.every((x) => x.status === 'sent')) campaign.status = 'done';
  store.saveBusiness(business);
  res.json({ campaign, number: n });
});

// Keep the old disconnect route name working too (it is defined above).
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Musa WhatsApp Bot Platform running on http://localhost:${PORT}`);
  console.log('Dashboard: http://localhost:' + PORT + '/  (businessId defaults to musa-social-store)');
  if (!process.env.GEMINI_API_KEY) console.log('Note: GEMINI_API_KEY not set — customer replies use the facts fallback and Brain Chat confirms locally from the owner\'s own words (see src/ai.js fallbackReply / localBrainConfirmation)');
  if (!process.env.RESEND_API_KEY) console.log('Note: RESEND_API_KEY not set — leads will be saved but no lead email will be sent until it is set in .env');
  // Reconnect linked sessions from the persisted auth state, so a
  // restart / redeploy never silently kills the link (and /status never
  // has to lie about it). Runs in the background; a failed restore is
  // logged, never fatal to boot.
  whatsapp.restoreLinkedSessions().catch((e) => console.error('Session restore failed:', (e && e.message) || e));
});
