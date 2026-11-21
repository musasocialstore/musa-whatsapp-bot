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
// BLOCK-AWARE strip (2026-11-21, Zaib): a bot message can span several
// lines ("Hello! Welcome...\n\nBataiye, aap kis tarah ki website...?"),
// and only its FIRST line starts with "Bot:". A line-by-line filter
// kept the second half as if the CUSTOMER said it — that is exactly how
// the bot's own greeting became the "Wants" of the 2:58 PM lead. A line
// belongs to the block started by the last "Bot:" / "Customer:" label.
function stripBotBlocks(raw) {
  const out = [];
  let inBot = false;
  for (const line of String(raw || '').split(/\n/)) {
    if (/^\s*Bot\s*:/i.test(line)) { inBot = true; continue; }
    if (/^\s*Customer\s*:/i.test(line)) { inBot = false; out.push(line.replace(/^\s*Customer\s*:\s*/i, '')); continue; }
    if (!inBot) out.push(line);
  }
  return out.join('\n');
}
const GREETING_PREFIX_RE = /^(salam|assalam[^,!.]*|aoa|hi|hello|hey|hy|good (morning|afternoon|evening))[,!.]?\s*/i;
const CONFIRM_SENTENCE_RE = /^(han|haan|ji|yes|ok|okay|sure|theek hai|done|final|confirm|book kar|karwa do|banwa do|zaroor|bilkul)\b/i;
const NAME_SENTENCE_RE = /(mera naam|my name is|name is)/i;
const ADDRESS_SENTENCE_RE = /(address|mera address|pata|my address|deliver (to|at)|ghar ka pata)/i;
const PRICE_ONLY_RE = /^\W*(?:rs\.?|pkr|₨|rupees?)?\s*[\d,]{3,7}\s*(?:final|theek|done|ok)?\W*$/i;
const WANT_WORDS_RE = /(chahiye|chahie|lena|karna|banwa|order|book|want|need)/i;
// A "question to the customer" is not a want — "Bataiye, aap kis tarah
// ki website..." asks THEM; it never describes what they want.
const ASK_QUESTION_RE = /^(bataiye|batao|bata dein|batain|tell me|what|which|kis tarah|kaun|kab|kitne|kahan)\b/i;

// The customer's OWN name only — "mera naam X hai" / "my name is X" /
// "main X hun". A bare "naam" is NOT enough: "pizza restaurant jiska
// naam hai HFC" is the RESTAURANT's name, and the old regex turned it
// into the customer's name ("hai hfc theek", 06:13 AM lead, 2026-11-21).
// Filler words can never be a name.
const NAME_FILLER_RE = /^(hai|theek|kya|check|microphone|basic|ok|ji|haan|han|bhai|yar|yaar|aoa|salam)$/i;
function extractCustomerName(raw) {
  const t = String(raw || '');
  let m = t.match(/(?:mera naam|my name is|name is)\s*:?\s*([A-Za-z][A-Za-z .]{1,40}?)(?:\s+hai\b|\s+he\b|\s+is\b|,|\.|$)/i);
  if (m) {
    const name = m[1].trim().replace(/[.,;]+$/, '');
    if (name && !NAME_FILLER_RE.test(name) && !/\b(hai|theek|check|microphone)\b/i.test(name)) return name;
  }
  // "main Ahmed Raza hun" / "I am Ahmed Raza"
  m = t.match(/(?:main|i am|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:hun|hoon|hu|hai)\b/);
  if (m) return m[1].trim();
  return '';
}

// A phone number the customer TYPED in the chat (+92... / 03... / 92...).
// Used when the chat's JID is a WhatsApp LID, not a phone number —
// Baileys 6.7.24 has no remoteJidAlt, so the typed number is the only
// way to get the real one.
function extractPhoneNumber(raw) {
  const t = String(raw || '');
  const m = t.match(/(?:\+?92|0)?3\d{2}[\s-]?\d{7}\b|\+?\d{10,13}\b/);
  if (!m) return '';
  const digits = m[0].replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) return '';
  return '+' + (digits.startsWith('92') ? digits : digits.startsWith('0') ? '92' + digits.slice(1) : digits);
}

// An email the customer TYPED in the chat. WhatsApp profiles have no
// email field — the address can only come from the customer's own words.
function extractEmail(raw) {
  const t = String(raw || '');
  const m = t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0] : '';
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
// (2026-11-21, Zaib): the bot's own greeting once became the "Wants",
// and a mic-check became a lead — so a question ASKED to the customer,
// a bracketed media note ("[Customer sent a photo...]"), a bare
// greeting ("Hy") and a short fragment with no want word are all
// skipped. The "mujhe X <verb>" match no longer needs the verb at the
// END of the sentence — in a long voice-note message the verb sits
// mid-sentence ("mujhe ... selling point create karwana hai jaisa ki...").
function extractWants(raw) {
  const lines = stripBotBlocks(raw).split(/\n/);
  const wants = [];
  const addWant = (w) => {
    // Strip leading filler words voice notes are full of ("na", "to",
    // "basically", "yar", "dekho") so the want starts at the real words.
    w = String(w || '').trim().replace(/^(na|to|basically|yar|yaar|ham|bhai|dekho|ek|aik|a|an|one)\s+/i, '').replace(/^(na|to|basically|yar|yaar|ham|bhai|dekho)\s+/i, '').replace(/[.,;!?]+$/, '').trim();
    if (!w || w.length > 120) return;
    if (NAME_SENTENCE_RE.test(w) || ADDRESS_SENTENCE_RE.test(w) || PRICE_ONLY_RE.test(w)) return;
    if (wants.some((x) => x.toLowerCase().includes(w.toLowerCase()))) return;
    for (let i = 0; i < wants.length; i++) {
      if (w.toLowerCase().includes(wants[i].toLowerCase())) { wants[i] = w; return; }
    }
    wants.push(w);
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // A bracketed note about media ("[Customer sent a photo...]") is
    // not something the customer wants.
    if (trimmed.startsWith('[')) continue;
    for (let sentence of trimmed.split(/(?<=[.!?])\s+/)) {
      sentence = sentence.replace(GREETING_PREFIX_RE, '').trim();
      if (!sentence) continue;
      if (ASK_QUESTION_RE.test(sentence)) continue;
      if (CONFIRM_SENTENCE_RE.test(sentence)) continue;
      if (NAME_SENTENCE_RE.test(sentence) && !WANT_WORDS_RE.test(sentence)) continue;
      if (ADDRESS_SENTENCE_RE.test(sentence) && !WANT_WORDS_RE.test(sentence)) continue;
      if (PRICE_ONLY_RE.test(sentence)) continue;
      let m = sentence.match(/(?:mujhe|muje|i want|i need)\s+(.+?)\s+(?:chahiye|chahie|lena hai|karna hai|banwa do|banwani hai|banana hai|banani hai|create karvani hai|karwana hai|order karna hai|book karna hai)\b/i)
        || sentence.match(/(?:mujhe|muje|i want|i need)\s+(.+?)(?:\s+chahiye|\s+chahie|,|$)/i);
      if (m) { addWant(m[1]); continue; }
      m = sentence.match(/^(.+?)\s+(?:create karvani hai|banwani hai|banana hai|banani hai|banwa do|karwana hai|karna hai|lena hai|order karna hai|book karna hai|chahiye|chahie)\b/i);
      if (m) { addWant(m[1]); continue; }
      // A bare sentence is only a want if it actually asks for
      // something or says enough to mean something — "Is tara ke"
      // (a cut-off fragment) is neither.
      if (!NAME_SENTENCE_RE.test(sentence) && !ADDRESS_SENTENCE_RE.test(sentence)
        && (WANT_WORDS_RE.test(sentence) || sentence.length > 40)) addWant(sentence);
    }
    if (wants.length >= 2) break;
  }
  return wants.slice(0, 2).join(' + ');
}

// Only the CUSTOMER's words — the bot's own lines are stripped, so a
// name/address is never "extracted" from a bot question like "Aap apna
// naam aur address bata dein" (that bug once produced Name: "aur
// address bata dein"). Block-aware: a multi-line bot message is one
// block, so its continuation lines never leak in as customer words.
// The agreed PRICE still reads the full text, because the price is
// usually in the bot's "total Rs 1000" line.
function customerOnlyText(raw) {
  return stripBotBlocks(raw);
}

// Best-effort extraction from free text, so name / address are not lost.
// Examples: "mera naam Ali hai", "my name is Ali", "address: Lahore, Main Bazar",
// "mera address Lahore hai", "I want a website".
// wants is the SHORT extracted want (never the full text — rawText keeps
// the full conversation for the dashboard, but the alert never shows it).
// opts (2026-11-21, Zaib): { displayName, isLid }.
// - displayName is the customer's WhatsApp name (msg.pushName) — the
//   NAME in the alert, unless the customer typed their own name.
// - isLid means the chat's JID is a WhatsApp LID (a long numeric ID),
//   not a phone number — Baileys 6.7.24 has no remoteJidAlt, so the
//   digits must never be shown as a phone number. The real number is
//   used only if the customer typed it in the chat.
function parseLead(business, customerJid, text, opts) {
  const raw = String(text || '');
  const isLid = !!(opts && opts.isLid) || /@lid\s*$/.test(String(customerJid || ''));
  const digits = (customerJid || '').replace(/@.*$/, '').replace(/\D/g, '');
  const customerText = customerOnlyText(raw);
  const typedNumber = extractPhoneNumber(customerText);
  let customerNumber = '+' + digits;
  let numberIsLid = false;
  if (isLid) {
    if (typedNumber) customerNumber = typedNumber;
    else { customerNumber = '+' + digits; numberIsLid = true; }
  }
  const customerName = (opts && opts.displayName ? String(opts.displayName).trim() : '')
    || extractCustomerName(customerText);
  return {
    businessId: business.id,
    businessName: business.name || business.id,
    customerNumber,
    numberIsLid,
    rawJid: String(customerJid || ''),
    customerName,
    email: extractEmail(customerText),
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
// name, number, what they want, address (if given), agreed price, and
// the email the customer typed (if any — WhatsApp profiles have no
// email field, so it only appears when the customer wrote it).
// A LID number is never shown as a phone number: the alert says so
// plainly, so the owner asks the customer for their real number.
// No full conversation, no middle deal details, no timestamps.
function leadText(business, lead) {
  const lines = [`New lead — ${lead.businessName}`];
  lines.push(`Name: ${lead.customerName || '—'}`);
  if (lead.numberIsLid && !lead.customerNumber) lines.push('Number: (WhatsApp ID only — ask the customer for their number)');
  else if (lead.numberIsLid) lines.push(`Number: ${lead.customerNumber} (WhatsApp ID — confirm the real number with the customer)`);
  else lines.push(`Number: ${lead.customerNumber}`);
  lines.push(`Wants: ${lead.wants || '—'}`);
  if (lead.email) lines.push(`Email: ${lead.email}`);
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

async function captureAndForward(business, customerJid, text, sendFn, opts) {
  const lead = parseLead(business, customerJid, text, opts);
  // No duplicate alerts (2026-11-21, Zaib): one customer produced 7
  // alerts in one day because every message re-captured the same lead.
  // If the same customer already has a lead from the last 6 hours with
  // the same wants + price (or the new one has no wants at all), the
  // owner already knows — save nothing, send nothing.
  const prev = (store.listLeads(business.id) || [])
    .filter((l) => l.customerNumber === lead.customerNumber)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (prev && Date.now() - new Date(prev.createdAt).getTime() < 6 * 60 * 60 * 1000) {
    const sameDetails = prev.wants === lead.wants && prev.price === lead.price;
    if (!lead.wants || sameDetails) {
      return { lead: prev, skipped: true, reason: 'duplicate lead — same customer, same details, already alerted' };
    }
  }
  store.addLead(lead); // assigns id + createdAt on `lead` itself
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

module.exports = { looksLikeLead, parseLead, captureAndForward, confirmLead, forwardLead, sendLeadEmail, sendLeadWhatsapp, findAgreedPrice, extractWants, extractCustomerName, extractAddress, extractPhoneNumber, extractEmail, customerOnlyText, leadText };
