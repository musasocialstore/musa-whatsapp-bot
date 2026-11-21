// Gemini AI replies — free tier.
// The bot's brain IS the whole business control: every reply is
// built from the owner's saved prompt AND everything the owner
// taught the brain (brainMemory / brainSummary) AND the AI
// descriptions of uploaded media (listings, prices, pictures). The
// bot replies in the SAME language the customer uses — Urdu script,
// Roman Urdu, English, or any other language — and switches when
// the customer switches. It never says it is an AI / assistant /
// robot, never says "I can't", and answers every question from the
// business facts — even when Gemini itself is unreachable, the
// facts-first fallback answers the same way.
//
// The owner may write that prompt in ANY local language, in plain
// words — Roman Urdu, Urdu, English, or mixed — e.g. "mera business
// ye hai, main website development karta hun, ads run karta hun,
// location ye hai, rate list ye hai, customer ye bole to ye kehna
// hai". The AI analyses the WHOLE prompt (see parseBusinessPrompt)
// and replies from it — it never invents services, prices or offers.
//
// Tone: a friendly HUMAN talking, not a robot / board. Short, warm,
// natural, varied — never the same canned message twice in a row.
//
// Media: the bot understands what each uploaded file IS (logo, offer
// banner, price plan, demo, intro voice — see classifyMedia) and
// decides, from the customer's words, when / to whom to send it,
// always with a short written line about it.
//
// WhatsApp policy safety (built into every reply): the bot ONLY
// replies to incoming customer messages. It never starts a
// conversation, never mass-messages, never sends unsolicited promos,
// never chases a customer, and stops politely if the customer says
// stop / no. One short reply per incoming message (+ media only
// when it really fits). That is how the business number stays safe
// from a ban.
'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');

// Primary model: gemini-3.8-flash is the model Google itself recommends
// for this account (2.5-flash and 2.0-flash both 404 "no longer
// available"). The lite model is the fallback — it is in this account's
// AI Studio list and usually answers when the main model is overloaded.
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const FALLBACK_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_TIMEOUT_MS = 45000;
let model = null;
let fallbackModel = null;

function getModel() {
  if (model) return model;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') return null;
  const genAI = new GoogleGenerativeAI(apiKey);
  // temperature > 0 so replies are varied and natural, not the same
  // sentence every time.
  model = genAI.getGenerativeModel({
    model: PRIMARY_MODEL,
    generationConfig: { temperature: 0.8 },
  });
  return model;
}

function getFallbackModel() {
  if (fallbackModel) return fallbackModel;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') return null;
  const genAI = new GoogleGenerativeAI(apiKey);
  fallbackModel = genAI.getGenerativeModel({
    model: FALLBACK_MODEL,
    generationConfig: { temperature: 0.8 },
  });
  return fallbackModel;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Gemini request timed out')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function isRetryableGeminiError(e) {
  const m = String((e && e.message) || e || '');
  return /503|429|overload|high demand|Service Unavailable|ECONNRESET|ETIMEDOUT|timed out|fetch failed/i.test(m);
}

// One Gemini text call, resilient: retry the primary model once after a
// short wait on overload/rate errors, then try the lite fallback model.
// Each attempt is capped so a hung call fails fast instead of hanging.
async function generateContentResilient(parts) {
  const attempts = [
    { model: getModel(), waitMs: 0 },
    { model: getModel(), waitMs: 4000 },
    { model: getFallbackModel(), waitMs: 0 },
  ];
  let lastError = null;
  for (const a of attempts) {
    if (!a.model) continue;
    if (a.waitMs) await sleep(a.waitMs);
    try {
      return await withTimeout(a.model.generateContent(parts), GEMINI_TIMEOUT_MS);
    } catch (e) {
      lastError = e;
      if (!isRetryableGeminiError(e)) throw e;
    }
  }
  throw lastError || new Error('Gemini request failed');
}

// --- Fast brain path (2026-11-20, Brain improvements: "Analyzing" took
// 70–96s under Gemini overload) ---
// The OWNER's chat with the brain must answer in SECONDS, never a
// minute. This path is used ONLY by brainChat — never by customer
// replies (generateReply keeps the 45s + retries above, because a
// customer reply is worth waiting for; an owner waiting on "Analyzing…"
// is not). Total budget ~14s: one 12s attempt on the primary model,
// at most ONE retry on the lite fallback with whatever budget is left,
// then give up and let the caller confirm locally. A bad key fails
// fast (non-retryable 400) and returns in under a second.
const BRAIN_TIMEOUT_MS = 12000;
const BRAIN_TOTAL_BUDGET_MS = 14000;
async function generateContentFast(parts) {
  const started = Date.now();
  const remaining = () => Math.max(1000, BRAIN_TOTAL_BUDGET_MS - (Date.now() - started));
  let lastError = null;
  const primary = getModel();
  if (primary) {
    try {
      return await withTimeout(primary.generateContent(parts), Math.min(BRAIN_TIMEOUT_MS, remaining()));
    } catch (e) {
      lastError = e;
      if (!isRetryableGeminiError(e)) throw e;
    }
  }
  const lite = getFallbackModel();
  if (lite) {
    try {
      return await withTimeout(lite.generateContent(parts), remaining());
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('Gemini request failed');
}

// --- Language detection (from the customer's own message) ---
// 'ur' = Urdu script (Arabic letters), 'roman-ur' = Roman Urdu,
// 'en' = English / anything else (Gemini handles other languages
// when it is configured; the fallback below covers en / roman-ur / ur).
const ROMAN_URDU_WORDS = [
  'chahiye', 'chahie', 'kya', 'kaisa', 'kaisi', 'kaise', 'batao', 'bataein',
  'bataen', 'mujhe', 'mera', 'meri', 'aap', 'ap', 'hai', 'hain', 'ho', 'kar',
  'karo', 'karke', 'mein', 'main', 'yeh', 'ye', 'woh', 'wo', 'kitne', 'kitna',
  'kitni', 'price', 'rate', 'chahte', 'chahta', 'chahti', 'sunao', 'sunna',
  'dikhao', 'dikha', 'dekh', 'bhejo', 'bhej', 'urdu', 'zaroor', 'theek',
  'deal', 'offer', 'kahan', 'kidhar', 'kab', 'kitni', 'der', 'bhook',
  'salam', 'assalam', 'aoa', 'walaikum',
];
const URDU_REQUEST = /\burdu\b/i; // "Urdu please", "speak Urdu", "urdu mein"

function detectLanguage(text) {
  const t = String(text || '');
  if (/[\u0600-\u06FF]/.test(t)) return 'ur';
  if (URDU_REQUEST.test(t)) return 'roman-ur';
  const lower = t.toLowerCase();
  const words = lower.split(/[^a-z]+/).filter(Boolean);
  const hits = words.filter((w) => ROMAN_URDU_WORDS.includes(w)).length;
  if (hits >= 1 && words.length <= 12) return 'roman-ur';
  if (hits >= 2) return 'roman-ur';
  return 'en';
}

function detectIntent(text) {
  const lower = String(text || '').toLowerCase();
  // Urdu-script keywords — the English lists below cannot match them.
  if (/قیمت|ریٹ|چارجز|فیس/.test(lower)) return 'price';
  if (/ڈیل|آفر|رعایت|ڈسکاؤنٹ/.test(lower)) return 'deal';
  if (/لوکیشن|پتہ|کہاں/.test(lower)) return 'location';
  if (/ڈیلیوری|ڈیلیور/.test(lower)) return 'delivery';
  if (/ویب سائٹ|ویب|سروس/.test(lower)) return 'service';
  if (/^[\s]*(سلام|السلام)/.test(lower)) return 'greeting';
  // "offer" counts as a deal question only when it is used as a noun
  // ("koi offer hai?", "any offers today?") — not as a verb ("what
  // services do you offer?"), which is a services question.
  if (/\b(deal|deals|discount|special|promo|promotion|combo)\b/.test(lower)) return 'deal';
  if (/\boffers?\b/.test(lower) && /\b(hai|kya|chahiye|today|running|available|any|batao|please|current|show|dikhao|send|bhejo)\b/.test(lower)) return 'deal';
  if (/\b(prices?|rates?|kitne|kitna|kitni|charges|fees|fee|cost|menu|rate list|price list)\b/.test(lower)) return 'price';
  if (/\b(deliver|delivery|delivered|order|book|booking|ghar|home)\b/.test(lower)) return 'delivery';
  if (/\b(demo|dikhao|dikha|show me|dekhna)\b/.test(lower)) return 'demo';
  if (/\b(location|address|kahan|kidhar|where|branch|area|city|town)\b/.test(lower)) return 'location';
  if (/^(hi|hello|hey|salam|aoa|assalam|adab|good (morning|afternoon|evening))\b/.test(lower.trim())) return 'greeting';
  if (URDU_REQUEST.test(lower) || /urdu (mein|main|please|bol|bolo|speak)/.test(lower)) return 'language';
  if (/(website|web site|site|app|account|accounts|course|courses|smm|panel|premium|service|services|food|kfc|burger|pizza|ads|advert|karte|karti|bechte|sell|selling)/.test(lower)) return 'service';
  return 'general';
}

// --- Prompt analysis: understand the WHOLE business prompt ---
// The owner writes in plain words, any language — usually as one
// flowing paragraph, exactly like telling a friend ("Mera business
// KFC hai, hum burgers bechte hain. Location: ... Rate list: ...").
// So the prompt is first split into SEGMENTS: lines, then sentences.
// (A sentence split needs a capital or Arabic letter after the full
// stop, so "Rs. 850" and "1,500 - 2,500" never split mid-fact.)
// Then the facts the bot needs — name, services, location, rate
// list, deals — are pulled out per segment, so replies (and even the
// no-key fallback) quote the owner's own facts segment by segment
// instead of dumping the whole paragraph at the customer.
// Returns { name, services[], prices[], deals[], location, contact, lines[] }.
function splitSegments(raw) {
  const segments = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    for (const part of line.split(/;\s*/)) {
      for (const s of part.split(/(?<=[.!?])\s+(?=[A-Z\u0600-\u06FF])/)) {
        const t = s.trim().replace(/^[-•*]\s*/, '');
        if (t) segments.push(t);
      }
    }
  }
  return segments;
}

function parseBusinessPrompt(prompt, businessName) {
  const raw = String(prompt || '');
  const lines = splitSegments(raw);
  const out = { name: businessName || '', services: [], prices: [], deals: [], location: '', contact: '', lines };
  if (!raw.trim()) return out;

  // Business name: "mera business KFC hai", "business name: KFC",
  // "hamara restaurant KFC hai", "name: Musa Social Store".
  // Stop at " hai" / " he" / punctuation, so "KFC hai" -> "KFC".
  const nameMatch = raw.match(/(?:business (?:name|ka naam)|mera business|hamara (?:business|restaurant|shop|store)|name)\s*:?\s*([A-Za-z0-9][A-Za-z0-9 .&'-]{1,30}?)(?:\s+hai\b|\s+he\b|\s+is\b|,|\.|$)/i);
  if (nameMatch) out.name = nameMatch[1].trim().replace(/[.,;]+$/, '');

  // Location / address: take the ONE segment that talks about it —
  // "Location: Main Bazaar Road, Lahore.", "hamari location Gulberg
  // hai" — and strip the label and the trailing "hai", so the rate
  // list that follows in the next sentence is never dragged in.
  const locSeg = lines.find((s) => /(location|address|pata)\b/i.test(s));
  if (locSeg) {
    const m = locSeg.match(/(?:location|address|pata)\s*(?:ye hai|hai|:)?\s*(.+)/i);
    if (m) out.location = m[1].trim().replace(/\s+hai\.?$/i, '').replace(/[.,;]+$/, '').slice(0, 100);
  }

  // Contact: first phone-like number in the prompt.
  const phoneMatch = raw.match(/(\+?\d[\d\s-]{9,14}\d)/);
  if (phoneMatch) out.contact = phoneMatch[1].trim();

  // Prices / rate list: any segment with a money amount (Rs / PKR /
  // ₨ / "price" / "rate") — keep the segment, it is the owner's own
  // words. e.g. "Basic website Rs 1,500", "Rate list: Zinger Burger
  // Rs 850, Chicken Bucket Rs 2,400". A segment that is really about
  // DELIVERY charges is only used when nothing else has a price.
  const deliveryPrices = [];
  for (const seg of lines) {
    if (/(rs\.?|pkr|₨|price|rate|charges?|fees?|cost)\b/i.test(seg) && /\d/.test(seg)) {
      if (/\bdeliver/i.test(seg)) { if (!deliveryPrices.includes(seg)) deliveryPrices.push(seg); }
      else if (!out.prices.includes(seg)) out.prices.push(seg);
    }
  }
  if (!out.prices.length) out.prices = deliveryPrices;
  // Also catch bare "Service — 1,500" segments with a number range.
  if (!out.prices.length) {
    for (const seg of lines) {
      if (/\d[\d,]{2,}/.test(seg) && /(website|burger|pizza|deal|plan|package|course|account|service)/i.test(seg)) {
        out.prices.push(seg);
      }
    }
  }

  // Deals / offers: segments mentioning deal, offer, discount, %, special.
  for (const seg of lines) {
    if (/\b(deal|offer|discount|%|special|combo|buy \d|free)\b/i.test(seg)) {
      if (!out.deals.includes(seg)) out.deals.push(seg);
    }
  }

  // Services: segments that describe what the business does. Keep
  // short, plain segments (not price segments already captured) that
  // mention a service keyword.
  const SERVICE_WORDS = /(website|web development|ads|advertis|social media|smm|account|course|food|burger|pizza|chicken|delivery|design|logo|video|premium|panel|restaurant|shop|store|service)/i;
  for (const seg of lines) {
    if (SERVICE_WORDS.test(seg) && !out.prices.includes(seg) && !out.deals.includes(seg)) {
      if (seg.length <= 140 && !out.services.includes(seg)) out.services.push(seg);
    }
  }
  return out;
}

function promptSummary(parsed) {
  const parts = [];
  if (parsed.name) parts.push(`Business name: ${parsed.name}`);
  if (parsed.services.length) parts.push(`Services: ${parsed.services.slice(0, 8).join(' | ')}`);
  if (parsed.prices.length) parts.push(`Rate list (owner's own words — use exactly these): ${parsed.prices.slice(0, 10).join(' | ')}`);
  if (parsed.deals.length) parts.push(`Deals / offers: ${parsed.deals.slice(0, 6).join(' | ')}`);
  if (parsed.location) parts.push(`Location: ${parsed.location}`);
  if (parsed.contact) parts.push(`Contact: ${parsed.contact}`);
  return parts.join('\n');
}

// Pick one of several human variants deterministically from the
// customer's message, so the same intent never gets the exact same
// canned sentence twice in a row for different messages.
function pickVariant(variants, seedText) {
  if (!variants.length) return '';
  let h = 0;
  for (const ch of String(seedText || '')) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return variants[h % variants.length];
}

// --- Facts-first fallback (used when Gemini is not configured or fails,
// e.g. Google overload) ---
// The customer must NEVER be able to tell from the reply whether
// Gemini answered or this fallback did: it never mentions AI, an
// assistant, a robot, or a connection problem, and it never refuses
// or deflects to the owner. It ANSWERS from the business's real
// facts — the saved prompt AND everything the owner taught the brain
// (brainMemory + distilled brainSummary) — rates, payment number,
// services, location. If a detail is genuinely unknown, it says it
// will confirm it and asks for the customer's name and what they
// need. Wording varies by language and intent, so it is never the
// same canned sentence twice.
//
// The brain IS the business control: the live record often has
// prompt "" (wiped by a redeploy) while brainMemory still holds the
// whole business — so the fallback reads the brain's facts too, not
// just business.prompt.
function fallbackFacts(business) {
  const parsed = parseBusinessPrompt((business && business.prompt) || '', (business && business.name) || '');
  const stored = (business && business.brainSummary) || {};
  const distilled = distillBrainSummary(business || {});
  const mergeArr = (...arrs) => [...new Set(arrs.flat().filter(Boolean).map((s) => String(s).trim().replace(/[.\s]+$/, '')))];
  const ownerTexts = ((business && business.brainMemory) || [])
    .filter((m) => m.role === 'owner').map((m) => m.text).join('\n');
  // Payment: the segment that names how to pay (Nayapay / JazzCash /
  // bank account ...) — usually "Payment Nayapay 03438220191 Ehtesham
  // Haider". Prefer the full segment; fall back to the contact number.
  let payment = '';
  const paySeg = splitSegments(`${(business && business.prompt) || ''}\n${ownerTexts}`)
    .find((s) => /(nayapay|jazzcash|easypaisa|bank account|payment|pay to|account number|account no)/i.test(s) && /\d/.test(s));
  if (paySeg) payment = paySeg.replace(/[.\s]+$/, '').slice(0, 160);
  return {
    name: parsed.name || stored.name || distilled.name || (business && business.name) || 'Musa Social Store',
    services: mergeArr(parsed.services, stored.services, distilled.services),
    prices: mergeArr(parsed.prices, stored.prices, distilled.prices),
    deals: mergeArr(parsed.deals, stored.deals, distilled.deals),
    location: parsed.location || stored.location || distilled.location || '',
    contact: parsed.contact || stored.contact || distilled.contact || '',
    payment,
    lines: parsed.lines,
  };
}

function fallbackReply(business, customerText) {
  const facts = fallbackFacts(business);
  const name = facts.name;
  const lang = detectLanguage(customerText);
  const intent = detectIntent(customerText);
  const lower = String(customerText || '').toLowerCase();
  const cleanJoin = (arr, n) => arr.slice(0, n).map((s) => s.replace(/[.\s]+$/, '')).join(', ');
  const priceLine = facts.prices.length ? cleanJoin(facts.prices, 3) : '';
  const dealLine = facts.deals.length ? cleanJoin(facts.deals, 2) : '';
  const locLine = facts.location || '';
  // What the business does / its delivery terms, in the owner's own
  // words — skipping meta lines ("You are the AI assistant...") that
  // are instructions to the bot, not facts for the customer.
  const serviceLine = cleanJoin(facts.services.filter((s) => !/\bdeliver/i.test(s)), 2);
  const deliverySeg = facts.lines.find((s) => /\bdeliver/i.test(s));
  const deliveryLine = deliverySeg ? deliverySeg.replace(/[.\s]+$/, '') : '';
  // Payment / account number: the customer wants to PAY — give them
  // the payment account straight away, never deflect.
  const paymentLine = facts.payment || (facts.contact ? `Payment: ${facts.contact}` : '');
  const isPayment = /\b(payment|pay|account ?no\.?|account ?number|bank|nayapay|jazzcash|easypaisa|paise|transfer)\b/i.test(lower) || /ادائیگی|اکاؤنٹ|بینک/.test(lower);
  // "I will confirm this detail" — in the customer's language. Used
  // only when the fact is genuinely not known yet.
  const confirmLine = lang === 'ur'
    ? 'اس کی تفصیل میں ابھی کنفرم کر کے بتاتا ہوں — آپ اپنا نام اور کام لکھ دیں۔'
    : lang === 'roman-ur'
      ? 'Is ki detail main abhi confirm kar ke batata hun — aap apna naam aur kaam likh dein, main aap ko jald jawab dunga.'
      : 'Got it — let me confirm that detail for you. Please send me your name and what you need, and I will get back to you shortly.';

  if (isPayment) {
    if (paymentLine) {
      if (lang === 'ur') return `السلام علیکم! ادائیگی کے لیے یہ اکاؤنٹ استعمال کریں: ${paymentLine}۔ آپ بتائیں آپ کو کیا چاہیے؟`;
      if (lang === 'roman-ur') return `Assalam-o-Alaikum! Payment ke liye ye account hai: ${paymentLine}. Aap bata dein aap ko kya chahiye?`;
      return `Hi! For payment, please use: ${paymentLine}. Tell me what you need and I'll sort it out for you.`;
    }
    return confirmLine;
  }

  if (lang === 'ur') {
    if (intent === 'price' && priceLine) return `السلام علیکم! ہمارے ریٹ یہ ہیں: ${priceLine}۔ آپ بتائیں آپ کو کون سی سروس چاہیے؟`;
    if (intent === 'deal' && dealLine) return `السلام علیکم! ہماری آج کی ڈیل یہ ہے: ${dealLine}۔ آپ کو کون سی ڈیل چاہیے؟ بتائیں، میں آپ کا آرڈر نوٹ کر لوں گا۔`;
    if (intent === 'location' && locLine) return `السلام علیکم! ہماری لوکیشن یہ ہے: ${locLine}۔ آپ کہاں سے آرڈر کرنا چاہتے ہیں؟`;
    if (intent === 'delivery' && deliveryLine) return `السلام علیکم! ${deliveryLine}۔ آپ اپنا آرڈر اور پتہ بتا دیں، میں نوٹ کر لوں گا۔`;
    if (intent === 'service' && serviceLine) return `السلام علیکم! ${serviceLine}۔ آپ کو ان میں سے کیا چاہیے؟ بتا دیں، میں تفصیل بھیج دوں گا۔`;
    if (intent === 'greeting') return pickVariant([
      `السلام علیکم! ${name} میں خوش آمدید۔ آپ کو کیا چاہیے — بتائیں، میں آپ کی مدد کر دوں گا۔`,
      'السلام علیکم! کیا حال ہے؟ آپ بتائیں آپ کو کس چیز کی ضرورت ہے؟',
      `السلام علیکم! ${name} سے بات کر رہے ہیں۔ آپ کو کیا چاہیے؟ بتائیں، میں آپ کو تفصیل بھیج دوں گا۔`,
    ], customerText);
    return confirmLine;
  }
  if (lang === 'roman-ur') {
    if (intent === 'price' && priceLine) return `Assalam-o-Alaikum! Hamare rates ye hain: ${priceLine}. Aap ko konsi service chahiye? Bata dein.`;
    if (intent === 'deal' && dealLine) return `Assalam-o-Alaikum! Aaj ki deal ye hai: ${dealLine}. Aap ko konsi deal chahiye? Bata dein, main aap ka order note kar lunga.`;
    if (intent === 'location' && locLine) return `Assalam-o-Alaikum! Hamari location ye hai: ${locLine}. Aap kahan se order karna chahte hain?`;
    if (intent === 'delivery' && deliveryLine) return `Assalam-o-Alaikum! ${deliveryLine}. Aap apna order aur address bata dein, main note kar lunga.`;
    if (intent === 'service' && serviceLine) return `Assalam-o-Alaikum! ${serviceLine}. Aap ko in mein se kya chahiye? Bata dein, main details bhej dunga.`;
    if (intent === 'language') return 'Ji zaroor, main Roman Urdu mein baat karunga. Aap bata dein aap ko kya chahiye?';
    if (intent === 'greeting') return pickVariant([
      `Assalam-o-Alaikum! ${name} mein khush amdeed. Aap ko kya chahiye? Bata dein, main madad kar dunga.`,
      `Assalam-o-Alaikum, kya haal hai? ${name} se baat kar rahe hain. Aap ko kis cheez ki zaroorat hai?`,
      `Salam! ${name} mein welcome. Bata dein, aap ko kya chahiye — main aap ko details bhej dunga.`,
    ], customerText);
    return confirmLine;
  }
  // English / other languages
  if (intent === 'price' && priceLine) return `Hi! Our rates are: ${priceLine}. Tell me which service you need and I'll send you the details.`;
  if (intent === 'deal' && dealLine) return `Hi! Today's deal is: ${dealLine}. Which one would you like? Tell me and I'll note your order down.`;
  if (intent === 'location' && locLine) return `Hi! We're located at: ${locLine}. Where would you like to order from?`;
  if (intent === 'delivery' && deliveryLine) return `Hi! ${deliveryLine}. Just send me your order and address and I'll note it down.`;
  if (intent === 'service' && serviceLine) return `Hi! ${serviceLine}. Which of these do you need? Tell me and I'll send you the details.`;
  if (intent === 'language') return `Of course — I'll reply in Urdu from now on. What do you need?`;
  if (intent === 'greeting') return pickVariant([
    `Hi there! Welcome to ${name}. What can I help you with today?`,
    `Hello! Good to hear from you. What do you need — tell me and I'll sort it out for you.`,
    `Hey! Thanks for messaging ${name}. What are you looking for?`,
  ], customerText);
  return confirmLine;
}

// --- Media understanding: what IS this file? ---
// The business uploads a file with a caption + useFor. classifyMedia
// reads those words (and the filename) and says what the file is:
//   logo      — business logo / identity (send on a first greeting)
//   offer     — offer / deal / discount banner (send when customer asks about offers/deals)
//   price     — price list / menu / rate plan (send when customer asks price/menu)
//   demo      — demo video / design sample (send when customer asks to see it)
//   intro     — intro / welcome voice or video (send on a first greeting)
//   general   — anything else (send only on a clear word match)
// The bot never sends media at random, never sends it on every message,
// and always sends a short written line WITH it, saying what it is.
function classifyMedia(m) {
  const hay = `${m && m.caption || ''} ${m && m.useFor || ''} ${m && m.ownerNote || ''} ${m && m.originalName || ''}`.toLowerCase();
  if (/\b(logo|brand)\b/.test(hay)) return 'logo';
  if (/\b(offer|deal|discount|special|promo|combo|sale|% off)\b/.test(hay)) return 'offer';
  if (/\b(banner)\b/.test(hay)) return /\b(offer|deal|discount|special)\b/.test(hay) ? 'offer' : 'banner';
  if (/\b(price|rate|menu|price list|rate list|plan|package|pricing)\b/.test(hay)) return 'price';
  if (/\b(demo|sample|design|portfolio|show|watch|preview)\b/.test(hay)) return 'demo';
  if (/\b(intro|introduction|welcome|about us|voice note|greeting)\b/.test(hay)) return 'intro';
  return 'general';
}

const MEDIA_TYPE_LABEL = {
  logo: { en: 'our logo', 'roman-ur': 'hamara logo', ur: 'ہمارا لوگو' },
  offer: { en: 'our offer banner', 'roman-ur': 'hamari offer ka banner', ur: 'ہماری آفر کا بینر' },
  banner: { en: 'our banner', 'roman-ur': 'hamara banner', ur: 'ہمارا بینر' },
  price: { en: 'our price list', 'roman-ur': 'hamari price list', ur: 'ہماری قیمتوں کی فہرست' },
  demo: { en: 'our demo', 'roman-ur': 'hamara demo', ur: 'ہمارا ڈیمو' },
  intro: { en: 'our intro', 'roman-ur': 'hamara intro', ur: 'ہمارا تعارف' },
  general: { en: 'this file', 'roman-ur': 'ye file', ur: 'یہ فائل' },
};

// Short human line sent WITH the media, in the customer's language,
// saying what the file is — so the customer never gets a bare photo.
function mediaIntroText(media, lang) {
  const type = classifyMedia(media);
  const label = (MEDIA_TYPE_LABEL[type] || MEDIA_TYPE_LABEL.general)[lang] || MEDIA_TYPE_LABEL[type].en;
  if (lang === 'ur') return `یہ دیکھیں — ${label} ہے۔ آپ کو یہ کیسا لگا؟`;
  if (lang === 'roman-ur') return `Ye dekh lein — ${label} hai. Aap ko kaisa laga? Bata dein, main aap ki madad kar dunga.`;
  return `Here you go — this is ${label}. Let me know what you think!`;
}

// --- Media matching (scored, never random, never always) ---
// The business writes, per file, a caption and a "useFor" note
// (e.g. useFor: "website price, price list"). The bot scores each
// file against the customer's message:
//   * exact useFor phrase in the message: +10
//   * each useFor word in the message: +3
//   * each caption word in the message: +2
//   * each filename word in the message: +1
//   * customer explicitly asks for photo/video/voice/demo: +5, and
//     the matching kind (image/video/audio) gets +3
//   * the file's TYPE fits what the customer asked about: +6
//     (deal question -> offer banner, price question -> price list,
//      greeting -> logo/intro, "show me" -> demo)
// Only the highest-scoring file is sent, and only if it scores >= 6.
// A message about something else scores ~0 and sends nothing.
const MEDIA_REQUEST_WORDS = {
  image: ['photo', 'pic', 'picture', 'image', 'photo', 'dekh', 'dikha', 'dikhao', 'show'],
  video: ['video', 'demo', 'dekh', 'dikha', 'dikhao', 'show', 'watch'],
  audio: ['voice', 'audio', 'sun', 'sunao', 'suno', 'listen', 'voice note'],
};
const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'is', 'are', 'kya', 'hai', 'hain', 'mujhe', 'aap', 'ap', 'mein', 'main', 'yeh', 'ye', 'woh', 'wo', 'kaisa', 'kaisi']);

function tokenize(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function pickMedia(media, customerText) {
  const items = media || [];
  if (!items.length) return null;
  const lower = String(customerText || '').toLowerCase();
  const msgTokens = new Set(tokenize(customerText));
  const intent = detectIntent(customerText);
  const INTENT_TYPE = { deal: ['offer', 'banner'], price: ['price'], greeting: ['logo', 'intro'], demo: ['demo'] };
  // NOTE: 'service'/'general' intents get NO type boost — a plain
  // service question ("kya aap courses dete hain?") must not trigger
  // the price list or any other media on its own.
  const wantedTypes = INTENT_TYPE[intent] || [];
  let best = null;
  let bestScore = 0;
  for (const m of items) {
    // Knowledge files are brain-only — never send one to a customer.
    // A missing purpose means an old upload: treat it as knowledge.
    if (m.purpose !== 'customer') continue;
    let score = 0;
    const useFor = String(m.useFor || '');
    const caption = String(m.caption || '');
    if (useFor && lower.includes(useFor.toLowerCase().trim())) score += 10;
    // The word "offer" only scores when the customer is actually
    // asking about offers — as a verb ("what services do you
    // offer?") it must not drag the offer banner into the chat.
    const offerWord = (w) => (w === 'offer' || w === 'offers') && intent !== 'deal';
    for (const w of tokenize(useFor)) if (msgTokens.has(w) && !offerWord(w)) score += 3;
    for (const w of tokenize(caption)) if (msgTokens.has(w) && !offerWord(w)) score += 2;
    for (const w of tokenize(m.originalName || '')) if (msgTokens.has(w) && !offerWord(w)) score += 1;
    // Type fit: this file IS what the customer is asking about.
    if (wantedTypes.includes(classifyMedia(m))) score += 6;
    // Explicit media request: boost, and prefer the kind asked for.
    const kinds = Object.keys(MEDIA_REQUEST_WORDS);
    for (const kind of kinds) {
      if (MEDIA_REQUEST_WORDS[kind].some((w) => lower.includes(w))) {
        score += 5;
        if (m.kind === kind) score += 3;
        break;
      }
    }
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return bestScore >= 6 ? best : null;
}

function buildSystemPrompt(business, media) {
  const parsed = parseBusinessPrompt((business && business.prompt) || '', business && business.name);
  const summary = promptSummary(parsed);
  // The brain IS the whole business control: the saved prompt may be
  // empty (wiped by a redeploy) while the brain still knows everything
  // the owner taught it — so the brain's distilled facts and memory
  // are part of the system prompt too, not just business.prompt.
  const brain = distillBrainSummary(business || {});
  const brainSummary = [
    brain.name ? `Business: ${brain.name}` : '',
    `Category: ${brain.category}`,
    brain.services.length ? `Services: ${brain.services.join(' | ')}` : '',
    brain.prices.length ? `Rate list: ${brain.prices.join(' | ')}` : '',
    brain.deals.length ? `Deals: ${brain.deals.join(' | ')}` : '',
    brain.location ? `Location: ${brain.location}` : '',
    brain.contact ? `Payment / contact: ${brain.contact}` : '',
  ].filter(Boolean).join('\n');
  const brainMem = (business.brainMemory || []).slice(-10)
    .map((m) => `${m.role === 'owner' ? 'Owner taught' : 'Brain understood'}: ${m.text}`).join('\n');
  const customerMedia = (media || []).filter((m) => m.purpose === 'customer');
  const knowledgeMedia = (media || []).filter((m) => m.purpose !== 'customer');
  const mediaList = customerMedia
    .map((m) => `- ${m.kind} (${classifyMedia(m)})${m.caption ? ' — owner private note (NEVER send these words to the customer, write your own short line): ' + m.caption : ''}${m.useFor ? ` (send when customer asks about: ${m.useFor})` : ''}${m.ownerNote ? ` [owner private note: ${m.ownerNote}]` : ''}${m.description ? ` [AI saw in this file: ${m.description.slice(0, 300)}]` : ''}`)
    .join('\n');
  const knowledgeList = knowledgeMedia
    .map((m) => `- ${m.kind} (${classifyMedia(m)})${m.description ? ` — what is in it: ${m.description.slice(0, 300)}` : ''}${m.ownerNote ? ` (owner note: ${m.ownerNote})` : ''}${m.caption ? ` (owner note: ${m.caption})` : ''}`)
    .join('\n');
  return [
    `You are a friendly HUMAN team member working for this business — talk like a real friendly person chatting on WhatsApp, NOT like a robot, a board, or a template. Be warm, natural, and short. Never say you are an AI, an assistant, a robot, or a bot — you are the business's own team member.`,
    `First, analyse the owner's WHOLE business knowledge below and understand it properly: the business name, what it does, its location, its rate list / prices, its deals and offers, and how the owner wants each type of customer dealt with. Then reply from THAT understanding — never invent a service, price, offer, location or delivery promise that is not in the facts.`,
    summary ? `What the owner's saved prompt says (your facts):\n${summary}` : 'No saved business prompt yet — use the brain facts below instead.',
    `What the brain knows about this business (from everything the owner taught it):\n${brainSummary}`,
    brainMem ? `What the owner taught the brain, most recent first:\n${brainMem}` : '',
    `The owner's full prompt, in their own words (it may be in Roman Urdu, Urdu, English, or mixed — read it all): ${business.prompt || '(no prompt set yet — use the brain facts above)'}`,
    'How to talk — like a friendly human:',
    '- 1 to 3 short sentences, warm and natural. Vary your wording every time — never start every reply with the same greeting, never send the same canned message twice in a row, never use stiff template lines like "Thank you for your message. Please tell me what you need."',
    '- Answer EVERY question the customer asks, from the business facts above. Never say "I can\'t", "I am not able to", or "I don\'t know how to do that" — if a detail is missing, say you will confirm it and ask the customer for their name and exactly what they need.',
    '- Use the customer\'s name if they gave it. Ask ONE helpful question (which deal, which type, where to deliver, when they need it) — then stop and wait for their answer.',
    '- ALWAYS reply in the exact language the customer used in their last message — any language in the world (English, Urdu, Roman Urdu, Arabic, Hindi, Spanish, French, German, Turkish, Chinese, and every other language). If the customer switches language, switch with them immediately. If they say "Urdu please", reply in Roman Urdu.',
    '- Use the services and prices from the facts above when the customer asks. If you do not know a price, date or payment number, say you will confirm it and ask for the customer\'s name and what exactly they need — never guess.',
    '- Prices: NEVER give a final or confirmed price. When the customer asks about price, give the STARTING price or range from the rate list above (for example "starts from Rs 1,500") and say the team will contact them to confirm the final price for their exact work. If no price is in the facts, say the team will tell them the price — never invent one.',
    '- If the customer gives their name / number / address / what they want, acknowledge it warmly. When the customer has fully confirmed what they want (they said yes / done / final / book it / banwa do), reply in this exact shape, in the customer\'s own language: "OK, aapki sari information maine note kar li hai, main apni team se baat karta hun — isi chat mein hamari team mein se koi aap se rabta kar lega."',
    '- Speak as the business, on the owner\'s behalf. Never claim to be an AI or a robot.',
    'Media — understand it, don\'t just attach it:',
    '- Each file below is labelled with what it IS (logo / offer banner / price list / demo / intro). Send one ONLY when it really fits what the customer is asking about — a deal question gets the offer banner, a price question gets the price list, a first greeting can get the logo, "show me" gets the demo. Always send a short written line WITH it, saying what it is ("Here is our deal banner — this is today\'s offer..."). Never send media on every message, never send it at random.',
    '- The owner\'s private notes (caption / useFor / owner note) are for YOUR understanding only — never send those words to the customer. When you send a file, write your own short human line about it.',
    '- You CANNOT attach a file by writing its name — NEVER write [image: ...], file names, or file paths in your reply (the customer would only see a useless file name, not the picture). Files are attached automatically by the system when one fits what the customer asked — just mention it in words and the system sends the real picture.',
    customerMedia.length ? `Media you MAY send to customers (only when one really fits what they ask):\n${mediaList}` : 'No customer media uploaded yet — send no files.',
    knowledgeList ? `Brain knowledge files — NEVER send these to any customer, they are only for your own knowledge. Answer FROM what is in them, in your own words:\n${knowledgeList}` : '',
    'WhatsApp policy — stay safe, or the number gets banned:',
    '- ONLY reply to a message the customer sent first. NEVER start a conversation yourself, NEVER send a message to someone who did not message you, NEVER mass-message, NEVER send unsolicited promos or offers to a list of numbers.',
    '- ONE short reply per incoming customer message (plus one media file only if it really fits). Do not send follow-up messages, do not chase, do not repeat yourself.',
    '- If a customer says stop / no / don\'t message me, reply politely once ("No problem, sorry about that") and NEVER message them again.',
    '- Keep every reply short and relevant to what that customer actually asked. No spam, no bulk, no broadcast.',
  ].join('\n');
}

// Returns { text, mediaId } — mediaId is set only when a media file
// clearly matches the customer's message (see pickMedia above).
// Uses ONE plain-text prompt on the PROVEN generateContent path (the
// same path brainChat uses — startChat/sendMessage is not used here
// at all). The conversation history is plain text inside the prompt,
// not a chat-session object, so there is only one Gemini call shape
// to keep working.
async function generateReply(business, customerText, history) {
  const media = (business && business.media) || [];
  const picked = pickMedia(media, customerText);
  const lang = detectLanguage(customerText);
  if (!isAiConfigured()) {
    // No Gemini key: answer from the business facts (see
    // fallbackReply) — never the same generic sentence, never a
    // refusal, never any mention of AI.
    let text = fallbackReply(business, customerText);
    if (picked) text += ' ' + mediaIntroText(picked, lang);
    return { text, mediaId: picked ? picked.id : null };
  }
  try {
    const convo = (history || []).slice(-8)
      .map((h) => `${h.role === 'customer' ? 'Customer' : 'Bot'}: ${h.text}`).join('\n');
    const promptText = [
      buildSystemPrompt(business, media),
      convo ? `Conversation so far:\n${convo}` : 'This is the start of the conversation.',
      `Customer just said: ${customerText}\nReply as the business:`,
    ].join('\n\n');
    const result = await generateContentResilient([{ text: promptText }]);
    let text = result.response.text().trim();
    if (!text) throw new Error('Gemini returned an empty reply');
    // If the AI picked media but its text never mentions it, add the
    // short human line about the file, so the customer is never sent
    // a bare photo/video with no explanation.
    if (picked && !/(photo|image|video|file|banner|logo|price list|deal|demo)/i.test(text)) {
      text += ' ' + mediaIntroText(picked, lang);
    }
    return { text, mediaId: picked ? picked.id : null };
  } catch (e) {
    // Gemini failed (bad key, quota, overload, network): answer from
    // the business facts instead — the customer must never see a
    // refusal or any mention of AI.
    console.error('Gemini reply failed, using honest fallback:', e && e.message);
    let text = fallbackReply(business, customerText);
    if (picked) text += ' ' + mediaIntroText(picked, lang);
    return { text, mediaId: picked ? picked.id : null };
  }
}

// --- Brain Chat: the owner teaches the brain in plain words ---
// The owner chats with the brain (Brain page) instead of filling a
// static prompt box. The brain keeps MEMORY: business.brainMemory
// (the whole owner/brain conversation, persisted) plus a distilled
// business.brainSummary (category, services, prices, location, rules).
// With a Gemini key the brain analyses the owner's words and confirms
// its understanding in plain words ("I understand — your business is
// X, if a customer says Y I will say Z…").
//
// FAST (2026-11-20, Brain improvements): the owner's chat must answer
// in SECONDS — the old path used the customer-reply resilience
// (45s x 3 attempts) and left the owner on "Analyzing…" for 70–96s
// under Gemini overload. brainChat now uses generateContentFast
// (~14s total budget, at most 1 retry). When Gemini is slow,
// overloaded, or missing, the brain confirms LOCALLY in seconds from
// the owner's own words — a REAL local analysis via the same
// deterministic parser the bot uses (parseBusinessPrompt /
// distillBrainSummary), never a faked Gemini analysis, and never
// "AI isn't connected". If the owner's message is confusing, the
// brain asks ONE short clarifying question instead of guessing.
function isAiConfigured() {
  const k = process.env.GEMINI_API_KEY;
  return !!(k && k !== 'YOUR_GEMINI_API_KEY_HERE');
}

// Is this owner message too unclear to confirm? True when it carries
// NO parseable facts (no name, service, price, deal, location or
// contact) AND is too short to understand — or is a question the brain
// cannot answer without knowing the business at all. Greetings are
// NOT confusing (they get a friendly "tell me about your business").
function isConfusingBrainMessage(ownerMessage, parsed) {
  const t = String(ownerMessage || '').trim();
  const hasFacts = !!(parsed.name || parsed.services.length || parsed.prices.length
    || parsed.deals.length || parsed.location || parsed.contact);
  if (hasFacts) return false;
  if (detectIntent(t) === 'greeting') return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 6) return true;
  if (/[?؟]\s*$/.test(t) || /^(kya|kaise|kab|kitna|kitne|kyun|why|what|how|when|where)\b/i.test(t)) return true;
  return false;
}

// Local confirmation in the owner's language, built ONLY from what
// the owner actually said (this message, parsed) plus what the brain
// already knows (for the one follow-up question). Never invents a
// service, price or offer.
function localBrainConfirmation(business, ownerMessage) {
  const lang = detectLanguage(ownerMessage);
  const parsed = parseBusinessPrompt(ownerMessage, business.name);
  const known = distillBrainSummary(business || {});
  const intent = detectIntent(ownerMessage);
  // ONE follow-up question about the most important missing fact.
  let missingQ = '';
  if (!known.services.length) {
    missingQ = lang === 'ur' ? 'آپ کیا بیچتے ہیں / کیا سروس دیتے ہیں؟'
      : lang === 'roman-ur' ? 'Aap kya bechte hain / kya service dete hain?'
      : 'What do you sell / what service do you offer?';
  } else if (!known.prices.length) {
    missingQ = lang === 'ur' ? 'آپ کے ریٹ / قیمتیں کیا ہیں؟'
      : lang === 'roman-ur' ? 'Aap ke rates / prices kya hain?'
      : 'What are your rates / prices?';
  } else if (!known.location) {
    missingQ = lang === 'ur' ? 'آپ کی لوکیشن کیا ہے؟'
      : lang === 'roman-ur' ? 'Aap ki location kya hai?'
      : 'What is your location?';
  }
  const ask = missingQ ? ' ' + missingQ : '';

  if (intent === 'greeting') {
    if (lang === 'ur') return `السلام علیکم! آپ اپنے بزنس کے بارے میں بتائیں — آپ کیا بیچتے ہیں، ریٹ کیا ہیں، لوکیشن کیا ہے؟ میں سیکھ لوں گا اور بتاؤں گا کہ میں نے کیا سمجھا۔`;
    if (lang === 'roman-ur') return `Salam! Aap apne business ke baare mein batayein — kya bechte hain, rates kya hain, location kya hai? Main seekh lunga aur confirm karunga ke maine kya samjha.`;
    return `Hi! Tell me about your business — what do you sell, what are your rates, where are you located? I will learn it and confirm what I understood.`;
  }
  if (isConfusingBrainMessage(ownerMessage, parsed)) {
    if (lang === 'ur') return `یہ تھوڑا سمجھ نہیں آیا — آپ تھوڑی تفصیل سے بتائیں: آپ کیا بیچتے ہیں، ریٹ کیا ہیں، لوکیشن کیا ہے؟`;
    if (lang === 'roman-ur') return `Ye thoda confusing lag raha hai — aap thoda detail mein batayein: aap kya bechte hain, rates kya hain, location kya hai?`;
    return `That is a bit unclear — can you tell me in a bit more detail: what do you sell, what are your rates, and where are you located?`;
  }
  const bits = [];
  const cleanBit = (s) => String(s).replace(/[.\s]+$/, '');
  if (parsed.name) bits.push(`Business: ${cleanBit(parsed.name)}`);
  if (parsed.services.length) bits.push(`Services: ${parsed.services.slice(0, 4).map(cleanBit).join(', ')}`);
  if (parsed.prices.length) bits.push(`Rates: ${parsed.prices.slice(0, 4).map(cleanBit).join(', ')}`);
  if (parsed.deals.length) bits.push(`Deals: ${parsed.deals.slice(0, 3).map(cleanBit).join(', ')}`);
  if (parsed.location) bits.push(`Location: ${cleanBit(parsed.location)}`);
  if (parsed.contact) bits.push(`Contact: ${cleanBit(parsed.contact)}`);
  const dealLine = lang === 'ur'
    ? 'میں ایسے ڈیل کروں گا: کسٹمر جو بھی پوچھے، میں انہی تفصیلات سے جواب دوں گا، اور جب کسٹمر کنفرم کرے گا تو میں آپ کو اس کی تفصیل بھیج دوں گا۔'
    : lang === 'roman-ur'
      ? 'Main aise deal karunga: customer jo bhi puche, main inhi details se jawab dunga, aur jab customer confirm kare to main aap ko us ki details bhej dunga.'
      : 'This is how I will deal with customers: whatever they ask, I will answer from these details, and when a customer confirms, I will send you their details.';
  if (bits.length) {
    const ready = lang === 'ur'
      ? 'بھائی ڈن، تیرا کام ہو جائے گا — میں تیرے لیے تیار ہوں۔'
      : lang === 'roman-ur'
        ? 'Bhai done, tera kaam ho jayega — main tere liye tayyar hun.'
        : 'Done, brother — your work will be handled, I am ready for you.';
    if (lang === 'ur') return `سمجھ گیا — ${bits.join('۔ ')}۔ ${dealLine}${ask} ${ready}`;
    if (lang === 'roman-ur') return `Han bhai, samajh aa gaya! ${bits.join('. ')}. ${dealLine}${ask} ${ready}`;
    return `Got it — I understand! ${bits.join('. ')}. ${dealLine}${ask} ${ready}`;
  }
  // No parseable facts in this message — echo the owner's own words
  // and remember them, instead of guessing.
  const echo = String(ownerMessage).length > 140 ? String(ownerMessage).slice(0, 140) + '…' : String(ownerMessage);
  const readyEcho = lang === 'ur'
    ? 'بھائی ڈن، تیرا کام ہو جائے گا — میں تیرے لیے تیار ہوں۔'
    : lang === 'roman-ur'
      ? 'Bhai done, tera kaam ho jayega — main tere liye tayyar hun.'
      : 'Done, brother — your work will be handled, I am ready for you.';
  if (lang === 'ur') return `سمجھ گیا — آپ نے یہ بتایا: "${echo}"۔ میں یہ یاد رکھوں گا۔${ask} ${readyEcho}`;
  if (lang === 'roman-ur') return `Samajh gaya — aap ne ye bataya: "${echo}". Main ye yaad rakhunga.${ask} ${readyEcho}`;
  return `Understood — you told me: "${echo}". I will remember that.${ask} ${readyEcho}`;
}

function brainSystemPrompt(business) {
  const parsed = parseBusinessPrompt((business && business.prompt) || '', business && business.name);
  const summary = promptSummary(parsed);
  const mem = (business.brainMemory || []).slice(-20)
    .map((m) => `${m.role === 'owner' ? 'Owner' : 'Brain'}: ${m.text}`).join('\n');
  const mediaList = (business.media || [])
    .map((m) => `- ${m.kind} (${classifyMedia(m)}): ${m.originalName}${m.caption ? ' — ' + m.caption : ''}${m.useFor ? ` (send when customer asks about: ${m.useFor})` : ''}${m.ownerNote ? ` [owner says this file is for: ${m.ownerNote}]` : ''}${m.description ? ` [AI saw: ${m.description.slice(0, 200)}]` : ''}`)
    .join('\n');
  return [
    'You are the BRAIN of a small business\'s WhatsApp assistant. The business owner is teaching you about their business by chatting with you. Your job: listen, understand, remember, and confirm your understanding in plain, simple words.',
    'When the owner tells you something new, reply with a short confirmation that shows you really understood it, in this shape:',
    'BEGIN your reply by confirming you fully understood the owner\'s whole system — e.g. "Samajh gaya — maine aapka system pura samajh liya hai, main aise deal karunga: ..." — and then explain, one by one, how you will deal with each kind of customer, exactly as you will do it in the real chats.',
    'END your confirmation with a warm, ready line like "bhai done, tera kaam ho jayega — main tere liye tayyar hun" (in the owner\'s language).',
    '- What kind of business it is (category).',
    '- What they sell / their services, their prices / rate list, their location — only what the owner actually told you, never invent anything.',
    '- "If a customer says X, I will say Y" — one or two examples of how you will deal with customers.',
    '- Ask ONE follow-up question if something important is still missing (e.g. prices, location, or how they want a certain customer dealt with).',
    'Keep it short and friendly, like a smart assistant talking to its owner — not a robot, not a long report. Reply in the SAME language the owner used (English, Roman Urdu, Urdu, or any other language).',
    summary ? `What the owner's saved prompt says (facts you already know):\n${summary}` : 'No saved business prompt yet.',
    mem ? `Your conversation with the owner so far (your memory):\n${mem}` : 'This is the start of your conversation with the owner.',
    mediaList ? `Media the owner uploaded (with what the AI saw in each file, if analysed):\n${mediaList}` : 'No media uploaded yet.',
    'Never claim you analysed something you did not, and never invent services, prices or offers.',
  ].join('\n');
}

// Distil the brain's understanding from the saved prompt + everything
// the owner has told the brain, using the same prompt parser the bot
// already uses — deterministic, no AI call needed.
function distillBrainSummary(business) {
  const ownerTexts = (business.brainMemory || [])
    .filter((m) => m.role === 'owner').map((m) => m.text).join('\n');
  const combined = [business.prompt || '', ownerTexts].filter(Boolean).join('\n');
  const parsed = parseBusinessPrompt(combined, business.name);
  const hay = combined.toLowerCase();
  let category = 'General business';
  if (/(website|web development|web design)/.test(hay)) category = 'Website development';
  else if (/(smm|social media|followers|accounts)/.test(hay)) category = 'Social media services';
  else if (/(food|restaurant|burger|pizza|kfc|chicken)/.test(hay)) category = 'Food / restaurant';
  else if (/(course|academy|teacher|tuition)/.test(hay)) category = 'Education / courses';
  else if (/(cloth|fashion|shoes|dress)/.test(hay)) category = 'Fashion / clothing';
  return {
    name: parsed.name || business.name || '',
    category,
    services: parsed.services.slice(0, 8),
    prices: parsed.prices.slice(0, 10),
    deals: parsed.deals.slice(0, 6),
    location: parsed.location || '',
    contact: parsed.contact || '',
  };
}

async function brainChat(business, ownerMessage) {
  if (!isAiConfigured()) {
    // No key: confirm locally in seconds — never make the owner wait
    // on "Analyzing…", never say "AI isn't connected".
    return { text: localBrainConfirmation(business, ownerMessage), aiConnected: false, local: true };
  }
  try {
    const result = await generateContentFast([
      { text: brainSystemPrompt(business) },
      { text: `Owner just said: ${ownerMessage}\n\nReply as the brain — confirm in plain words what you understood, say how you will deal with customers, and ask one follow-up question if something important is missing.` },
    ]);
    const text = result.response.text().trim();
    if (!text) throw new Error('Gemini returned an empty reply');
    return { text, aiConnected: true, local: false };
  } catch (e) {
    // Slow, overloaded, or bad key: confirm locally in seconds instead
    // of leaving the owner on "Analyzing…" for a minute. The error is
    // logged server-side only — the owner just gets the confirmation.
    console.error('Brain chat fast path failed, confirming locally:', e && e.message);
    return { text: localBrainConfirmation(business, ownerMessage), aiConnected: false, local: true, error: String((e && e.message) || e) };
  }
}

// --- Media description (Gemini vision) ---
// Describes a stored image so the brain knows what it is and when to
// send it. Returns { ok, description } or { ok:false, error } — never a
// fake description. Video is described from ONE extracted frame (the
// server does the extraction); audio cannot be described this way.
// ownerNote (2026-11-20, Brain improvements): the owner's own words
// about the file — "ye offer banner hai, deal puche to bhejna" —
// are analysed TOGETHER with the picture, so the description is
// grounded in what the owner meant, not just what the pixels show.
async function describeImage(buffer, mimeType, ownerNote) {
  if (!isAiConfigured()) {
    return { ok: false, error: 'AI is not connected yet — no Gemini API key is set, so this file cannot be analysed yet.' };
  }
  try {
    const note = String(ownerNote || '').trim();
    const prompt = note
      ? `The business owner uploaded this image and says about it: "${note.slice(0, 300)}". Analyse the picture TOGETHER with the owner's words: describe in detail, in plain words, what is shown, any text or prices visible, what kind of business image it is (logo, offer banner, price list, product photo, demo), and when a business should send it to a customer. Keep it to 3-5 short sentences.`
      : 'Describe this image in detail, in plain words: what is shown, any text or prices visible, what kind of business image it is (logo, offer banner, price list, product photo, demo), and when a business should send it to a customer. Keep it to 3-5 short sentences.';
    const result = await generateContentResilient([
      { text: prompt },
      { inlineData: { data: Buffer.from(buffer).toString('base64'), mimeType: mimeType || 'image/jpeg' } },
    ]);
    const text = result.response.text().trim();
    if (!text) throw new Error('Gemini returned an empty description');
    return { ok: true, description: text };
  } catch (e) {
    console.error('Describe image failed:', e && e.message);
    return { ok: false, error: 'Gemini could not analyse this image right now (' + String((e && e.message) || e).slice(0, 120) + '). Nothing was faked — try again later.' };
  }
}

// --- Customer image (Gemini vision, 2026-11-21, Zaib) ---
// A customer sends a picture (for example a design they like) instead
// of words. Describe what is shown so the bot can answer FROM it:
// what kind of design or business it is, any business name or text
// visible, and what the customer probably wants. Returns
// { ok, description } or { ok:false, error } — never a fake description.
async function describeCustomerImage(buffer, mimeType, caption) {
  if (!isAiConfigured()) {
    return { ok: false, error: 'AI is not connected yet — no Gemini API key is set.' };
  }
  try {
    const cap = String(caption || '').trim();
    const prompt = `A customer sent this image to a business on WhatsApp${cap ? ` and wrote with it: "${cap.slice(0, 300)}"` : ''}. Describe in detail, in plain words: what is shown, any text, business name or prices visible, what kind of design or business it looks like (for example a shop, a selling page, a website design, a product, a logo), and what the customer probably wants from the business. Keep it to 3-5 short sentences.`;
    const result = await generateContentResilient([
      { text: prompt },
      { inlineData: { data: Buffer.from(buffer).toString('base64'), mimeType: mimeType || 'image/jpeg' } },
    ]);
    const text = result.response.text().trim();
    if (!text) throw new Error('Gemini returned an empty description');
    return { ok: true, description: text };
  } catch (e) {
    console.error('Describe customer image failed:', e && e.message);
    return { ok: false, error: 'Gemini could not analyse this image right now (' + String((e && e.message) || e).slice(0, 120) + ').' };
  }
}

// --- Customer voice note (Gemini audio, 2026-11-21, Zaib) ---
// A customer sends a voice message instead of typing. Transcribe it
// so the bot can answer what was actually said. Returns
// { ok, text } or { ok:false, error } — never a fake transcription.
async function transcribeAudio(buffer, mimeType) {
  if (!isAiConfigured()) {
    return { ok: false, error: 'AI is not connected yet — no Gemini API key is set.' };
  }
  try {
    const result = await generateContentResilient([
      { text: 'Transcribe this voice message exactly, in the language spoken (it may be Roman Urdu, Urdu, English, or mixed). Return ONLY the transcription, no explanation, no extra words.' },
      { inlineData: { data: Buffer.from(buffer).toString('base64'), mimeType: mimeType || 'audio/ogg' } },
    ]);
    const text = result.response.text().trim();
    if (!text) throw new Error('Gemini returned an empty transcription');
    return { ok: true, text };
  } catch (e) {
    console.error('Transcribe audio failed:', e && e.message);
    return { ok: false, error: 'Gemini could not hear this voice message right now (' + String((e && e.message) || e).slice(0, 120) + ').' };
  }
}
// The fallback picks a variant from the customer's message, so the SAME
// message ("Website create karvani hai" twice) got the SAME reply twice.
// If the new reply equals the last one sent to that chat, append a
// varied closer in the customer's language, so no two consecutive
// replies are ever identical.
const VARIED_CLOSERS = {
  en: [
    'Tell me a bit more and I will sort it out for you.',
    'What else can I help you with?',
    'Just send me the details and I will take it from there.',
  ],
  'roman-ur': [
    'Aap aur bata dein, main aap ki madad kar dunga.',
    'Aur kya chahiye aap ko? Bata dein.',
    'Aap details bhej dein, main note kar lunga.',
  ],
  ur: [
    'آپ مزید بتائیں، میں آپ کی مدد کر دوں گا۔',
    'آپ کو اور کیا چاہیے؟ بتائیں۔',
    'آپ تفصیل بھیج دیں، میں نوٹ کر لوں گا۔',
  ],
};
let closerIndex = 0;
function varyIfRepeat(text, lastReply, lang) {
  if (!lastReply || text !== lastReply) return text;
  const list = VARIED_CLOSERS[lang] || VARIED_CLOSERS.en;
  const closer = list[closerIndex++ % list.length];
  return text + ' ' + closer;
}

// Defensive strip (2026-11-21, Zaib): the AI once wrote the file name
// "[image: file_00000000c2fc82118906104723582845.png]" into its reply
// text, and the customer only saw the useless name, not the picture.
// Files are attached by pickMedia + whatsapp.js, never by naming them
// in text — so any such placeholder or bare file name is removed from
// an outgoing reply before it is sent. Normal words are untouched.
function stripMediaRefs(text) {
  return String(text || '')
    .replace(/\[(?:image|file|photo|picture|video|audio|media)\s*:[^\]]*\]/gi, '')
    .replace(/(?:\d+-)?file_[A-Za-z0-9_.-]+\.(?:png|jpg|jpeg|webp|gif|mp4|mov|mp3|ogg|wav|pdf)\b/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')
    .trim();
}

module.exports = { generateReply, detectLanguage, detectIntent, pickMedia, fallbackReply, parseBusinessPrompt, classifyMedia, mediaIntroText, promptSummary, isAiConfigured, brainChat, distillBrainSummary, describeImage, describeCustomerImage, transcribeAudio, varyIfRepeat, generateContentFast, localBrainConfirmation, isConfusingBrainMessage, buildSystemPrompt, stripMediaRefs };
