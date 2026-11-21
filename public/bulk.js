// Bulk Messages — 4-step wizard (UI v3).
// Uses the shared helpers from app.js: businessId(), api(), apiJson(),
// toast(), esc(). No login — Business ID only, like the other pages.
// CLIENT-SIDE number parser: a small duplicate of src/bulk.js, for the
// preview only — the server ALWAYS re-validates, so a tampered preview
// can never sneak a bad number into a campaign.
//
// HOW BULK WORKS NOW (Zaib, 2026-11-20): the BOT does everything.
// Start Campaign NEVER opens the owner's WhatsApp — a Send campaign is
// sent by the server, 8–15s apart, and a Draft campaign is just SAVED
// on the board (status draft). "Send all now" sends a draft from the
// server. "Make drafts" is the ONLY place WhatsApp opens: tap it and
// the chats open one after another, each with the message typed, NOT
// sent — pressing back leaves it as a WhatsApp draft ("Draft: …" in
// the chat list). The per-number "Open" link is manual only.
'use strict';

let bulkType = 'send';
let bulkParsed = null;
let bulkPollTimer = null;
let bulkStep = 1;

function normalizeNumberClient(raw) {
  let s = String(raw || '').trim().replace(/[\s\-().]/g, '');
  if (!s) return null;
  if (/^03\d{9}$/.test(s)) return '+92' + s.slice(1);
  if (/^\+92\d{10}$/.test(s)) return s;
  if (/^92\d{10}$/.test(s)) return '+' + s;
  return null;
}

function parseNumbersClient(rawText) {
  const tokens = String(rawText || '').split(/[,;\n]+/);
  const seen = new Set();
  const valid = [];
  const invalid = [];
  let duplicates = 0;
  for (const token of tokens) {
    const t = token.trim();
    if (!t) continue;
    const phone = normalizeNumberClient(t);
    if (!phone) { invalid.push(t); continue; }
    if (seen.has(phone)) { duplicates++; continue; }
    seen.add(phone);
    valid.push({ phone });
  }
  return { valid, duplicates, invalid };
}

function waLinkClient(phone, message) {
  const digits = String(phone || '').replace(/\D/g, '');
  return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(String(message || ''));
}

function setBulkType(t) {
  bulkType = t === 'draft' ? 'draft' : 'send';
  const s = document.getElementById('bulkTypeSend');
  const d = document.getElementById('bulkTypeDraft');
  if (s) s.classList.toggle('is-active', bulkType === 'send');
  if (d) d.classList.toggle('is-active', bulkType === 'draft');
  const help = document.getElementById('bulkTypeHelp');
  if (help) {
    help.textContent = bulkType === 'send'
      ? 'Send: the bot sends your message to each number, 8–15 seconds apart.'
      : 'Draft: nothing is sent. Open each chat on your phone — the message sits typed until you press send.';
  }
}

// --- Wizard navigation ------------------------------------------------------
// ONE fixed action bar (in bulk.html) holds Back / Next / Start Campaign
// for every step. It is flex: none at the bottom of the 100dvh shell,
// so it can never be pushed off screen — long step content scrolls
// inside the step instead. This bar is updated on every step change.
function updateWizardBar() {
  const back = document.getElementById('wizardBackBtn');
  const next = document.getElementById('wizardNextBtn');
  const start = document.getElementById('bulkStartBtn');
  if (back) back.style.display = bulkStep > 1 ? '' : 'none';
  if (next) next.style.display = bulkStep < 4 ? '' : 'none';
  if (start) start.style.display = bulkStep === 4 ? '' : 'none';
}

function bulkGoStep(n) {
  // Validate before moving forward.
  if (n > bulkStep) {
    if (bulkStep === 1) {
      const p = parseBulkNumbers();
      if (!p.valid.length) { toast('No valid numbers — enter numbers like +923106865269.'); return; }
      if (p.valid.length > 100) { toast('Too many numbers — max 100 per campaign.'); return; }
    }
    if (bulkStep === 2) {
      const msg = (document.getElementById('bulkMessage') || {}).value.trim();
      if (!msg) { toast('Write your message first.'); return; }
    }
  }
  bulkStep = n;
  document.querySelectorAll('.wizard-step').forEach((el) => el.classList.remove('active'));
  const step = document.getElementById('step' + n);
  if (step) step.classList.add('active');
  const prog = document.getElementById('wizardProgress');
  if (prog) prog.textContent = 'Step ' + n + ' of 4';
  updateWizardBar();
  if (n === 4) renderBulkReview();
}

function renderBulkReview() {
  const el = document.getElementById('bulkReview');
  if (!el) return;
  const p = bulkParsed || parseNumbersClient((document.getElementById('bulkNumbers') || {}).value || '');
  const msg = (document.getElementById('bulkMessage') || {}).value.trim();
  el.innerHTML = '<p><b>' + p.valid.length + ' numbers</b> · ' + (bulkType === 'draft' ? 'Draft' : 'Send') + '</p>'
    + '<p class="msg-preview">' + esc(msg) + '</p>';
}

function showView(which) {
  const w = document.getElementById('wizardView');
  const c = document.getElementById('campaignsView');
  const m = document.getElementById('makeDraftsView');
  if (w) w.style.display = which === 'wizard' ? '' : 'none';
  if (c) c.style.display = which === 'campaigns' ? '' : 'none';
  if (m) m.style.display = which === 'makedrafts' ? '' : 'none';
  // Leaving the Make-drafts view stops the auto-advance — a later
  // return to this tab must never open a chat out of nowhere.
  if (which !== 'makedrafts') makeDraftsDisarm();
  if (which === 'campaigns') loadBulkCampaigns();
}
function showBulkWizard() { showView('wizard'); }
function showBulkCampaigns() { showView('campaigns'); }

// --- Make drafts: AUTO-ADVANCE, one chat at a time, NO per-chat buttons
// What a WhatsApp draft is: the message typed in the chat, NOT sent —
// the chat list then shows "Draft: Hi". The server CANNOT type into the
// chat box on the owner's phone by itself — WhatsApp gives a linked
// device no draft function at all — so making a draft means opening
// that chat once on the phone. One tap on "Make drafts" runs the whole
// thing by itself, and ONLY here — never on Start Campaign (a draft
// Start just saves on the board). Tap "Make drafts" → chat 1 opens
// right away with the message typed, NOT sent → the owner presses
// back → the next chat opens by itself ~1s later → repeat until all
// chats are done, within seconds. There is NO per-chat view and NO
// per-chat button (2026-11-21, Zaib): the campaigns list stays
// visible, progress is a short toast, and the card's button becomes
// "Stop drafts" while it runs. To stop, tap "Stop drafts" or just
// don't press back — staying in WhatsApp ends the run.
// How it works: opening a chat is a top-level navigation
// (location.href), never a popup — it can never be blocked. When the
// owner presses back from WhatsApp, this page becomes visible again
// (visibilitychange / pageshow); if the page was actually away for a
// moment (not an instant bounce), the walkthrough waits ~1s and opens
// the NEXT chat. The ONLY setTimeout in this file is that 1s timer.
// The walkthrough state is ALSO saved to sessionStorage on every step
// (see makeDraftsSave): on Android, coming back from the WhatsApp app
// often makes Chrome RELOAD this tab instead of restoring it, and a
// reload used to wipe the walkthrough after chat 1. Now the reload
// resumes it (makeDraftsResumeAfterReload) — same tab, same campaign,
// next chat ~1s after the page comes back.
let makeDrafts = null; // { campaign, idx, armed, leftAt }
let makeDraftsAutoTimer = null;

function makeDraftsClearTimer() {
  if (makeDraftsAutoTimer) { clearTimeout(makeDraftsAutoTimer); makeDraftsAutoTimer = null; }
}
// --- Walkthrough state, saved so a reload cannot kill it -------------
// BUG (2026-11-21): the walkthrough lived ONLY in memory. On Android,
// coming back from the WhatsApp app often makes Chrome RELOAD this tab
// instead of restoring it — the script re-ran, makeDrafts was null, and
// the walkthrough died after chat 1, leaving every other draft sitting
// on the board. So every step is now saved to sessionStorage (same tab,
// survives a reload, dies with the tab). On load, an armed walkthrough
// resumes ONLY if it left less than 10 minutes ago AND this load is the
// page coming back (reload / back-forward) — a fresh visit to the Bulk
// page never opens a chat by itself.
const MAKE_DRAFTS_STORE_KEY = 'musaMakeDrafts.v1';
const MAKE_DRAFTS_RESUME_MAX_MS = 10 * 60 * 1000;
function makeDraftsSave() {
  try {
    if (!makeDrafts) { sessionStorage.removeItem(MAKE_DRAFTS_STORE_KEY); return; }
    sessionStorage.setItem(MAKE_DRAFTS_STORE_KEY, JSON.stringify({
      campaignId: makeDrafts.campaign && makeDrafts.campaign.id,
      idx: makeDrafts.idx,
      armed: makeDrafts.armed,
      leftAt: makeDrafts.leftAt || 0,
    }));
  } catch (e) { /* storage unavailable — walkthrough still works in memory */ }
}
function makeDraftsLoadStored() {
  try {
    const raw = sessionStorage.getItem(MAKE_DRAFTS_STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.campaignId || typeof s.idx !== 'number') return null;
    return s;
  } catch (e) { return null; }
}
function makeDraftsClearStored() {
  try { sessionStorage.removeItem(MAKE_DRAFTS_STORE_KEY); } catch (e) {}
}
function makeDraftsDisarm() {
  makeDraftsClearTimer();
  if (makeDrafts) makeDrafts.armed = false;
  makeDraftsClearStored();
}

async function startMakeDrafts(campaignId) {
  try {
    const d = await apiJson(api('/campaigns/' + encodeURIComponent(campaignId)));
    const campaign = d.campaign;
    if (!campaign || !(campaign.numbers || []).length) { toast('Campaign not found.'); return; }
    makeDrafts = { campaign, idx: 0, armed: false, leftAt: 0 };
    makeDraftsSave();
    renderMakeDrafts();
    // Open the FIRST chat right away — this runs on the "Make drafts" tap.
    // No per-chat view opens: the campaigns list stays visible and the
    // walkthrough runs by itself from here (see renderMakeDrafts).
    makeDraftsOpenCurrent();
  } catch (e) {
    toast('Could not open drafts: ' + e.message);
  }
}

function renderMakeDrafts() {
  if (!makeDrafts) return;
  const c = makeDrafts.campaign;
  const total = (c.numbers || []).length;
  const n = c.numbers[makeDrafts.idx] || {};
  const prog = document.getElementById('makeDraftsProgress');
  if (prog) prog.textContent = 'Chat ' + (makeDrafts.idx + 1) + ' of ' + total;
  const ph = document.getElementById('makeDraftsPhone');
  if (ph) ph.textContent = n.phone || '';
  const msg = document.getElementById('makeDraftsMsg');
  if (msg) msg.textContent = c.message || '';
  const open = document.getElementById('makeDraftsOpen');
  if (open) open.href = n.phone ? waLinkClient(n.phone, c.message) : '#';
  const next = document.getElementById('makeDraftsNext');
  if (next) next.textContent = makeDrafts.idx + 1 < total ? 'Next chat' : 'Done';
  const hint = document.getElementById('makeDraftsHint');
  if (hint) hint.textContent = makeDrafts.idx + 1 < total
    ? 'Chat opens with the message typed, not sent. Press back — the next chat opens by itself, and the typed text stays as a draft.'
    : 'Last chat — press back and you are done, all drafts are in WhatsApp.';
  // No per-chat view: progress is a short toast and the campaigns list
  // stays visible, with the card's button flipped to "Stop drafts".
  toast('Draft ' + (makeDrafts.idx + 1) + ' of ' + total + ' — back dabao, agla chat khud khulega.');
  loadBulkCampaigns();
}

function stopMakeDrafts() {
  // The owner stops the walkthrough from the campaign card — disarm it
  // so no chat opens on the next return to this tab.
  makeDraftsDisarm();
  makeDrafts = null;
  loadBulkCampaigns();
  toast('Drafts stopped.');
}

function makeDraftsCurrentLink() {
  if (!makeDrafts) return '';
  const c = makeDrafts.campaign;
  const n = (c.numbers || [])[makeDrafts.idx] || {};
  return n.phone ? waLinkClient(n.phone, c.message) : '';
}

function makeDraftsOpenCurrent() {
  const link = makeDraftsCurrentLink();
  if (!link) return false;
  // Arm the auto-advance BEFORE navigating away, so the return trip
  // (back from WhatsApp) is recognised as part of this walkthrough.
  // leftAt is stamped here too — the hidden event may not fire before
  // the page unloads, and the reload-resume needs it to tell a real
  // visit apart from an instant bounce.
  makeDrafts.armed = true;
  makeDrafts.leftAt = Date.now();
  makeDraftsSave();
  location.href = link;
  return true;
}

function makeDraftsScheduleNext() {
  makeDraftsClearTimer();
  makeDraftsAutoTimer = setTimeout(() => {
    makeDraftsAutoTimer = null;
    makeDraftsAdvance();
  }, 1000); // ~1s after the owner comes back, open the next chat
}

function makeDraftsAdvance() {
  if (!makeDrafts) return;
  makeDraftsClearTimer();
  const total = (makeDrafts.campaign.numbers || []).length;
  if (makeDrafts.idx + 1 < total) {
    makeDrafts.idx++;
    renderMakeDrafts();
    makeDraftsOpenCurrent();
  } else {
    makeDrafts = null;
    makeDraftsSave(); // clears the stored walkthrough — it is done
    toast('All drafts opened.');
    showBulkCampaigns();
  }
}

function makeDraftsNext() {
  // Manual fallback: the owner taps Next chat — advance AND open the
  // next chat right away, exactly like the auto-advance would.
  makeDraftsAdvance();
}

// The owner pressed back from WhatsApp: this page is visible again.
// Advance automatically — but only if we actually left for a moment
// (an instant bounce means the chat never opened, so don't skip it),
// and only while armed. There is no per-chat view any more (2026-11-21):
// the campaigns list stays visible and the walkthrough just runs.
function makeDraftsOnReturn() {
  if (!makeDrafts || !makeDrafts.armed) return;
  const awayMs = makeDrafts.leftAt ? Date.now() - makeDrafts.leftAt : 0;
  if (awayMs < 1200) return; // bounced back instantly — chat never opened
  makeDraftsScheduleNext();
}
function makeDraftsOnHidden() {
  if (makeDrafts) makeDrafts.leftAt = Date.now();
}
function makeDraftsOnVisible() {
  if (document.visibilityState === 'visible') makeDraftsOnReturn();
  else makeDraftsOnHidden();
}

// The page was RELOADED while the walkthrough was armed (Android
// Chrome often reloads the tab when coming back from the WhatsApp
// app, instead of restoring it). The in-memory walkthrough is gone,
// so rebuild it from the saved step and carry on with the next chat.
async function makeDraftsResumeAfterReload() {
  const stored = makeDraftsLoadStored();
  if (!stored || !stored.armed) return;
  const awayMs = stored.leftAt ? Date.now() - stored.leftAt : 0;
  if (awayMs < 1200 || awayMs > MAKE_DRAFTS_RESUME_MAX_MS) { makeDraftsClearStored(); return; }
  // Only resume when this load is the page coming back (reload or
  // back-forward). A fresh visit to the Bulk page must never open a
  // chat by itself.
  let navType = '';
  try {
    const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    navType = nav ? nav.type : '';
  } catch (e) {}
  // A return from the WhatsApp app on some phones reports this load as
  // a plain 'navigate' instead of reload/back-forward — allow that too,
  // but ONLY within 60 seconds of leaving, so a fresh visit minutes
  // later can never open a chat by itself.
  const freshReturn = awayMs < 60 * 1000;
  if (navType !== 'reload' && navType !== 'back_forward' && !freshReturn) return;
  try {
    const d = await apiJson(api('/campaigns/' + encodeURIComponent(stored.campaignId)));
    const campaign = d.campaign;
    if (!campaign || !(campaign.numbers || []).length) { makeDraftsClearStored(); return; }
    makeDrafts = { campaign, idx: Math.min(stored.idx, campaign.numbers.length - 1), armed: true, leftAt: stored.leftAt };
    renderMakeDrafts();
    // This reload IS the return from WhatsApp — open the next chat ~1s later.
    makeDraftsScheduleNext();
  } catch (e) { makeDraftsClearStored(); }
}

// --- Numbers / message preview ----------------------------------------------
function renderBulkPreview() {
  const el = document.getElementById('bulkPreview');
  if (!el) return;
  const p = bulkParsed;
  if (!p) { el.innerHTML = 'No numbers parsed yet.'; return; }
  const shown = p.valid.slice(0, 20).map((v) => `<li>${esc(v.phone)}</li>`).join('');
  const more = p.valid.length > 20 ? `<li>…and ${p.valid.length - 20} more</li>` : '';
  const bad = p.invalid.length ? `<p>Invalid (skipped): ${esc(p.invalid.join(', '))}</p>` : '';
  el.innerHTML = `<p><b>${p.valid.length} valid</b> · ${p.duplicates} duplicate${p.duplicates === 1 ? '' : 's'} · ${p.invalid.length} invalid</p>`
    + (p.valid.length ? `<ul>${shown}${more}</ul>` : '<p>No valid numbers — check the format, e.g. +923106865269.</p>')
    + bad;
}

function parseBulkNumbers() {
  const raw = (document.getElementById('bulkNumbers') || {}).value || '';
  bulkParsed = parseNumbersClient(raw);
  renderBulkPreview();
  return bulkParsed;
}

function updateBulkMsgPreview() {
  const msg = (document.getElementById('bulkMessage') || {}).value || '';
  const count = document.getElementById('bulkMsgCount');
  if (count) count.textContent = msg.length + ' characters';
  const prev = document.getElementById('bulkMsgPreview');
  if (prev) prev.textContent = msg.trim() || 'Your message will appear here.';
}

// --- Create + start -----------------------------------------------------------
async function startBulkCampaign() {
  const consent = document.getElementById('bulkConsent');
  if (!consent || !consent.checked) { toast('Please confirm you have permission to contact these recipients first.'); return; }
  const message = (document.getElementById('bulkMessage') || {}).value.trim();
  if (!message) { toast('Write your message first.'); return; }
  const raw = (document.getElementById('bulkNumbers') || {}).value || '';
  const parsed = parseNumbersClient(raw);
  bulkParsed = parsed;
  renderBulkPreview();
  if (!parsed.valid.length) { toast('No valid numbers — enter numbers like +923106865269.'); return; }
  if (parsed.valid.length > 100) { toast('Too many numbers — max 100 per campaign.'); return; }
  const btn = document.getElementById('bulkStartBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
  try {
    const d = await apiJson(api('/campaigns'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numbers: raw, message, type: bulkType }),
    });
    const campaign = d.campaign;
    const nums = document.getElementById('bulkNumbers');
    if (nums) nums.value = '';
    const msgEl = document.getElementById('bulkMessage');
    if (msgEl) msgEl.value = '';
    updateBulkMsgPreview();
    bulkParsed = null;
    renderBulkPreview();
    if (bulkType === 'draft') {
      // Drafts are saved on the board only — nothing is sent and the
      // owner's phone WhatsApp NEVER opens. The draft sits in My
      // campaigns, ready to send later with "Send all now" — the bot
      // then sends it from the server, 8–15s apart.
      toast(`Draft campaign saved — ${campaign.numbers.length} drafts ready.`);
      showBulkCampaigns();
    } else {
      // Send campaigns start now; the server paces sends 8–15s apart.
      try {
        await apiJson(api('/campaigns/' + encodeURIComponent(campaign.id) + '/start'), { method: 'POST' });
        toast(`Campaign started — sending to ${campaign.numbers.length} numbers, 8–15s apart.`);
      } catch (e) {
        toast('Campaign saved but could not start: ' + e.message);
      }
      showBulkCampaigns();
    }
  } catch (e) {
    toast('Campaign failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Start Campaign'; }
  }
}

// --- Campaign list ------------------------------------------------------------
function campaignStatusBadge(c) {
  const cls = c.status === 'done' ? 'linked' : c.status === 'running' || c.status === 'paused' ? 'waiting' : c.status === 'draft' ? 'new' : 'not-linked';
  return `<span class="badge ${cls}">${esc(String(c.status || '').toUpperCase())}</span>`;
}

function renderBulkCampaigns(list) {
  const el = document.getElementById('bulkCampaigns');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<p class="muted empty-note">No campaigns yet.</p>';
    return;
  }
  el.innerHTML = list.map((c) => {
    const total = (c.numbers || []).length;
    const rows = (c.numbers || []).map((n) => {
      const st = String(n.status || 'pending');
      const badgeCls = st === 'sent' ? 'linked' : st === 'failed' ? 'not-linked' : st === 'draft' ? 'new' : 'waiting';
      const open = c.type === 'draft'
        ? ` <a href="${esc(waLinkClient(n.phone, c.message))}" target="_blank" rel="noopener">Open</a> <button class="small secondary" onclick="sendBulkOne('${esc(c.id)}', '${esc(n.phone)}')">Send now</button>`
        : '';
      const err = n.error ? ` <span class="muted">${esc(n.error)}</span>` : '';
      return `<li>${esc(n.phone)} <span class="badge ${badgeCls}">${esc(st)}</span>${open}${err}</li>`;
    }).join('');
    return `<div class="lead">
      <p><b>${esc(c.type === 'draft' ? 'Draft' : 'Send')} campaign</b> ${campaignStatusBadge(c)}
      <span class="badge new">${esc(String(c.numbers.length))} numbers</span></p>
      <p>${esc((c.message || '').slice(0, 160))}${(c.message || '').length > 160 ? '…' : ''}</p>
      <p class="meta">Sent: ${c.sentCount || 0} · Failed: ${c.failedCount || 0} · Total: ${total} · ${esc(c.createdAt || '')}</p>
      <ul>${rows}</ul>
      ${c.status === 'running' ? `<button class="small danger" onclick="stopBulkCampaign('${esc(c.id)}')">Stop</button>` : c.status === 'paused' ? `<button class="small" onclick="startExistingBulkCampaign('${esc(c.id)}')">Continue</button>` : c.type === 'draft' ? `<button class="small" onclick="startExistingBulkCampaign('${esc(c.id)}')">Send all now</button>` : c.type === 'send' && c.status === 'ready' ? `<button class="small" onclick="startExistingBulkCampaign('${esc(c.id)}')">Start now</button>` : ''}
    </div>`;
  }).join('');
}

async function loadBulkCampaigns() {
  try {
    const d = await apiJson(api('/campaigns'));
    const list = d.campaigns || [];
    renderBulkCampaigns(list);
    // Keep polling while a campaign is running, so counts move live.
    const running = list.some((c) => c.status === 'running');
    if (running && !bulkPollTimer) {
      bulkPollTimer = setInterval(loadBulkCampaigns, 8000);
    } else if (!running && bulkPollTimer) {
      clearInterval(bulkPollTimer);
      bulkPollTimer = null;
    }
    // Hide the "Link WhatsApp" hint once the status badge says LINKED.
    const badge = document.getElementById('statusBadge');
    const hint = document.getElementById('linkHint');
    if (badge && hint) hint.style.display = badge.classList.contains('linked') ? 'none' : '';
  } catch (e) { /* Business ID not entered yet — list stays empty */ }
}

async function startExistingBulkCampaign(campaignId) {
  try {
    await apiJson(api('/campaigns/' + encodeURIComponent(campaignId) + '/start'), { method: 'POST' });
    toast('Campaign started — sending, 8–15s apart.');
    await loadBulkCampaigns();
  } catch (e) {
    toast('Could not start: ' + e.message);
  }
}

async function stopBulkCampaign(campaignId) {
  // Urgent stop: the server runner notices within ~1s and pauses.
  try {
    await apiJson(api('/campaigns/' + encodeURIComponent(campaignId) + '/stop'), { method: 'POST' });
    toast('Campaign stopped — tap Continue to resume it any time.');
    await loadBulkCampaigns();
  } catch (e) {
    toast('Could not stop: ' + e.message);
    await loadBulkCampaigns();
  }
}

async function sendBulkOne(campaignId, phone) {
  try {
    await apiJson(api('/campaigns/' + encodeURIComponent(campaignId) + '/send-one'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    toast('Sent to ' + phone + '.');
    await loadBulkCampaigns();
  } catch (e) {
    toast('Send failed: ' + e.message);
    await loadBulkCampaigns();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Shared wizard action bar: Back / Next live here (Start Campaign
  // keeps its own onclick in the HTML). Bar state follows the step.
  const backBtn = document.getElementById('wizardBackBtn');
  if (backBtn) backBtn.addEventListener('click', () => bulkGoStep(bulkStep - 1));
  const nextBtn = document.getElementById('wizardNextBtn');
  if (nextBtn) nextBtn.addEventListener('click', () => bulkGoStep(bulkStep + 1));
  updateWizardBar();
  const parseBtn = document.getElementById('bulkParseBtn');
  if (parseBtn) parseBtn.addEventListener('click', parseBulkNumbers);
  // Make-drafts auto-advance: when the owner presses back from
  // WhatsApp, this page becomes visible again and the next chat opens
  // by itself. Only armed while the walkthrough is running.
  document.addEventListener('visibilitychange', makeDraftsOnVisible);
  window.addEventListener('pageshow', () => makeDraftsOnReturn());
  // If the tab was reloaded mid-walkthrough (back from WhatsApp),
  // resume the walkthrough from the saved step.
  makeDraftsResumeAfterReload();
  const msg = document.getElementById('bulkMessage');
  if (msg) {
    msg.addEventListener('input', updateBulkMsgPreview);
    updateBulkMsgPreview();
  }
  const fileInput = document.getElementById('bulkFile');
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const ta = document.getElementById('bulkNumbers');
        if (ta) {
          ta.value = (ta.value ? ta.value.replace(/\s+$/, '') + '\n' : '') + String(reader.result || '');
          parseBulkNumbers();
          toast('Numbers loaded from ' + f.name + ' — review and press Parse & Preview.');
        }
      };
      reader.onerror = () => toast('Could not read ' + f.name + '.');
      reader.readAsText(f);
    });
  }
  loadBulkCampaigns();
});
