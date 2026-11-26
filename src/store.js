// Simple JSON store for business profiles + leads.
// One profile per business. Each business has its own prompt, media,
// lead email, lead WhatsApp number and Baileys auth folder.
// Replace with a real DB (Supabase / Postgres) when the platform grows.
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'businesses.json');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function defaultBusiness(id) {
  return {
    id,
    name: '',
    phone: '', // the business's own WhatsApp number, entered at pairing time
    prompt: '',
    leadEmail: '',
    leadWhatsapp: '', // owner number to receive leads, e.g. +923106865269
    media: [], // { id, kind: 'image'|'video'|'audio', filename, originalName, caption, useFor, ownerNote, description, analyzedAt }
    brainMemory: [], // Brain Chat conversation: { role: 'owner'|'brain', text, at }
    brainSummary: null, // distilled understanding: { name, category, services, prices, deals, location, contact }
    campaigns: [], // Bulk Messages: { id, type: 'send'|'draft', message, numbers: [{phone, status, error}], status, createdAt, sentCount, failedCount }
    linked: false,
    linkedAt: null,
    // Multi-account (2026-11-26): one business can link MULTIPLE
    // WhatsApp numbers. accounts[] is the record of them:
    // [{ phone, linked, linkedAt }] — accounts[0] is the primary and
    // business.phone / business.linked / business.linkedAt mirror it
    // for backward compatibility. The Brain (prompt, brainSummary,
    // learnedQA) is per business and shared by every account.
    accounts: [],
    // Last logout (2026-11-26): set when a session is revoked by
    // WhatsApp (401/loggedOut) — { at, code, reason, phone, hint }.
    // A revoked identity is dead; only a fresh pairing code revives
    // it. Survives restarts so the admin can see WHEN and WHY a link
    // died. Null when no logout has ever been recorded.
    lastLogout: null,
    createdAt: new Date().toISOString(),
  };
}

function getBusiness(id) {
  ensureDir();
  const all = readJson(STORE_FILE, {});
  if (!all[id]) {
    all[id] = defaultBusiness(id);
    writeJson(STORE_FILE, all);
  }
  return all[id];
}

function saveBusiness(business) {
  const all = readJson(STORE_FILE, {});
  all[business.id] = business;
  writeJson(STORE_FILE, all);
  return business;
}

function listBusinesses() {
  return Object.values(readJson(STORE_FILE, {}));
}

function addLead(lead) {
  const leads = readJson(LEADS_FILE, []);
  lead.id = lead.id || ('lead_' + Date.now());
  lead.createdAt = lead.createdAt || new Date().toISOString();
  lead.status = lead.status || 'new';
  lead.forwardedEmail = !!lead.forwardedEmail;
  lead.forwardedWhatsapp = !!lead.forwardedWhatsapp;
  lead.forwardLog = lead.forwardLog || [];
  leads.push(lead);
  writeJson(LEADS_FILE, leads);
  return lead;
}

function listLeads(businessId) {
  const leads = readJson(LEADS_FILE, []);
  const filtered = businessId ? leads.filter((l) => l.businessId === businessId) : leads;
  // Newest first.
  return filtered.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function getLead(businessId, leadId) {
  return listLeads(businessId).find((l) => l.id === leadId) || null;
}

function updateLead(businessId, leadId, patch) {
  const leads = readJson(LEADS_FILE, []);
  const idx = leads.findIndex((l) => l.id === leadId && (!businessId || l.businessId === businessId));
  if (idx === -1) return null;
  leads[idx] = { ...leads[idx], ...patch };
  writeJson(LEADS_FILE, leads);
  return leads[idx];
}

module.exports = { getBusiness, saveBusiness, listBusinesses, addLead, listLeads, getLead, updateLead, DATA_DIR };
