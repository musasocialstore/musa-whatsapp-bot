// Private live activity (2026-11-22, Zaib): the owner wants to see on the
// board what used to live only in the Railway logs — which number is
// linked, which customers messaged, what was received, what reply the
// board sent, and why a number fails (connect / disconnect / Bad MAC /
// session reset). This module is the in-memory record for that view:
// one ring buffer per business (last 100 events, newest first on read),
// plus the secret token that gates the page and its API.
//
// PRIVACY: message previews are SHORT only — never the full chat text
// (same rule as the incoming-message log in src/whatsapp.js: sender +
// text preview, never the full chat). The token lives on the business
// record (businesses.json on the server volume, so it survives
// restarts) and is NEVER returned by any endpoint except the one-time
// mint below — publicBusiness() strips it from every business object
// the board sends out (the status endpoint returns the whole business).
'use strict';

const crypto = require('crypto');
const store = require('./store');

const ACTIVITY_MAX_EVENTS = 100;
const ACTIVITY_PREVIEW_LEN = 80;
// A Bad MAC storm fires every ~5s for minutes — consecutive failures
// from the same sender merge into one line with a count instead of
// flooding the list (see recordActivity).
const BADMAC_MERGE_WINDOW_MS = 60 * 1000;
// A connect / disconnect can fire twice for one death (close event +
// silent-death watchdog) — identical lines within this window collapse.
const FLAP_DEDUPE_WINDOW_MS = 5000;

const activityEvents = new Map(); // businessId -> [event, ...] oldest first

// Short preview of a message: one line, at most ACTIVITY_PREVIEW_LEN
// characters. Never the full text.
function activityPreview(text) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  if (one.length <= ACTIVITY_PREVIEW_LEN) return one;
  return one.slice(0, ACTIVITY_PREVIEW_LEN - 1).trimEnd() + '…';
}

// Delivery state of a reply, from a Baileys receipt status name.
// SERVER_ACK means the server accepted it — the reply stays 'sent';
// DELIVERY_ACK / READ / PLAYED advance it; ERROR fails it.
function deliveryFromReceiptStatus(status) {
  const s = String(status || '');
  if (s.indexOf('DELIVERY_ACK') === 0) return 'delivered';
  if (s.indexOf('READ') === 0 || s.indexOf('PLAYED') === 0) return 'read';
  if (s.indexOf('ERROR') === 0) return 'failed';
  return null;
}

// Record one event for a business. Never throws — the activity feed is
// best-effort and must never break the reply path that records into it.
// event: { type, at?, ...fields }. `at` defaults to now (tests may pass
// an explicit timestamp to simulate time).
function recordActivity(businessId, event) {
  try {
    if (!businessId || !event || typeof event.type !== 'string') return false;
    const list = activityEvents.get(businessId) || [];
    const now = Date.now();
    const at = event.at || new Date(now).toISOString();
    const entry = { ...event, at };
    // A fresh Bad MAC line starts at count 1; the merge below bumps it.
    if (entry.type === 'badmac' && entry.count === undefined) entry.count = 1;
    const last = list[list.length - 1];
    // Merge a Bad MAC storm: same sender, same type, within the window.
    if (entry.type === 'badmac' && last && last.type === 'badmac' && last.user === entry.user
      && now - Date.parse(last.at) < BADMAC_MERGE_WINDOW_MS) {
      last.count = (last.count || 1) + 1;
      last.at = at;
      return true;
    }
    // Collapse a flapping connect / disconnect into one line.
    if ((entry.type === 'connect' || entry.type === 'disconnect') && last && last.type === entry.type
      && now - Date.parse(last.at) < FLAP_DEDUPE_WINDOW_MS) {
      return false;
    }
    list.push(entry);
    while (list.length > ACTIVITY_MAX_EVENTS) list.shift();
    activityEvents.set(businessId, list);
    return true;
  } catch (e) {
    console.error('recordActivity failed:', (e && e.message) || e);
    return false;
  }
}

// Events for a business, newest first. A copy — callers cannot mutate
// the stored list.
function getActivityEvents(businessId) {
  const list = activityEvents.get(businessId) || [];
  return list.slice().reverse();
}

// A delivery receipt advances the matching reply's delivery state
// (matched by sent message id, newest first). The receipt itself is
// also recorded as its own event by the caller.
function updateReplyDelivery(businessId, msgId, status) {
  if (!msgId) return false;
  const delivery = deliveryFromReceiptStatus(status);
  if (!delivery) return false;
  const list = activityEvents.get(businessId) || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].type === 'reply' && list[i].msgId === msgId) {
      list[i].delivery = delivery;
      return true;
    }
  }
  return false;
}

// Recent senders, derived from the events — no extra storage. One row
// per sender JID: display name (last known), mapped phone where the
// business already has one (or the digits themselves for a
// phone-number chat), last-seen time, and how many messages they sent.
// Newest first.
function summarizeActivityUsers(events, business) {
  const byFrom = new Map();
  for (const e of events || []) {
    if (e.type !== 'incoming') continue;
    const from = e.from;
    if (!from) continue;
    const row = byFrom.get(from) || { from, name: '', phone: null, lastSeen: '', messages: 0 };
    if (e.name) row.name = e.name;
    if (e.phone) row.phone = e.phone;
    else if (from.endsWith('@s.whatsapp.net')) row.phone = from.split('@')[0];
    else if (business && business.lidToPhone && business.lidToPhone[from.split('@')[0]]) {
      row.phone = business.lidToPhone[from.split('@')[0]];
    }
    if (!row.lastSeen || String(e.at) > row.lastSeen) row.lastSeen = e.at;
    row.messages += 1;
    byFrom.set(from, row);
  }
  return Array.from(byFrom.values()).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

// The business type shown on the activity page: the brain's distilled
// category first ("Website development"), else the first "Category:"
// line from the prompt the owner taught the brain. Empty when neither
// exists — the page then shows just the business name.
function activityBusinessType(business) {
  if (!business) return '';
  if (business.brainSummary && typeof business.brainSummary.category === 'string' && business.brainSummary.category.trim()) {
    return business.brainSummary.category.trim();
  }
  const prompt = typeof business.prompt === 'string' ? business.prompt : '';
  const m = prompt.match(/Category:\s*([^\n\r]+)/);
  return m ? m[1].trim() : '';
}

// Total details for the page headers: how many users, how many
// messages came in, how many replies went out, how many events in all
// (within the last-100 window the page shows).
function activityTotals(events, users) {
  const list = events || [];
  return {
    users: (users || []).length,
    incoming: list.filter((e) => e.type === 'incoming').length,
    replies: list.filter((e) => e.type === 'reply').length,
    events: list.length,
  };
}

// --- Private token ---
// One random token per business, stored on the business record
// (businesses.json on the server volume — survives restarts). It is
// minted ONCE by the one-time bootstrap endpoint (see server.js) and
// never returned anywhere else.
function generateActivityToken() {
  return crypto.randomBytes(32).toString('hex');
}

function ensureActivityToken(business) {
  if (!business) return null;
  if (!business.activityToken) {
    business.activityToken = generateActivityToken();
    store.saveBusiness(business);
  }
  return business.activityToken;
}

function activityTokenMatches(business, token) {
  const expected = business && business.activityToken;
  if (!expected || typeof token !== 'string' || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (_) { return false; }
}

// The business object as the board may send it: everything the board
// already returns, except the activity token — it must never leak
// through /status or /settings.
function publicBusiness(business) {
  if (!business) return business;
  const out = { ...business };
  delete out.activityToken;
  return out;
}

module.exports = {
  ACTIVITY_MAX_EVENTS,
  ACTIVITY_PREVIEW_LEN,
  activityEvents,
  activityPreview,
  deliveryFromReceiptStatus,
  recordActivity,
  getActivityEvents,
  updateReplyDelivery,
  summarizeActivityUsers,
  activityBusinessType,
  activityTotals,
  generateActivityToken,
  ensureActivityToken,
  activityTokenMatches,
  publicBusiness,
};
