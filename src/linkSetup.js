// Link auto-setup (2026-11-22, Zaib): a new user pastes their website /
// Facebook / Instagram link; the board reads it and fills the brain
// itself. MERGE, never wipe — the facts are APPENDED to the brain:
// a new memory entry, missing summary fields filled, and the facts
// appended to the saved prompt. Everything the owner taught before
// stays untouched. Brain Chat keeps working alongside it.
'use strict';

const ai = require('./ai');

const LINK_FETCH_TIMEOUT_MS = 15000;
const LINK_MAX_BYTES = 200 * 1024;
const LINK_TEXT_FOR_AI = 12000;

function isPrivateHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost') return true;
  if (h === '::1' || h === '[::1]') return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = +v4[1], b = +v4[2];
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // loopback
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 0) return true; // 0/8
    if (a === 169 && b === 254) return true; // link-local
  }
  return false;
}

function isAllowedLinkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (_) {
    return { ok: false, error: 'That does not look like a link — paste a full link starting with https://' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// and https:// links work' };
  }
  if (u.username || u.password) {
    return { ok: false, error: 'Links with a username or password in them are not allowed' };
  }
  if (isPrivateHostname(u.hostname)) {
    return { ok: false, error: 'That link points to a private address — paste a public website, Facebook or Instagram link' };
  }
  return { ok: true, url: u.toString() };
}

function stripHtmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(noscript|template|svg|head)[\s\S]*?<\/(noscript|template|svg|head)>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
  s = s.replace(/&#\d+;/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

// Fetch a page with a 15s timeout and a ~200KB cap. Throws an honest
// short error when the link cannot be read — never a crash.
async function fetchLinkText(url, fetchFn) {
  const doFetch = fetchFn || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LINK_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await doFetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'MusaWhatsAppBot/1.0 (+https://musa-cyan-nu.vercel.app/)',
        Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
      },
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new Error('link khul nahi saka — the link took too long to open, try again');
    throw new Error('link khul nahi saka — ' + String((e && e.message) || e).slice(0, 100));
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error('link khul nahi saka — the page answered ' + res.status);
  // The final URL after redirects must be public too.
  const finalCheck = isAllowedLinkUrl(String(res.url || url));
  if (!finalCheck.ok) throw new Error(finalCheck.error);
  const contentType = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
  if (contentType && !/text\/|html|json|xml/i.test(contentType)) {
    throw new Error('link khul nahi saka — that link is not a web page');
  }
  // Read with a hard cap — a huge page must not fill the memory.
  let text = '';
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (reader) {
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > LINK_MAX_BYTES) {
        try { await reader.cancel(); } catch (_) {}
        throw new Error('link khul nahi saka — that page is too big to read');
      }
    }
    text += decoder.decode();
  } else {
    text = await res.text();
    if (text.length > LINK_MAX_BYTES) throw new Error('link khul nahi saka — that page is too big to read');
  }
  const plain = stripHtmlToText(text);
  if (!plain) throw new Error('link khul nahi saka — the page had no readable text');
  return plain;
}

// Distill business facts from the page text: Gemini when a key is
// configured, the existing local parser otherwise. Never throws — any
// failure falls back to the local parse.
async function extractFactsFromText(text, businessName) {
  const local = ai.parseBusinessPrompt(text, businessName);
  const hay = String(text || '').toLowerCase();
  const facts = {
    name: local.name || '',
    category: 'General business',
    services: (local.services || []).slice(0, 8),
    prices: (local.prices || []).slice(0, 10),
    deals: (local.deals || []).slice(0, 6),
    location: local.location || '',
    contact: local.contact || '',
  };
  if (/(website|web development|web design)/.test(hay)) facts.category = 'Website development';
  else if (/(smm|social media|followers|accounts)/.test(hay)) facts.category = 'Social media services';
  else if (/(food|restaurant|burger|pizza|kfc|chicken)/.test(hay)) facts.category = 'Food / restaurant';
  else if (/(course|academy|teacher|tuition)/.test(hay)) facts.category = 'Education / courses';
  else if (/(cloth|fashion|shoes|dress)/.test(hay)) facts.category = 'Fashion / clothing';
  if (!ai.isAiConfigured()) return facts;
  try {
    const result = await ai.generateContentFast([
      { text: `Extract the business facts from this web page text as JSON only, no other words: {"name": "...", "category": "...", "services": ["..."], "prices": ["..."], "deals": ["..."], "location": "...", "contact": "..."}. Use the page's own words. Leave a field empty when the page does not say it. Page text:\n${String(text).slice(0, LINK_TEXT_FOR_AI)}` },
    ]);
    const raw = result.response.text().trim();
    const json = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim());
    const cleanArr = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
    const cleanStr = (v) => String(v || '').trim();
    return {
      name: cleanStr(json.name) || facts.name,
      category: cleanStr(json.category) || facts.category,
      services: cleanArr(json.services).length ? cleanArr(json.services).slice(0, 8) : facts.services,
      prices: cleanArr(json.prices).length ? cleanArr(json.prices).slice(0, 10) : facts.prices,
      deals: cleanArr(json.deals).length ? cleanArr(json.deals).slice(0, 6) : facts.deals,
      location: cleanStr(json.location) || facts.location,
      contact: cleanStr(json.contact) || facts.contact,
    };
  } catch (e) {
    console.error('Link setup: Gemini distill failed, using local parse:', (e && e.message) || e);
    return facts;
  }
}

function factsToText(facts) {
  const parts = [];
  if (facts.name) parts.push(`Business: ${facts.name}`);
  if (facts.category) parts.push(`Category: ${facts.category}`);
  if (facts.services && facts.services.length) parts.push(`Services: ${facts.services.join(' | ')}`);
  if (facts.prices && facts.prices.length) parts.push(`Rates: ${facts.prices.join(' | ')}`);
  if (facts.deals && facts.deals.length) parts.push(`Deals: ${facts.deals.join(' | ')}`);
  if (facts.location) parts.push(`Location: ${facts.location}`);
  if (facts.contact) parts.push(`Contact: ${facts.contact}`);
  return parts.join('\n');
}

// MERGE, never wipe: the facts are appended to the brain — a new
// memory entry, the distilled summary refreshed (it reads the prompt
// + owner memory), and the facts appended to the saved prompt.
// Everything the owner taught before stays exactly as it was.
function mergeLinkFacts(business, url, facts) {
  const factsText = factsToText(facts);
  business.brainMemory = business.brainMemory || [];
  business.brainMemory.push({
    role: 'brain',
    text: `Maine is link se ye seekha (${url}):\n${factsText || 'Is link se koi saaf business details nahi mili — aap khud batayein, main seekh lunga.'}`,
    at: new Date().toISOString(),
  });
  const block = `\n\n[From link: ${url}]\n${factsText}`;
  business.prompt = String(business.prompt || '').trim()
    ? String(business.prompt).trim() + block
    : `[From link: ${url}]\n${factsText}`;
  business.brainSummary = ai.distillBrainSummary(business);
  return facts;
}

async function setupFromLink(business, url, fetchFn) {
  const check = isAllowedLinkUrl(url);
  if (!check.ok) throw new Error(check.error);
  const text = await fetchLinkText(check.url, fetchFn);
  const facts = await extractFactsFromText(text, business.name);
  mergeLinkFacts(business, check.url, facts);
  return { facts, url: check.url };
}

module.exports = { isAllowedLinkUrl, isPrivateHostname, stripHtmlToText, fetchLinkText, extractFactsFromText, factsToText, mergeLinkFacts, setupFromLink };
