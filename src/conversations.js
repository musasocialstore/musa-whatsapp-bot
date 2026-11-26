// Persisted message store — the BOT's customer chats (2026-11-26,
// Zaib approved 13:50 PKT, Worker B).
// One file, conversations.json in DATA_DIR, sync JSON I/O, same pattern
// as src/store.js / src/number-pool.js. Shape:
//   { <businessId>: { <customerJid>: {
//       name: <customer display name, last known, '' when unknown>,
//       customerPhone: <digits when the JID is a phone-number chat, else ''>,
//       messages: [{ dir: 'in'|'out', text, at, phone }],
//       lastAt: <ISO timestamp of the newest message> } } }
// `phone` on every message is the ACCOUNT phone that received/sent it
// (multi-account: a message belongs to business + account phone +
// customer JID). Caps: last 200 messages per customer, 50 chats per
// business — oldest drop first. Recording NEVER throws and never breaks
// a reply: recordConversation() swallows/logs any store failure.
// This stores ONLY the bot's chats. The bot never receives the user's
// personal WhatsApp chats, so those are not and cannot be shown here.
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');

const CONVERSATIONS_FILE = path.join(store.DATA_DIR, 'conversations.json');
const MAX_MESSAGES_PER_CHAT = 200;
const MAX_CHATS_PER_BUSINESS = 50;
const PREVIEW_LEN = 80;

function loadConversations() {
  try {
    const data = JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    return {};
  } catch (_) {
    return {};
  }
}

function saveConversations(data) {
  fs.mkdirSync(store.DATA_DIR, { recursive: true });
  fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(data, null, 2));
  return data;
}

// Short one-line preview of a message, at most PREVIEW_LEN chars.
// Same truncation shape as activity.activityPreview (80 chars).
function conversationPreview(text) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  if (one.length <= PREVIEW_LEN) return one;
  return one.slice(0, PREVIEW_LEN - 1).trimEnd() + '…';
}

// Customer phone digits when the JID is a phone-number chat
// (923...@s.whatsapp.net); '' for a LID chat (@lid) — a LID is not a
// phone number and must never be shown as one.
function customerPhoneForJid(jid) {
  const s = String(jid || '');
  if (!s.endsWith('@s.whatsapp.net')) return '';
  const digits = s.split('@')[0].replace(/\D/g, '');
  return digits || '';
}

function normalizeChat(chat, jid) {
  if (!chat || typeof chat !== 'object') {
    return { jid: String(jid || ''), name: '', customerPhone: customerPhoneForJid(jid), messages: [], lastAt: null };
  }
  return {
    jid: String(jid || ''),
    name: typeof chat.name === 'string' ? chat.name : '',
    customerPhone: typeof chat.customerPhone === 'string' ? chat.customerPhone : customerPhoneForJid(jid),
    messages: Array.isArray(chat.messages) ? chat.messages : [],
    lastAt: chat.lastAt || null,
  };
}

// Record one message. dir is 'in' (customer -> bot) or 'out' (bot ->
// customer). accountPhone is the linked number that received/sent it.
// opts: { at, name } — name is the customer's display name (pushName),
// recorded on incoming messages only. Never throws: on any failure it
// logs and returns false, so a store failure can never break a reply.
// Returns true when the message was stored.
function recordConversation(businessId, jid, dir, text, accountPhone, opts) {
  try {
    if (!businessId || !jid || (dir !== 'in' && dir !== 'out')) return false;
    const cleanText = String(text || '');
    if (!cleanText.trim()) return false;
    const all = loadConversations();
    const bizId = String(businessId);
    if (!all[bizId] || typeof all[bizId] !== 'object') all[bizId] = {};
    const chats = all[bizId];
    const key = String(jid);
    let chat = normalizeChat(chats[key], key);
    const at = (opts && opts.at) || new Date().toISOString();
    if (opts && typeof opts.name === 'string' && opts.name.trim()) chat.name = opts.name.trim();
    if (!chat.customerPhone) chat.customerPhone = customerPhoneForJid(key);
    chat.messages.push({
      dir,
      text: cleanText,
      at,
      phone: String(accountPhone || '').replace(/\D/g, ''),
    });
    // Cap: last 200 messages per customer, oldest drop first.
    while (chat.messages.length > MAX_MESSAGES_PER_CHAT) chat.messages.shift();
    chat.lastAt = at;
    chats[key] = chat;
    // Cap: 50 chats per business, oldest drop first — the chat just
    // written is the newest, so it is never the one dropped.
    const keys = Object.keys(chats);
    if (keys.length > MAX_CHATS_PER_BUSINESS) {
      keys
        .filter((k) => k !== key)
        .sort((a, b) => String(chats[a].lastAt || '') < String(chats[b].lastAt || '') ? -1 : 1)
        .slice(0, keys.length - MAX_CHATS_PER_BUSINESS)
        .forEach((k) => { delete chats[k]; });
    }
    saveConversations(all);
    return true;
  } catch (e) {
    console.error('recordConversation failed:', (e && e.message) || e);
    return false;
  }
}

// Chat list for a business, newest first. Preview is capped at 80
// chars; full chat text is NEVER returned here — only the thread
// endpoint returns it, behind the admin token.
function listConversations(businessId) {
  const all = loadConversations();
  const chats = all[String(businessId)] || {};
  return Object.keys(chats)
    .map((jid) => {
      const chat = normalizeChat(chats[jid], jid);
      const last = chat.messages[chat.messages.length - 1];
      const incoming = chat.messages.filter((m) => m.dir === 'in').length;
      const outgoing = chat.messages.filter((m) => m.dir === 'out').length;
      const phones = [];
      for (const m of chat.messages) {
        if (m.phone && !phones.includes(m.phone)) phones.push(m.phone);
      }
      return {
        jid,
        name: chat.name || '',
        phone: chat.customerPhone || '',
        lastMessage: last ? conversationPreview(last.text) : '',
        lastAt: chat.lastAt || (last ? last.at : null),
        counts: { incoming, outgoing, total: chat.messages.length },
        phones,
      };
    })
    .sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
}

// Full thread for one customer, newest last (stored order, already
// capped at 200). Returns null when the business has no chat with
// this JID.
function getConversationThread(businessId, jid) {
  const all = loadConversations();
  const chats = all[String(businessId)] || {};
  const raw = chats[String(jid)];
  if (!raw) return null;
  const chat = normalizeChat(raw, String(jid));
  const incoming = chat.messages.filter((m) => m.dir === 'in').length;
  const outgoing = chat.messages.filter((m) => m.dir === 'out').length;
  return {
    jid: String(jid),
    name: chat.name || '',
    phone: chat.customerPhone || '',
    lastAt: chat.lastAt || null,
    counts: { incoming, outgoing, total: chat.messages.length },
    messages: chat.messages.map((m) => ({ dir: m.dir, text: m.text, at: m.at, phone: m.phone || '' })),
  };
}

module.exports = {
  CONVERSATIONS_FILE,
  MAX_MESSAGES_PER_CHAT,
  MAX_CHATS_PER_BUSINESS,
  PREVIEW_LEN,
  loadConversations,
  saveConversations,
  conversationPreview,
  customerPhoneForJid,
  recordConversation,
  listConversations,
  getConversationThread,
};
