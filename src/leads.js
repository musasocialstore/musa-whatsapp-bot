// Lead capture + forwarding.
// A lead is captured when a customer gives details (name / number / address / what they want),
// or when the AI reply detects the customer is ready ("final", "book", "order", "chahiye", "confirm").
// The lead is then sent to BOTH:
//   1. the email the business owner provided, via Resend (free tier)
//   2. the WhatsApp number the business owner provided, via their own linked WhatsApp session
//
// Confirm flow (dashboard): a lead starts as "new". When the owner clicks
// "Mark confirmed", confirmLead() forwards it to the saved email + WhatsApp
// number and marks it "confirmed". If a key / session is missing, the lead
// is still saved, status is still updated, and the reason is recorded in
// lead.forwardLog so the dashboard can show exactly why it did not send.
//
// ALERT FORMAT (2026-11-20, Brain improvements): the owner alert is SHORT
// and shows ONLY: customer name, phone number, what they want, address
// (if given), agreed price. NOTHING else — no full conversation, no
// middle deal details, no timestamps. The extraction is GENERIC: it
// reads the customer's own sentences for name / address / want / price
// patterns, so it works for ANY business — a KFC burger + cold drink
// order and a website order produce the same short shape.
'use strict';

const { Resend } = require('resend');
const store = require('./store');

const LEAD_WORDS = /(final|book|order|confirm|chahiye|mujhe ye|address|mera naam|my name|deliver|done|karna hai)/i;

function looksLikeLead(text, business) {
  if (!text) return false;
  return LEAD_WORDS.test(text) || /\d{10,}/.test(text);
}

// --- Short, generic extraction from free text ---
// Only the CUSTOMER's sentences are read — bot lines ("Bot: ...") are
// stripped first, so the alert never quotes the bot back at the owner.
const GREETING_PREFIX_RE = /^(salam|assalam[^,!.]*|aoa|hi|hello|hey|good (morning|afternoon|evening))[,!.]?\s*/i;
const CONFIRM_SENTENCE_RE = /^(han|haan|ji|yes|ok|okay|sure|theek hai|done|final|confirm|book kar|karwa do|banwa do|zaroor|bilkul)\b/i;
const NAME_SENTENCE_RE = /(mera naam|my name is|name is|\bnaam\b)/i;
const ADDRESS_SENTENCE_RE = /(address|mera address|pata|my address|deliver (to|at)|ghar ka pata)/i;
const PRICE_ONLY_RE = /^\W*(?:rs\.?|pkr|₨|rupees?)?\s*[\d,]{3,7}\s*(?:final|theek|done|ok)?\W*$/i;
const WANT_WORDS_RE = /(chahiye|chahie|lena|karna|banwa|order|book|want|need)/i;

function extractCustomerName(raw) {
  const t = String(raw || '');
  let m = t.match(/(?:mera naam|my name is|name is|naam)\s*:?\s*([A-Za-z][A-Za-z .]{1,40}?)(?:\s+hai\b|\s+he\b|\s+is\b|,|\.|$)/i);
  if (m) return m[1].trim().replace(/[.,;]+$/, '');
  // "main Ahmed Raza hun" / "I am Ahmed Raza"
  m = t.match(/(?:main|i am|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:hun|hoon|hu|hai)\b/);
  if (m) return m[1].trim();
  return '';
}

function extractAddress(raw) {
  const t = String(raw || '');
  const m = t.match(/(?:address|mera address|pata|my address|deliver (?:to|at)|ghar ka pata)\s*:?\s*([^\n]{3,150})/i);
  if (!m) return '';
  let a = m[1].trim();
  // Cut at the next sentence, or at a new clause ("... Lahore, mujhe
  // website chahiye" — the address ends at the comma before "mujhe").
  a = a.split(/(?<=[.!?])\s+(?=[A-Z\u0600-\u06FF])/)[0];
  a = a.split(/\s*,\s*(?=(mujhe|muje|i want|i need|mera naam|my name|phone|number)\b)/i)[0];
  a = a.split(/\s+(?=(mujhe|muje)\b)/i)[0];
  a = a.replace(/\s+hai\.?\s*$/i, '').replace(/[.,;]+$/, '').trim();
  return a.slice(0, 150);
}

// Agreed price — GENERIC, any business. Preference order:
//  1. an amount tied to total / final / agreed / bill / price (LAST one wins —
//     the agreed price, not the first price mentioned in a rate list);
//  2. otherwise the LAST "Rs X" / "PKR X" amount in the conversation;
//  3. a bare number in a short agreement line ("2500 theek hai").
// Phone numbers can never match: amounts are 3–7 digits and rule 3
// skips any line containing a 10+ digit phone number.
function findAgreedPrice(historyText) {
  const t = String(historyText || '');
  const norm = (n) => 'Rs ' + String(n).replace(/,/g, '');
  const tied = [...t.matchAll(/(?:total|final|agreed|bill|price)\b[^0-9\n]{0,15}([\d,]{3,7})\b|([\d,]{3,7})\s*(?:final|total)\b/gi)];
  if (tied.length) {
    const last = tied[tied.length - 1];
    return norm(last[1] || last[2]);
  }
  const labelled = [...t.matchAll(/(?:rs\.?|pkr|₨|rupees?)\s*([\d,]{3,7})\b/gi)];
  if (labelled.length) return norm(labelled[labelled.length - 1][1]);
  for (const line of t.split(/\n/)) {
    if (/^\s*(han|haan|ji|yes|ok|theek|done|final|confirm)/i.test(line) && !/\d[\d\s-]{9,}/.test(line)) {
      const n = line.match(/\b([\d,]{3,7})\b(?!\s*\d)/);
      if (n) return norm(n[1]);
    }
  }
  return '';
}

// What does the customer WANT — one short phrase, not the conversation.
// Reads only customer sentences: greetings, confirmations, name and
// address sentences are dropped; "mujhe X chahiye" / "X create karvani
// hai" / "I want X" give X; anything else that looks like a request is
// kept as-is (capped at 120 chars). At most 2 wants, joined with " + ".
function extractWants(raw) {
  const lines = String(raw || '').split(/\n/)
    .filter((l) => !/^\s*Bot\s*:/i.test(l))
    .map((l) => l.replace(/^\s*Customer\s*:\s*/i, ''));
  const wants = [];
  const addWant = (w) => {
    w = String(w || '').trim().replace(/^(ek|aik|a|an|one)\s+/i, '').replace(/[.,;!?]+$/, '').trim();
    if (!w || w.length > 120) return;
    if (NAME_SENTENCE_RE.test(w) || ADDRESS_SENTENCE_RE.test(w) || PRICE_ONLY_RE.test(w)) return;
    if (wants.some((x) => x.toLowerCase().includes(w.toLowerCase()))) return;
    for (let i = 0; i < wants.length; i++) {
      if (w.toLowerCase().includes(wants[i].toLowerCase())) { wants[i] = w; return; }
    }
    wants.push(w);
  };
  for (const line of lines) {
    for (let sentence of line.split(/(?<=[.!?])\s+/)) {
      sentence = sentence.replace(GREETING_PREFIX_RE, '').trim();
      if (!sentence) continue;
      if (CONFIRM_SENTENCE_RE.test(sentence)) continue;
      if (NAME_SENTENCE_RE.test(sentence) && !WANT_WORDS_RE.test(sentence)) continue;
      if (ADDRESS_SENTENCE_RE.test(sentence) && !WANT_WORDS_RE.test(sentence)) continue;
      if (PRICE_ONLY_RE.test(sentence)) continue;
      let m = sentence.match(/(?:mujhe|muje|i want|i need)\s+(.+?)\s+(?:chahiye|chahie|lena hai|karna hai|banwa do|banwani hai|create karvani hai|karwana hai|order karna hai|book karna hai)\s*$/i)
        || sentence.match(/(?:mujhe|muje|i want|i need)\s+(.+?)(?:\s+chahiye|\s+chahie|,|$)/i);
      if (m) { addWant(m[1]); continue; }
      m = sentence.match(/^(.+?)\s+(?:create karvani hai|banwani hai|banwa do|karwana hai|karna hai|lena hai|order karna hai|book karna hai|chahiye|chahie)\b/i);
      if (m) { addWant(m[1]); continue; }
      if (!NAME_SENTENCE_RE.test(sentence) && !ADDRESS_SENTENCE_RE.test(sentence)) addWant(sentence);
    }
    if (wants.length >= 2) break;
  }
  return wants.slice(0, 2).join(' + ');
}

// Only the CUSTOMER's words — the bot's own lines are stripped, so a
// name/address is never "extracted" from a bot question like "Aap apna
// naam aur address bata dein" (that bug once produced Name: "aur
// address bata dein"). The agreed PRICE still reads the full text,
// because the price is usually in the bot's "total Rs 1000" line.
// Only the CUSTOMER's words — the bot's own lines are stripped, so a
// name/address is never "extracted" from a bot question like "Aap apna
// naam aur address bata dein" (that bug once produced Name: "aur
// address bata dein"). The agreed PRICE still reads the full text,
// because the price is usually in the bot's "total Rs 1000" line.
function customerOnlyText(raw) {
  return String(raw || '').split(/\n/)
    .filter((l) => !/^\s*Bot\s*:/i.test(l))
    .map((l) => l.replace(/^\s*Customer\s*:\s*/i, ''))
    .join('\n');
}

// Best-effort extraction from free text, so name / address are not lost.
// Examples: "mera naam Ali hai", "my name is Ali", "address: Lahore, Main Bazar",
// "mera address Lahore hai", "I want a website".
// wants is the SHORT extracted want (never the full text — rawText keeps
// the full conversation for the dashboard, but the alert never shows it).
function parseLead(business, customerJid, text) {
  const raw = String(text || '');
  const number = (customerJid || '').replace(/@.*$/, '').replace(/^(\d+)/, '+$1');
  const customerText = customerOnlyText(raw);
  return {
    businessId: business.id,
    businessName: business.name || business.id,
    customerNumber: number,
    customerName: extractCustomerName(customerText),
    address: extractAddress(customerText),
    wants: extractWants(customerText),
    price: findAgreedPrice(raw),
    rawText: raw,
    status: 'new',
    forwardedEmail: false,
    forwardedWhatsapp: false,
    forwardLog: [],
  };
}

// SHORT owner alert — the SAME text goes to email and WhatsApp. Only:
// name, number, what they want, address (if given), agreed price.
// No full conversation, no middle deal details, no timestamps.
function leadText(business, lead) {
  const lines = [`New lead — ${lead.businessName}`];
  lines.push(`Name: ${lead.customerName || '—'}`);
  lines.push(`Number: ${lead.customerNumber}`);
  lines.push(`Wants: ${lead.wants || '—'}`);
  if (lead.address) lines.push(`Address: ${lead.address}`);
  if (lead.price) lines.push(`Price: ${lead.price}`);
  return lines.join('\n');
}

async function sendLeadEmail(business, lead) {
  if (!business.leadEmail) return { skipped: true, reason: 'no leadEmail set — save one in Lead Notification Settings' };
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey === 'YOUR_RESEND_API_KEY_HERE') {
    return { skipped: true, reason: 'RESEND_API_KEY not set — lead saved, email not sent' };
  }
  const resend = new Resend(apiKey);
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  const { error } = await resend.emails.send({
    from,
    to: business.leadEmail,
    subject: `New lead — ${lead.businessName}: ${lead.customerNumber}`,
    text: leadText(business, lead),
  });
  if (error) return { ok: false, error: String(error.message || error) };
  return { ok: true };
}

// Sends the lead to the owner's WhatsApp number using the business's own linked session.
// `sendFn` is whatsapp.sendText(businessId, jid, text) — passed in to avoid a circular import.
async function sendLeadWhatsapp(business, lead, sendFn) {
  if (!business.leadWhatsapp) return { skipped: true, reason: 'no leadWhatsapp set — save one in Lead Notification Settings' };
  if (!sendFn) return { skipped: true, reason: 'no WhatsApp sender — link WhatsApp first' };
  const jid = business.leadWhatsapp.replace(/\D/g, '') + '@s.whatsapp.net';
  await sendFn(business.id, jid, leadText(business, lead));
  return { ok: true };
}

async function forwardLead(business, lead, sendFn) {
  const log = [];
  const email = await sendLeadEmail(business, lead).catch((e) => ({ ok: false, error: String(e.message || e) }));
  const wa = await sendLeadWhatsapp(business, lead, sendFn).catch((e) => ({ ok: false, error: String(e.message || e) }));
  log.push({ channel: 'email', at: new Date().toISOString(), ...(email.ok ? { ok: true } : email.skipped ? { skipped: true, reason: email.reason } : { ok: false, error: email.error }) });
  log.push({ channel: 'whatsapp', at: new Date().toISOString(), ...(wa.ok ? { ok: true } : wa.skipped ? { skipped: true, reason: wa.reason } : { ok: false, error: wa.error }) });
  return { email, whatsapp: wa, log, forwardedEmail: !!email.ok, forwardedWhatsapp: !!wa.ok };
}

async function captureAndForward(business, customerJid, text, sendFn) {
  const lead = store.addLead(parseLead(business, customerJid, text));
  const result = await forwardLead(business, lead, sendFn);
  store.updateLead(business.id, lead.id, {
    forwardedEmail: result.forwardedEmail,
    forwardedWhatsapp: result.forwardedWhatsapp,
    forwardLog: result.log,
  });
  return { lead: { ...lead, forwardedEmail: result.forwardedEmail, forwardedWhatsapp: result.forwardedWhatsapp, forwardLog: result.log }, email: result.email, whatsapp: result.whatsapp };
}

// Dashboard confirm: mark the lead confirmed and forward it now.
// Never throws on a missing key / session — it records the reason instead.
async function confirmLead(business, leadId, sendFn) {
  const lead = store.getLead(business.id, leadId);
  if (!lead) return { error: 'lead not found' };
  const result = await forwardLead(business, lead, sendFn);
  const updated = store.updateLead(business.id, leadId, {
    status: 'confirmed',
    forwardedEmail: result.forwardedEmail,
    forwardedWhatsapp: result.forwardedWhatsapp,
    forwardLog: result.log,
  });
  return { lead: updated, email: result.email, whatsapp: result.whatsapp };
}

module.exports = { looksLikeLead, parseLead, captureAndForward, confirmLead, forwardLead, sendLeadEmail, sendLeadWhatsapp, findAgreedPrice, extractWants, extractCustomerName, extractAddress, leadText };
