// Musa WhatsApp Bot Platform — dashboard logic (board design, separate pages).
// No login — only a Business ID, saved in this browser so it carries across
// the Home / Connect / Prompt / Media / Leads / Alerts pages. No dummy or
// sample data: every list starts empty and every field starts blank until
// the user adds real data. All buttons call a real API endpoint in server.js.
'use strict';

const $ = (id) => document.getElementById(id);
const has = (id) => !!$(id);
let statusTimer = null;
let countdownTimer = null;
let countdownEndsAt = 0;
let loadedOnce = false;

// --- Burger drawer (UI v3): one burger button opens a slide-in menu -----
function openDrawer() {
  const d = $('drawer'), o = $('drawerOverlay'), b = $('burgerBtn');
  if (!d || !o) return;
  d.classList.add('open'); o.classList.add('open');
  if (b) b.setAttribute('aria-expanded', 'true');
  document.body.style.overflow = 'hidden';
}
function closeDrawer() {
  const d = $('drawer'), o = $('drawerOverlay'), b = $('burgerBtn');
  if (!d || !o) return;
  d.classList.remove('open'); o.classList.remove('open');
  if (b) b.setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
}
function toggleDrawer() {
  const d = $('drawer');
  if (!d) return;
  if (d.classList.contains('open')) closeDrawer(); else openDrawer();
}

// --- Ripple (water-type tap effect) on buttons and links -------------------
function addRipple(e) {
  const t = e.target.closest('button, .page-link, .file-btn');
  if (!t || t.classList.contains('burger-btn') || t.classList.contains('drawer-close')) return;
  const rect = t.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 2.2;
  const span = document.createElement('span');
  span.className = 'ripple';
  span.style.width = span.style.height = size + 'px';
  span.style.left = (e.clientX - rect.left - size / 2) + 'px';
  span.style.top = (e.clientY - rect.top - size / 2) + 'px';
  t.appendChild(span);
  setTimeout(() => span.remove(), 600);
}

function businessId() {
  const el = $('businessId');
  const typed = el ? (el.value || '').trim() : '';
  // NO default (2026-11-21, Zaib): a new user on a new phone must get
  // an EMPTY board — their own Business ID, their own empty brain.
  // The old default ('musa-social-store') made every new visitor see
  // Zaib's business data. Returning '' here makes api() throw its
  // clear "enter your Business ID first" error instead of loading
  // someone else's data. Saved IDs still carry across pages via
  // localStorage (setBusinessId), so existing users are unaffected.
  return typed || (localStorage.getItem('musa-business-id') || '');
}
function setBusinessId(id) {
  const el = $('businessId');
  if (el) el.value = id || '';
  if (id) localStorage.setItem('musa-business-id', id);
}
function api(p) {
  const id = businessId();
  if (!id) throw new Error('Please enter your Business ID first (top of the page).');
  return '/api/business/' + encodeURIComponent(id) + p;
}
function toast(msg) {
  const t = $('toast');
  if (!t) { alert(msg); return; }
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = 'none'; }, 3200);
}
async function apiJson(url, opts) {
  const r = await fetch(url, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('Request failed: ' + r.status));
  return d;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Pairing code: REAL code from Baileys, 60-second countdown, live polling ---
function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  if (has('pairingCountdown')) $('pairingCountdown').textContent = '';
}
function startCountdown(seconds) {
  stopCountdown();
  countdownEndsAt = Date.now() + seconds * 1000;
  const tick = () => {
    if (!has('pairingCountdown')) { stopCountdown(); return; }
    const left = Math.max(0, Math.ceil((countdownEndsAt - Date.now()) / 1000));
    $('pairingCountdown').textContent = left > 0 ? `This code expires in ${left} seconds — enter it on your phone now.` : 'Code expired — get a new code.';
    if (left <= 0) { stopCountdown(); if (has('pairingCode')) $('pairingCode').textContent = '— — — —'; }
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

// --- Per-number pairing limit note (Connect card ONLY, never a global banner) ---
// Shown only when WhatsApp rate-limits THIS phone; cleared the moment the
// user types a different number, so another number can still link.
function showLimitNote(phone, msg) {
  if (!has('pairingLimitNote')) return;
  const n = $('pairingLimitNote');
  n.textContent = 'For number ' + phone + ': ' + msg + ' This limit is on this number only — a different number can still link.';
  n.dataset.phone = phone;
  n.hidden = false;
}
function hideLimitNote() {
  if (!has('pairingLimitNote')) return;
  $('pairingLimitNote').hidden = true;
  $('pairingLimitNote').dataset.phone = '';
}

async function getCode() {
  if (!has('phone')) return;
  const phone = $('phone').value.trim();
  if (!phone) { toast('Please enter your WhatsApp number first.'); return; }
  let id;
  try { id = businessId(); } catch (e) { toast(e.message); return; }
  const btn = $('pairBtn'); btn.disabled = true; btn.textContent = 'Getting code…';
  try {
    // Real endpoint: the server calls Baileys requestPairingCode() for THIS number.
    // If Baileys fails, the server returns a real error — no fake code is shown.
    // Use api() so an empty Business ID can never build "/api/business//..." (404).
    const d = await apiJson(api('/pairing-code'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
    if (!d.pairingCode) throw new Error('The server did not return a code — please try again.');
    // The code shows as 6 boxes, like the reference design.
    const codeEl = $('pairingCode');
    const code = String(d.pairingCode || '');
    codeEl.innerHTML = /^[0-9]{6}$/.test(code)
      ? code.split('').map((c) => `<span>${esc(c)}</span>`).join('')
      : esc(code);
    hideLimitNote();
    if (has('pairingHelp')) $('pairingHelp').textContent = d.instructions || '';
    startCountdown(d.expiresInSeconds || 60);
    toast('Pairing code received — enter it on your phone now.');
    refreshStatus();
  } catch (e) {
    if (/limit|429|temporarily|rate/i.test(e.message || '')) showLimitNote(phone, e.message);
    toast('Error: ' + e.message);
  }
  finally { btn.disabled = false; btn.textContent = 'Get pairing code'; }
}

async function refreshStatus() {
  let id;
  try { id = businessId(); } catch (e) { if (!loadedOnce) toast(e.message); return; }
  try {
    const d = await apiJson(api('/status'));
    const linked = d.linked === true;
    // A restoring socket is honestly "connecting", not "not linked" — the
    // server auto-reconnects it after a restart, which takes seconds.
    const connecting = !linked && (d.whatsappStatus === 'connecting' || d.whatsappStatus === 'disconnected');
    if (has('statusBadge')) {
      const badge = $('statusBadge');
      badge.textContent = linked ? '● LINKED' : (d.whatsappStatus === 'waiting-pairing' ? '● WAITING — enter the code' : (connecting ? '● CONNECTING…' : '● NOT LINKED'));
      badge.className = 'badge ' + (linked ? 'linked' : (d.whatsappStatus === 'waiting-pairing' || connecting ? 'waiting' : 'not-linked'));
    }
    if (has('statusDetail')) {
      $('statusDetail').textContent = linked
        ? `WhatsApp is linked${d.business.linkedAt ? ' — ' + new Date(d.business.linkedAt).toLocaleString() : ''}.`
        : 'WhatsApp is not linked yet.';
    }
    if (has('disconnectBtn')) $('disconnectBtn').style.display = linked ? '' : 'none';
    if (linked) stopCountdown();
    // --- Home stats + setup steps (only when those ids exist; every refresh) ---
    // Stats are live: leads count, media count, prompt Set / Not set. A setup
    // step gets class "done" (green check + strikethrough) once it is done.
    if (has('leadsCount') || has('mediaCount') || has('promptState') || has('setupStep1') || has('homeStatusTitle')) {
      const mediaLen = (d.business.media || []).length;
      const promptSet = !!(d.business.prompt && d.business.prompt.trim());
      if (has('mediaCount')) $('mediaCount').textContent = String(mediaLen);
      if (has('promptState')) $('promptState').textContent = promptSet ? 'Set' : 'Not set';
      if (has('setupStep1')) $('setupStep1').classList.toggle('done', linked);
      if (has('setupStep2')) $('setupStep2').classList.toggle('done', promptSet);
      if (has('setupStep3')) $('setupStep3').classList.toggle('done', mediaLen > 0);
      if (has('homeStatusTitle')) $('homeStatusTitle').textContent = linked ? 'WhatsApp is linked' : (d.whatsappStatus === 'waiting-pairing' ? 'Waiting — enter the code' : (connecting ? 'Connecting to WhatsApp…' : 'WhatsApp is not linked yet'));
      if (has('homeStatusText')) $('homeStatusText').textContent = linked ? 'Your bot is replying to customers automatically.' : 'WhatsApp is not linked yet.';
      if (has('welcomeStatus')) $('welcomeStatus').textContent = linked ? 'WhatsApp Status: Connected' : 'WhatsApp is not linked yet.';
      if (has('leadsCount')) {
        apiJson(api('/leads')).then((ld) => { if (has('leadsCount')) $('leadsCount').textContent = String((ld.leads || []).length); }).catch(() => {});
      }
    }
    // Fill the form from saved settings ONLY on first load — never overwrite
    // what the user is typing during auto-refresh.
    if (!loadedOnce) {
      loadedOnce = true;
      if (has('name') && d.business.name) $('name').value = d.business.name;
      if (has('phone') && d.business.phone) $('phone').value = d.business.phone;
      if (has('prompt') && d.business.prompt) { $('prompt').value = d.business.prompt; updatePromptCount(); if (has('savedPrompt')) { $('savedPrompt').textContent = d.business.prompt; $('savedPromptWrap').style.display = ''; } }
      if (has('leadEmail') && d.business.leadEmail) $('leadEmail').value = d.business.leadEmail;
      if (has('leadWhatsapp') && d.business.leadWhatsapp) $('leadWhatsapp').value = d.business.leadWhatsapp;
      if (has('mediaList') && d.business.media) renderMedia(d.business.media);
      if (has('leads')) loadLeads();
    }
  } catch (e) { if (!loadedOnce) toast('Status could not be loaded: ' + e.message); }
}

async function disconnect() {
  if (!confirm('Disconnect WhatsApp? The bot will stop replying to customers.')) return;
  try {
    await apiJson(api('/disconnect'), { method: 'POST' });
    stopCountdown(); if (has('pairingCode')) $('pairingCode').textContent = '— — — —';
    toast('WhatsApp disconnected.'); refreshStatus();
  } catch (e) { toast('Disconnect failed: ' + e.message); }
}

// --- Business Prompt / Plan ---
// Live character counter under the prompt textarea: "<N> / 8000 characters..."
function updatePromptCount() {
  if (!has('promptCount') || !has('prompt')) return;
  const len = $('prompt').value.length;
  $('promptCount').textContent = len + ' / 8000';
}
async function savePrompt() {
  try {
    const d = await apiJson(api('/settings'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: has('name') ? $('name').value : undefined, prompt: $('prompt').value }) });
    if (has('savedPrompt')) { $('savedPrompt').textContent = d.business.prompt || '(empty)'; $('savedPromptWrap').style.display = ''; }
    toast('Prompt saved.');
  } catch (e) { toast('Save failed: ' + e.message); }
}

// --- Media ---
// Kind filter (2026-11-21, Zaib — reference design Photo / Video / Voice).
let mediaFilter = 'all';
let lastMediaList = [];
function setMediaFilter(kind) {
  mediaFilter = kind;
  document.querySelectorAll('.seg-tabs button').forEach((b) => {
    b.classList.toggle('active', b.id === 'mediaFilter' + kind[0].toUpperCase() + kind.slice(1));
  });
  const f = $('mediaFile');
  if (f) f.accept = kind === 'all' ? 'image/*,video/*,audio/*' : kind + '/*';
  renderMedia(lastMediaList);
}
async function loadMedia() {
  if (!has('mediaList')) return;
  try {
    const d = await apiJson(api('/media'));
    lastMediaList = d.media || [];
    renderMedia(lastMediaList);
  } catch (e) { /* Business ID not entered yet — list stays empty */ }
}
function renderMedia(list) {
  const el = $('mediaList');
  if (!el) return;
  const shown = mediaFilter === 'all' ? list : list.filter((m) => m.kind === mediaFilter);
  if (!shown.length) { el.innerHTML = '<p class="muted empty-note">No media yet.</p>'; return; }
  el.innerHTML = shown.map((m) => {
    const preview = m.kind === 'image' ? `<img src="${esc(m.url)}" alt="">`
      : m.kind === 'video' ? `<video src="${esc(m.url)}" controls></video>`
      : `<audio src="${esc(m.url)}" controls></audio>`;
    return `<div class="media-item"><b>${esc(m.originalName)}</b> <span class="badge new">${esc(m.kind)}</span>
      <span class="badge ${m.purpose === 'customer' ? 'linked' : 'waiting'}">${m.purpose === 'customer' ? 'Customer file' : 'Brain knowledge'}</span>
      ${preview}
      ${m.caption ? `<p>Caption: ${esc(m.caption)}</p>` : ''}
      ${m.ownerNote ? `<p>For: ${esc(m.ownerNote)}</p>` : ''}
      <p class="muted">Send this when the customer asks about: <b>${esc(m.useFor || '—')}</b></p>
      ${m.description ? `<p class="muted">AI saw: ${esc(m.description)}</p>` : ''}
      <button class="small secondary" onclick="describeMedia('${esc(m.id)}')">Describe</button>
      ${m.purpose === 'customer'
        ? `<button class="small secondary" onclick="setMediaPurpose('${esc(m.id)}', 'knowledge')">Make knowledge-only</button>`
        : `<button class="small secondary" onclick="setMediaPurpose('${esc(m.id)}', 'customer')">Make customer file</button>`}
      <button class="small danger" onclick="deleteMedia('${esc(m.id)}')">Delete</button></div>`;
  }).join('');
}
// Ask the brain to analyse one uploaded file (Gemini vision). Without
// an AI key the server says so honestly — nothing is faked.
async function describeMedia(id) {
  toast('Analyzing this file…');
  try {
    const d = await apiJson(api('/media/' + encodeURIComponent(id) + '/describe'), { method: 'POST' });
    toast('Brain: ' + (d.description || '').slice(0, 120));
    loadMedia();
  } catch (e) { toast('Describe failed: ' + e.message); }
}
async function setMediaPurpose(id, purpose) {
  try {
    await apiJson(api('/media/' + encodeURIComponent(id) + '/purpose'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose }),
    });
    toast(purpose === 'customer' ? 'This file can now be sent to customers when it fits.' : 'This file is brain knowledge only now — it will never be sent to a customer.');
    loadMedia();
  } catch (e) { toast('Could not change purpose: ' + e.message); }
}
async function uploadMedia() {
  const f = $('mediaFile').files[0];
  if (!f) { toast('Please choose a file first.'); return; }
  const fd = new FormData(); fd.append('file', f);
  fd.append('caption', $('mediaCaption').value); fd.append('useFor', $('mediaUseFor').value);
  // "Kis ke liye hai" — the owner's own words about the file, stored
  // on the media item and used by describe + the brain's knowledge.
  fd.append('ownerNote', $('mediaOwnerNote').value);
  // Purpose: knowledge (default, brain-only) or customer (sendable).
  const purposeEl = $('mediaPurpose');
  fd.append('purpose', purposeEl && purposeEl.value === 'customer' ? 'customer' : 'knowledge');
  try {
    const d = await apiJson(api('/media'), { method: 'POST', body: fd });
    toast('Uploaded: ' + (d.media.originalName || ''));
    $('mediaFile').value = ''; $('mediaCaption').value = ''; $('mediaUseFor').value = ''; $('mediaOwnerNote').value = '';
    loadMedia();
  } catch (e) { toast('Upload failed: ' + e.message); }
}
async function deleteMedia(id) {
  try {
    await apiJson(api('/media/' + encodeURIComponent(id)), { method: 'DELETE' });
    toast('Media deleted.'); loadMedia();
  } catch (e) { toast('Delete failed: ' + e.message); }
}

// --- Lead Notification Settings (Alerts page) ---
async function saveNotify() {
  try {
    await apiJson(api('/settings'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leadEmail: $('leadEmail').value, leadWhatsapp: $('leadWhatsapp').value }) });
    toast('Notification settings saved.');
  } catch (e) { toast('Save failed: ' + e.message); }
}
// Add a lead manually — blank fields, real data only. No dummy defaults.
async function sendTestLead() {
  const customerName = $('testName').value.trim();
  const customerNumber = $('testNumber').value.trim();
  const wants = $('testWants').value.trim();
  if (!customerName || !customerNumber || !wants) { toast('For a lead, please enter a name, a number and what they want — all three.'); return; }
  const body = { customerName, customerNumber, address: $('testAddress').value.trim(), wants, source: 'dashboard-manual' };
  try {
    await apiJson(api('/leads'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    toast('Lead saved — see it on the Leads page.');
    $('testName').value = ''; $('testNumber').value = ''; $('testAddress').value = ''; $('testWants').value = '';
    loadLeads();
  } catch (e) { toast('Lead could not be created: ' + e.message); }
}

// --- Leads ---
async function loadLeads() {
  if (!has('leads')) return;
  try {
    const d = await apiJson(api('/leads'));
    const el = $('leads');
    const list = d.leads || [];
    if (has('leadsTotalCount')) $('leadsTotalCount').textContent = String(list.length);
    if (!list.length) { el.innerHTML = '<p class="muted empty-note">No leads yet.</p>'; return; }
    el.innerHTML = list.map((l) => {
      const log = (l.forwardLog || []).map((x) => `${x.channel}: ${x.ok ? 'sent' : x.skipped ? 'skipped — ' + (x.reason || '') : 'failed — ' + (x.error || '')}`).join(' | ');
      return `<div class="lead">
        <p><b>${esc(l.customerName || '(no name given)')}</b> — ${esc(l.customerNumber || '')}
        <span class="badge ${l.status === 'confirmed' ? 'confirmed' : 'new'}">${esc((l.status || 'new').toUpperCase())}</span></p>
        <p>Wants: ${esc(l.wants || '')}</p>
        ${l.email ? `<p>Email: ${esc(l.email)}</p>` : ''}
        <p>Address: ${esc(l.address || '(not given)')}</p>
        <p class="meta">${esc(l.createdAt || '')} · Email: ${l.forwardedEmail ? 'sent' : 'not sent'} · WhatsApp: ${l.forwardedWhatsapp ? 'sent' : 'not sent'}</p>
        ${log ? `<p class="meta">${esc(log)}</p>` : ''}
        ${l.status !== 'confirmed' ? `<button class="small" onclick="confirmLead('${esc(l.id)}')">Mark confirmed — send by email + WhatsApp</button>` : ''}
      </div>`;
    }).join('');
    filterLeadList();
  } catch (e) { /* Business ID not entered yet — list stays empty */ }
}
// Search box on the Leads page (2026-11-21, Zaib — reference design):
// filters the rendered cards by name, number, want or address.
function filterLeadList() {
  const q = (has('leadSearch') ? $('leadSearch').value : '').trim().toLowerCase();
  document.querySelectorAll('#leads .lead').forEach((el) => {
    el.style.display = !q || el.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}
async function confirmLead(id) {
  try {
    const d = await apiJson(api('/leads/' + encodeURIComponent(id) + '/confirm'), { method: 'POST' });
    const okE = d.email && d.email.ok, okW = d.whatsapp && d.whatsapp.ok;
    toast(okE && okW ? 'Lead confirmed — sent by email and WhatsApp.'
      : 'Lead confirmed, but something was not sent — see the reason under the lead.');
    loadLeads();
  } catch (e) { toast('Confirm failed: ' + e.message); }
}

function startAutoRefresh() {
  if (statusTimer) clearInterval(statusTimer);
  // Live status: every 15s, but only when a Business ID is entered.
  statusTimer = setInterval(() => { if (businessId()) refreshStatus(); }, 15000);
}

// New visitor, no Business ID yet: explain that the board is empty
// until they pick an ID, and offer to generate one. Each ID is its
// own private business — nothing is shared between IDs.
function showNewUserHint() {
  const row = document.querySelector('.biz-row');
  if (!row || document.getElementById('newUserHint')) return;
  const div = document.createElement('div');
  div.id = 'newUserHint';
  div.className = 'muted';
  div.style.margin = '8px 0';
  div.textContent = 'New here? This board is empty until you pick a Business ID — type any ID you like (e.g. my-shop-123) and tap Load, or create one: ';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'small secondary';
  btn.textContent = 'Create a new Business ID';
  btn.addEventListener('click', () => {
    const id = 'biz-' + Math.random().toString(36).slice(2, 10);
    setBusinessId(id);
    loadedOnce = false;
    refreshStatus();
    toast('Your Business ID is ' + id + ' — it is saved on this phone.');
  });
  div.appendChild(btn);
  row.after(div);
}

// --- Page init: Business ID carries across pages, no login ---
document.addEventListener('DOMContentLoaded', () => {
  // Brand mark (2026-11-22, Zaib): the Brain character next to the
  // brand name in the top bar, on every page — the reference design
  // has the character as the brand mark.
  const brand = document.querySelector('.brand-name');
  if (brand && !brand.querySelector('.brand-logo')) {
    const img = document.createElement('img');
    img.src = '/brain-character.png'; img.alt = ''; img.className = 'brand-logo';
    brand.prepend(img);
  }
  // Burger drawer wiring (UI v3) — closes on item tap, outside tap, or X.
  const burger = $('burgerBtn');
  if (burger) burger.addEventListener('click', toggleDrawer);
  const dClose = $('drawerClose');
  if (dClose) dClose.addEventListener('click', closeDrawer);
  const dOverlay = $('drawerOverlay');
  if (dOverlay) dOverlay.addEventListener('click', closeDrawer);
  document.querySelectorAll('.drawer-nav a').forEach((a) => a.addEventListener('click', closeDrawer));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  // Ripple on every tap.
  document.addEventListener('pointerdown', addRipple);
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('business');
  const saved = fromUrl || localStorage.getItem('musa-business-id') || '';
  setBusinessId(saved);
  if (!saved) showNewUserHint();
  const bid = $('businessId');
  if (bid) {
    bid.addEventListener('input', () => { const v = bid.value.trim(); if (v) localStorage.setItem('musa-business-id', v); });
    bid.addEventListener('change', () => { loadedOnce = false; refreshStatus(); });
  }
  // Typing a different phone clears that number's limit note instantly.
  const ph = $('phone');
  if (ph) ph.addEventListener('input', () => {
    const n = $('pairingLimitNote');
    if (n && !n.hidden && n.dataset.phone && ph.value.trim() !== n.dataset.phone) hideLimitNote();
  });
  // Prompt character counter: live on input, and once on page load.
  if (has('prompt')) {
    $('prompt').addEventListener('input', updatePromptCount);
    updatePromptCount();
  }
  if (businessId()) refreshStatus();
  if (has('mediaList')) loadMedia();
  if (has('leads')) loadLeads();
  startAutoRefresh();
});
