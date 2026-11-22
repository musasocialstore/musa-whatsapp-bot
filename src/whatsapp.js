// WhatsApp pairing-code linking with Baileys (@whiskeysockets/baileys).
// This is the WhatsApp Web style flow Zaib asked for: the business user
// generates a pairing code on the dashboard, enters it on their phone
// (WhatsApp > Linked Devices > Link a device > Link with phone number),
// and their own WhatsApp — NOT Zaib's number — links to the platform.
// NOTE: this is the unofficial WhatsApp Web protocol. It is the only way
// to do pairing-code linking; the official Meta Cloud API has no pairing
// code. WhatsApp can log such sessions out or ban numbers that spam, so
// the bot only replies to incoming customers, never mass-messages.
// Sessions are stored per business under data/auth/<businessId>/ .
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Some hosts (sandboxes, corporate networks) route all egress through an
// HTTP CONNECT proxy named by the standard *_proxy env vars. Baileys'
// WebSocket ignores those vars, so pass an explicit agent when one is set.
// On a normal host no proxy var exists and the socket connects directly.
const PROXY_URL = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY || '';
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;
const store = require('./store');
const ai = require('./ai');
const leads = require('./leads');

const sessions = new Map(); // businessId -> { sock, status, pairingCode }
const histories = new Map(); // businessId:customerJid -> [{role, text}]
const lastReplyByChat = new Map(); // businessId:customerJid -> last reply text sent
const reconnectTimers = new Map(); // businessId -> timeout handle
const reconnectAttempts = new Map(); // businessId -> consecutive attempts
// In-flight pairing attempts: businessId -> { phone, startedAt }.
// A second request while one is running is refused WITHOUT contacting
// WhatsApp — without this, a double-tap (or a board + direct call at the
// same time) starts two sockets and sends TWO registrations for one user
// action, which is exactly how a fresh number gets rate-limited on its
// very first try.
const pairingInFlight = new Map();

function clearReconnect(businessId) {
  const t = reconnectTimers.get(businessId);
  if (t) { clearTimeout(t); reconnectTimers.delete(businessId); }
}

// After a successful pair, WhatsApp closes the socket with 515
// (restartRequired) and expects the companion to reconnect with the now
// REGISTERED creds to finish logging in. The previous version never
// reconnected, so a code the phone accepted could never become a linked
// session. Reconnect whenever a registered identity's socket drops for a
// non-logout reason — FOREVER, with backoff (2026-11-22, Zaib: the
// socket died silently at ~16:10 PKT, sends failed 428 "Connection
// Closed" while the board still said linked, and the old hard cap of 5
// attempts meant the bot could stay dead forever with no retry at all).
function reconnectDelayMs(attempts) {
  // 2s, 4s, 8s, 16s, then 30s forever.
  return Math.min(30000, 2000 * Math.pow(2, Math.min(Math.max(attempts - 1, 0), 4)));
}

function scheduleReconnect(businessId) {
  // Never reconnect while a pairing attempt is in flight for this
  // business: the pairing socket is the only socket that may exist, and
  // a reconnect started from a stale close event would create a second
  // socket competing with it (second registration attempt).
  if (pairingInFlight.has(businessId)) return;
  if (reconnectTimers.has(businessId)) return;
  const attempts = (reconnectAttempts.get(businessId) || 0) + 1;
  reconnectAttempts.set(businessId, attempts);
  const delayMs = reconnectDelayMs(attempts);
  console.error(`WhatsApp socket down for ${businessId} — reconnecting in ${delayMs / 1000}s (attempt ${attempts})`);
  const timer = setTimeout(() => {
    reconnectTimers.delete(businessId);
    startSocket(businessId).catch((e) => console.error('reconnect failed', e));
  }, delayMs);
  reconnectTimers.set(businessId, timer);
}

// The socket died WITHOUT a connection.update 'close' event (2026-11-22:
// sends failed 428 while session.connected stayed true, so no close
// handler ever ran and no reconnect was ever scheduled). Mark it dead
// and start a FRESH reconnect cycle (attempts reset, so the first retry
// comes in 2s, not after a stale backoff).
function markSocketDead(businessId) {
  const session = sessions.get(businessId);
  if (session) {
    session.connected = false;
    sessions.set(businessId, session);
  }
  reconnectAttempts.delete(businessId);
  scheduleReconnect(businessId);
}

// Wait until the socket is live again (a reconnect's 'open'), or the
// timeout runs out. Used to retry a customer reply after a dead socket.
async function waitForLiveSocket(businessId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 25000);
  while (Date.now() < deadline) {
    if (isLiveLinked(businessId)) return true;
    await sleep(500);
  }
  return isLiveLinked(businessId);
}

// Silent-death watchdog (2026-11-22, Zaib): the ONLY thing that used
// to notice a dead socket was a connection.update 'close' event — and
// on 2026-11-22 the socket died without one ever firing, so the board
// kept saying linked while every reply failed. Every 20s, check every
// session that claims to be live: if its WebSocket is not open, the
// socket is dead — mark it and reconnect. One interval for the whole
// process; sessions that are gone (disconnected) are simply skipped.
let socketWatchdog = null;
function checkSocketLiveness() {
  for (const [businessId, session] of sessions) {
    if (!session || !session.sock || session.connected !== true) continue;
    let open = false;
    try { open = session.sock.ws && session.sock.ws.isOpen === true; } catch (_) { open = false; }
    if (!open) {
      console.error(`WhatsApp socket for ${businessId} is silently dead (ws not open while connected=true) — reconnecting`);
      markSocketDead(businessId);
    }
  }
}
function startSocketWatchdog() {
  if (socketWatchdog) return;
  socketWatchdog = setInterval(checkSocketLiveness, 20000);
  if (socketWatchdog.unref) socketWatchdog.unref();
}

function isRegistered(businessId) {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(authDir(businessId), 'creds.json'), 'utf8'));
    return creds.registered === true;
  } catch (_) { return false; }
}

// --- Pairing round 3 (2026-11-20): never show a code WhatsApp rejected ---
// Baileys' requestPairingCode() is fire-and-forget: it generates the code
// locally, sends the link_code_companion_reg registration IQ with a plain
// sendNode, and returns the code WITHOUT waiting for WhatsApp's answer
// (verified in the installed lib/Socket/socket.js). WhatsApp's answer
// arrives as a bare <iq> frame on the socket. With trace logging the live
// answers seen for this business's number were:
//   - type='result' WITH a link_code_pairing_ref  -> code registered, the
//     phone can link with it;
//   - type='error' code='400' (round 1, custom browser tuple) and
//     type='error' code='429' text='rate-overlimit' (round 3) -> the code
//     was NEVER registered, yet Baileys still returned it and the board
//     displayed it, so the phone answered "Couldn't link device".
// The 429 is WhatsApp's pairing rate limit: it builds up when codes are
// requested again and again in a short time (the user retried many times
// BECAUSE earlier codes were dead, and each retry — including test
// requests — made the limit worse). Two defences, both below:
//   1. VERDICT: watch the socket's raw frames (sock.ws emits 'frame' for
//      every decoded node — see Baileys' onMessageReceived) and only hand
//      the code to the board when WhatsApp's result IQ carrying a
//      link_code_pairing_ref has actually arrived. A rejection or an
//      unconfirmed code is torn down and reported honestly, never shown.
//   2. ATTEMPT GUARD: persisted on the business record — a 60-second
//      minimum gap between code requests (a new request cancels the
//      previous code anyway, so a faster retry can only burn attempts),
//      and after a 429 an escalating lockout (1h, 4h, 16h, max 24h)
//      during which the server refuses to contact WhatsApp at all, so
//      neither the board nor repeated taps can extend the limit.
function pairingVerdictFromFrame(frame) {
  if (!frame || frame.tag !== 'iq' || !Array.isArray(frame.content)) return null;
  const type = frame.attrs && frame.attrs.type;
  if (type === 'result') {
    for (const child of frame.content) {
      if (child && child.tag === 'link_code_companion_reg' && Array.isArray(child.content)) {
        if (child.content.some((c) => c && c.tag === 'link_code_pairing_ref')) {
          return { state: 'registered' };
        }
      }
    }
    return null;
  }
  if (type === 'error') {
    const errNode = frame.content.find((c) => c && c.tag === 'error');
    if (!errNode) return null;
    return {
      state: 'rejected',
      code: String((errNode.attrs && errNode.attrs.code) || ''),
      text: String((errNode.attrs && errNode.attrs.text) || ''),
    };
  }
  return null;
}

function watchPairingVerdict(sock, timeoutMs) {
  return new Promise((resolve) => {
    if (!sock.ws || typeof sock.ws.on !== 'function') {
      resolve({ state: 'unwatched' });
      return;
    }
    const timer = setTimeout(() => { cleanup(); resolve({ state: 'timeout' }); }, timeoutMs);
    const onFrame = (frame) => {
      const verdict = pairingVerdictFromFrame(frame);
      if (verdict) { cleanup(); resolve(verdict); }
    };
    const cleanup = () => {
      clearTimeout(timer);
      try { sock.ws.off('frame', onFrame); } catch (_) {}
    };
    sock.ws.on('frame', onFrame);
  });
}

// --- Pairing state is PER PHONE, not per business (round 4, 2026-11-20) ---
// The old code kept one pairingBlockedUntil / pairingRateLimitStrikes /
// lastPairingAttemptAt on the business record. That meant a rate limit
// earned by number A blocked a completely fresh number B on the same
// business, and switching numbers carried A's lockout with it — the exact
// "this problem on any number" Zaib reported. WhatsApp's limit is per
// phone number, so the guard must be too: business.pairingLimits[phone]
// = { blockedUntil, strikes, lastAttemptAt }. The old flat fields are
// kept in sync as a mirror of the CURRENT phone's state for backward
// compatibility with anything that read them.
function pairingState(business, phone) {
  business.pairingLimits = business.pairingLimits && typeof business.pairingLimits === 'object' ? business.pairingLimits : {};
  if (business.phone && !business.pairingLimits[business.phone]
    && (business.pairingBlockedUntil || business.lastPairingAttemptAt || business.pairingRateLimitStrikes)) {
    business.pairingLimits[business.phone] = {
      blockedUntil: business.pairingBlockedUntil || null,
      strikes: business.pairingRateLimitStrikes || 0,
      lastAttemptAt: business.lastPairingAttemptAt || null,
    };
  }
  if (!business.pairingLimits[phone]) {
    business.pairingLimits[phone] = { blockedUntil: null, strikes: 0, lastAttemptAt: null };
  }
  return business.pairingLimits[phone];
}

function syncLegacyPairingFields(business, phone) {
  const s = pairingState(business, phone);
  business.pairingBlockedUntil = s.blockedUntil;
  business.pairingRateLimitStrikes = s.strikes;
  business.lastPairingAttemptAt = s.lastAttemptAt;
}

function pairingBlockedError(business, phone) {
  const until = pairingState(business, phone).blockedUntil ? Date.parse(pairingState(business, phone).blockedUntil) : 0;
  if (!until || until <= Date.now()) return null;
  const mins = Math.ceil((until - Date.now()) / 60000);
  const wait = mins >= 120 ? `about ${Math.round(mins / 60)} more hours` : `about ${mins} more minutes`;
  const err = new Error(
    `WhatsApp has temporarily limited pairing for this number because too many codes were requested in a short time. ` +
    `No new code can work until the limit lifts — please wait ${wait} without requesting any code, then request ONE code and enter it on your phone within 60 seconds. ` +
    `Requesting codes again and again only makes WhatsApp extend the limit.`,
  );
  err.status = 429;
  err.code = 'PAIRING_RATE_LIMITED';
  return err;
}

function pairingGapError(business, phone) {
  const last = pairingState(business, phone).lastAttemptAt;
  if (!last) return null;
  const gapMs = Date.now() - Date.parse(last);
  if (!(gapMs >= 0) || gapMs >= 60000) return null;
  const waitS = Math.ceil((60000 - gapMs) / 1000);
  const err = new Error(
    `A pairing code was requested less than a minute ago. Asking again right away cancels the previous code and makes WhatsApp limit this number. ` +
    `Please wait ${waitS} seconds, then request one code and enter it within 60 seconds.`,
  );
  err.status = 429;
  err.code = 'PAIRING_TOO_SOON';
  return err;
}

async function startSocket(businessId) {
  const { state, saveCreds } = await useMultiFileAuthState(authDir(businessId));
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    // The companion identity MUST be a standard Baileys browser preset.
    // Verified live 2026-11-20 with trace logging: with the custom tuple
    // ['Musa Bot Platform', 'Chrome', '1.0'], WhatsApp's server answered
    // the link_code_companion_reg registration with
    // <error code='400' text='bad-request'/> — it never registered the
    // code, yet Baileys still returned one (its requestPairingCode uses a
    // fire-and-forget sendNode and never checks the result), so the board
    // showed codes the phone then rejected with "Couldn't link device"
    // (user-hit codes JB4Y-87S2 and GE87-8EZJ). With Browsers.ubuntu(
    // 'Chrome') the identical flow returns type='result' WITH a
    // link_code_pairing_ref — the code is genuinely registered.
    browser: Browsers.ubuntu('Chrome'),
    ...(proxyAgent ? { agent: proxyAgent } : {}),
  });
  sock.ev.on('creds.update', saveCreds);
  const prev = sessions.get(businessId);
  sessions.set(businessId, {
    sock,
    status: prev && prev.status === 'linked' ? 'linked' : 'connecting',
    // `connected` is the ONLY live truth: it is set ONLY by a real
    // connection 'open' event and cleared on every 'close'. session.status
    // alone cannot prove the socket is alive — after a dead socket it
    // keeps saying 'linked' until a reconnect replaces the session, and
    // business.linked survives server restarts entirely. See isLiveLinked.
    connected: false,
    pairingCode: prev ? prev.pairingCode : null,
    pairingExpiresAt: prev ? prev.pairingExpiresAt : null,
  });
  attachHandlers(businessId, sock);
  startSocketWatchdog();
  return sock;
}

function authDir(businessId) {
  return path.join(store.DATA_DIR, 'auth', businessId);
}

function getSession(businessId) {
  const s = sessions.get(businessId);
  if (!s) return { sock: null, status: 'not-linked', connected: false, pairingCode: null, pairingExpiresAt: null };
  // An expired code is a dead code: clear it so status can never report a
  // code the phone would reject for the wrong reason.
  if (s.status !== 'linked' && s.pairingExpiresAt && Date.parse(s.pairingExpiresAt) <= Date.now()) {
    s.pairingCode = null;
    s.pairingExpiresAt = null;
    if (s.status === 'waiting-pairing') s.status = 'not-linked';
  }
  return s;
}

async function requestPairingCode(businessId, phoneNumber) {
  // phoneNumber: digits only, e.g. 923106865269 — the BUSINESS's own number.
  // REAL code only: this calls Baileys sock.requestPairingCode(). If that
  // call fails, the error is thrown and the server shows NO code at all.
  const clean = String(phoneNumber || '').replace(/\D/g, '');
  if (!clean || clean.length < 10 || clean.length > 15) throw new Error('phone number must be 10-15 digits');
  const business = store.getBusiness(businessId);
  // Refuse ONLY on a LIVE link. The stored flag survives restarts and a
  // failed disconnect, so it can say "linked" while no session exists —
  // refusing on it made re-linking impossible (Zaib hit this 2026-11-21:
  // NOT LINKED on screen, yet "already linked" on every Get pairing
  // code tap, for a new number AND the old one). A stale flag is cleared
  // here and the code is generated normally. (isLiveLinked is a hoisted
  // function declaration, defined further down this file.)
  if (isLiveLinked(businessId)) {
    const err = new Error('WhatsApp is already linked for this business. Disconnect first to link a different number.');
    err.status = 409;
    throw err;
  }
  if (business.linked === true) {
    business.linked = false;
    business.linkedAt = null;
    store.saveBusiness(business);
  }
  // Attempt guard: refuse BEFORE contacting WhatsApp when THIS number is
  // inside a rate-limit lockout or a code was just requested for THIS
  // number. These refusals cost nothing with WhatsApp — that is their
  // point. A different number is NOT blocked by this number's lockout.
  const blockedErr = pairingBlockedError(business, clean);
  if (blockedErr) throw blockedErr;
  const gapErr = pairingGapError(business, clean);
  if (gapErr) throw gapErr;
  // In-flight guard: one pairing attempt at a time per business. A second
  // request (double-tap, board + direct call) while one is running is
  // refused without contacting WhatsApp — otherwise two sockets send two
  // registrations for one user action and a fresh number is rate-limited
  // on its first try. The guard is cleared in the finally below, on every
  // exit path, so it can never stick.
  if (pairingInFlight.has(businessId)) {
    const err = new Error('A pairing code is already being requested — please wait for it to appear instead of requesting another one. Requesting again cancels the code and makes WhatsApp limit this number.');
    err.status = 409;
    err.code = 'PAIRING_IN_PROGRESS';
    throw err;
  }
  pairingInFlight.set(businessId, { phone: clean, startedAt: Date.now() });
  try {
  // Switching numbers starts from a clean identity for THAT number:
  // the stored phone is replaced and the auth folder is wiped below, so
  // the new number never reuses the previous number's creds. The old
  // number's lockout stays recorded under the OLD number only.
  business.phone = clean;
  syncLegacyPairingFields(business, clean);
  store.saveBusiness(business);

  // End any stale socket from an earlier attempt so it cannot fight this
  // one. Its connection.update listeners are removed first so its close
  // event cannot schedule a reconnect or clear the new attempt's state.
  clearReconnect(businessId);
  reconnectAttempts.delete(businessId);
  const previous = sessions.get(businessId);
  if (previous && previous.sock) {
    try { previous.sock.ev.removeAllListeners('connection.update'); } catch (_) {}
    try { previous.sock.end(undefined); } catch (_) {}
  }
  sessions.delete(businessId);

  // Start EVERY pairing attempt from a clean identity. The business is
  // guaranteed not-linked here (checked above), so any stored auth state
  // is leftover from an earlier attempt and holds nothing worth keeping:
  // - an UNREGISTERED leftover makes WhatsApp kill every new connection
  //   with 428 "Connection Terminated" before any code is issued
  //   (verified live: fresh identity returns a code in ~1.2s, stale
  //   identity dies in <1s);
  // - a REGISTERED-but-not-linked leftover is worse: its pairing reached
  //   companion_finish on a phone, then the session was logged out
  //   (user-hit 2026-11-20: creds.json registered:true, me=923247353408,
  //   status logged-out). Reusing it makes WhatsApp answer the login
  //   with CB:failure 401, which Baileys surfaces as a Boom
  //   "Connection Failure" — the exact red error the board showed under
  //   the phone field — and no code can ever be issued from it again.
  // The previous version only wiped UNREGISTERED leftovers, which is
  // why the failure became permanent. Wipe unconditionally.
  try { fs.rmSync(authDir(businessId), { recursive: true, force: true }); } catch (_) {}

  const sock = await startSocket(businessId);

  // IMPORTANT: requestPairingCode must only be called once the socket has
  // signalled it is ready (first connection.update carrying a QR, or an
  // open connection). Called immediately, Baileys throws "Connection
  // Closed" because the WebSocket handshake has not finished — verified
  // live: immediate call failed in 0.5s, the same call after the QR event
  // returned a real code from WhatsApp in ~1.2s.
  const outcome = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('WhatsApp did not get ready in time — please try again.'));
      }
    }, 30000);
    const onUpdate = async (update) => {
      if (settled) return;
      if (update.qr || update.connection === 'open') {
        settled = true;
        clearTimeout(timer);
        sock.ev.off('connection.update', onUpdate);
        try {
          // Attach the verdict watcher BEFORE the registration IQ goes
          // out — WhatsApp's answer can arrive ~100ms after the send.
          const verdictPromise = watchPairingVerdict(sock, 8000);
          // Record the attempt BEFORE the registration is sent, so the
          // 60-second gap guard covers the whole in-flight window (the
          // old code only recorded it after the verdict, leaving the
          // window open for a duplicate request).
          pairingState(business, clean).lastAttemptAt = new Date().toISOString();
          syncLegacyPairingFields(business, clean);
          store.saveBusiness(business);
          const issued = await sock.requestPairingCode(clean);
          const verdict = await verdictPromise;
          resolve({ code: issued, verdict });
        } catch (e) {
          reject(e);
        }
      } else if (update.connection === 'close') {
        settled = true;
        clearTimeout(timer);
        sock.ev.off('connection.update', onUpdate);
        const err = update.lastDisconnect && update.lastDisconnect.error;
        const statusCode = err && err.output ? err.output.statusCode : undefined;
        if (statusCode === DisconnectReason.loggedOut) {
          reject(new Error('WhatsApp rejected the saved login session (logged out). The saved session has been cleared — tap "Get pairing code" again for a fresh code.'));
        } else {
          reject(new Error((err && err.message) || 'Connection closed'));
        }
      }
    };
    sock.ev.on('connection.update', onUpdate);
  });
  const { code, verdict } = outcome;
  if (!code) throw new Error('Baileys did not return a pairing code');

  // The attempt reached WhatsApp, whatever the verdict — the 60-second
  // gap was already recorded before the send above. A code is only ever
  // returned to the board when WhatsApp CONFIRMED the registration.
  if (verdict.state !== 'registered') {
    // Tear the attempt down completely — socket ended with its listeners
    // removed, session dropped, auth wiped — so no dead code or identity
    // survives for the board (or a later attempt) to trip over.
    clearReconnect(businessId);
    try { sock.ev.removeAllListeners('connection.update'); } catch (_) {}
    try { sock.end(undefined); } catch (_) {}
    sessions.delete(businessId);
    try { fs.rmSync(authDir(businessId), { recursive: true, force: true }); } catch (_) {}
    if (verdict.state === 'rejected' && (verdict.code === '429' || /rate|overlimit/i.test(verdict.text))) {
      // Lockout is recorded for THIS phone only — a different number is
      // unaffected and can still link first time.
      const state = pairingState(business, clean);
      state.strikes = (state.strikes || 0) + 1;
      const blockMinutes = Math.min(60 * Math.pow(4, state.strikes - 1), 24 * 60);
      state.blockedUntil = new Date(Date.now() + blockMinutes * 60000).toISOString();
      syncLegacyPairingFields(business, clean);
      store.saveBusiness(business);
      throw pairingBlockedError(business, clean);
    }
    syncLegacyPairingFields(business, clean);
    store.saveBusiness(business);
    if (verdict.state === 'rejected') {
      throw new Error(
        `WhatsApp rejected this pairing registration (error ${verdict.code || '?'}${verdict.text ? ` ${verdict.text}` : ''}), so the code was never registered and has NOT been shown. ` +
        `Wait a minute, then request one code and enter it within 60 seconds.`,
      );
    }
    throw new Error(
      'WhatsApp did not confirm this pairing code in time, so it has NOT been shown — an unconfirmed code is exactly what fails on the phone with "Couldn\'t link device". ' +
      'Wait a minute, then request one code and enter it within 60 seconds.',
    );
  }
  const state = pairingState(business, clean);
  state.strikes = 0;
  state.blockedUntil = null;
  syncLegacyPairingFields(business, clean);
  store.saveBusiness(business);
  // Baileys returns e.g. "ABCD-EFGH". Show it grouped as the user types it.
  // Pairing codes expire after ~60 seconds — the dashboard counts this down.
  sessions.set(businessId, { sock, status: 'waiting-pairing', pairingCode: code, pairingExpiresAt: new Date(Date.now() + 60000).toISOString() });
  return code;
  } finally {
    pairingInFlight.delete(businessId);
  }
}

function attachHandlers(businessId, sock) {
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    const session = getSession(businessId);
    if (connection === 'open') {
      console.log('WhatsApp connected for', businessId);
      reconnectAttempts.delete(businessId);
      session.status = 'linked';
      session.connected = true;
      session.pairingCode = null;
      session.pairingExpiresAt = null;
      const business = store.getBusiness(businessId);
      business.linked = true;
      business.linkedAt = new Date().toISOString();
      store.saveBusiness(business);
      sessions.set(businessId, session);
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.error('WhatsApp connection closed for', businessId, 'code', code);
      // The socket is dead from here on, whatever the stored status was.
      session.connected = false;
      if (code === DisconnectReason.loggedOut) {
        // Logged out: this identity is dead. Clear the session AND wipe
        // the stored auth state so the next pairing attempt starts clean
        // instead of failing forever with "Connection Failure" (401).
        session.status = 'logged-out';
        session.pairingCode = null;
        session.pairingExpiresAt = null;
        sessions.set(businessId, session);
        const business = store.getBusiness(businessId);
        if (business.linked) {
          business.linked = false;
          business.linkedAt = null;
          store.saveBusiness(business);
        }
        reconnectAttempts.delete(businessId);
        try { fs.rmSync(authDir(businessId), { recursive: true, force: true }); } catch (_) {}
        return;
      }
      session.status = session.status === 'linked' ? 'linked' : 'disconnected';
      // A pairing code dies with its socket: if the connection dropped
      // before linking completed, clear the stored code so the board can
      // never keep displaying a code WhatsApp no longer accepts.
      if (session.status !== 'linked') {
        session.pairingCode = null;
        session.pairingExpiresAt = null;
      }
      sessions.set(businessId, session);
      // WhatsApp closes the socket right after a successful pair (515
      // restartRequired) and expects a reconnect with the registered
      // creds to finish logging in; transient drops of a linked session
      // need the same treatment. Only a REGISTERED identity can log in
      // again — an unregistered one has nothing to reconnect with.
      if (isRegistered(businessId)) scheduleReconnect(businessId);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try { await handleIncoming(businessId, sock, msg); } catch (e) { console.error('handleIncoming failed', e); }
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Human-like reply delay (2026-11-20, Brain Chat upgrade) ---
// The bot must NEVER reply instantly like a copy-paste machine —
// WhatsApp flags instant bot replies and can ban the number. A human
// reads the message, thinks, types. So before ANY customer reply:
// show "typing…" (composing presence), wait a human-like 3–8 seconds
// (a bit longer for a longer reply, capped at ~10s), send, then stop
// typing. Applies to text and media replies, 1-to-1 chats only
// (handleIncoming already returns early for groups / broadcasts).
function humanDelayMs(replyText) {
  const base = 3000 + Math.random() * 5000; // 3–8 seconds
  const extra = Math.min(2000, Math.floor(String(replyText || '').length / 100) * 1000);
  return Math.min(10000, Math.round(base + extra));
}

async function sendHumanLike(sock, jid, replyText, sendFn) {
  const delay = humanDelayMs(replyText);
  try { await sock.sendPresenceUpdate('composing', jid); } catch (_) {}
  await sleep(delay);
  try {
    await sendFn();
  } finally {
    try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {}
  }
  return delay;
}

// --- Confirmed orders: the customer said yes / done / final ---
// The bot then confirms in the team's words (never "I am an
// assistant") and the WHOLE conversation is forwarded to the owner
// as the lead, so nothing is lost: number + what they want + name +
// address + agreed price.
//
// CONFIRM FIX (2026-11-20, Brain improvements): a real confirmation
// once failed to capture a lead at all, because the regex only knew a
// few words ("done", "final", "theek hai"). Customers also confirm
// with "ji", "ok", "zaroor", "bilkul", "kar dein", "book it" — and a
// bare "ok / ji / haan" counts as a confirmation when the chat already
// discussed an order (a price or a want was mentioned). A cold "ok" as
// the very first message is still NOT a confirmation.
const CONFIRMED_RE = /(done|confirm|final|theek hai|banwa do|karwa do|karwa dein|book kar|haan|yes,? (do|book|confirm)|ok done|ji haan|zaroor|bilkul|kar dein|kar de|final kar|order kar|book it|place order|confirm kar|theek hai,? (kar|book|final))/i;
const TEAM_LINE_RE = /team se baat|team will contact|note kar li/i;
const SHORT_AFFIRM_RE = /^(ok|okay|ji|haan|han|yes|sure|theek|done|zaroor|bilkul|kar do|kar dein|book|confirm|final)\b/i;
const TEAM_LINES = {
  'roman-ur': 'OK, aapki sari information maine note kar li hai, main apni team se baat karta hun — isi chat mein hamari team mein se koi aap se rabta kar lega.',
  ur: 'ٹھیک ہے، آپ کی ساری معلومات میں نے نوٹ کر لی ہیں، میں اپنی ٹیم سے بات کرتا ہوں — اسی چیٹ میں ہماری ٹیم میں سے کوئی آپ سے رابطہ کر لے گا۔',
  en: 'OK, I have noted down all your information. I will talk to my team — someone from our team will contact you in this same chat.',
};
function teamLineFor(lang) { return TEAM_LINES[lang] || TEAM_LINES.en; }
function isConfirmedOrder(customerText, replyText, history) {
  // ONLY the customer's own words count as a confirmation. The bot's
  // reply is never evidence — the old code also fired when the reply
  // contained the team line, and the bot says team-ish things in
  // greetings too, so one customer got 7 lead alerts in a day
  // (2026-11-21, Zaib).
  if (CONFIRMED_RE.test(String(customerText || ''))) return true;
  const t = String(customerText || '').trim();
  if (SHORT_AFFIRM_RE.test(t) && t.split(/\s+/).length <= 3) {
    const h = (history || []).map((x) => x.text).join('\n');
    const customerCount = (history || []).filter((x) => x.role === 'customer').length;
    if (h && (/(rs\.?|pkr|₨|price|rate|total|order|book|chahiye|deal)/i.test(h) || customerCount >= 2)) return true;
  }
  return false;
}
// Agreed price: delegated to leads.findAgreedPrice (generic — any
// money amount tied to total/final/price, not a hardcoded list).
function findAgreedPrice(historyText) {
  return leads.findAgreedPrice(historyText);
}

// --- Customer media understanding (2026-11-21, Zaib) ---
// A customer may send a picture or a voice note instead of words.
// Download it, understand it with Gemini, and return the text the
// bot should answer to. Never throws — on any failure it returns a
// short instruction for the AI to ask the customer for details, so
// the customer always gets a human reply, never silence.
async function understandCustomerMedia(msg) {
  const m = msg.message || {};
  const imageMsg = m.imageMessage;
  const videoMsg = m.videoMessage;
  const audioMsg = m.audioMessage;
  try {
    if (imageMsg) {
      const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
      const seen = await ai.describeCustomerImage(buf, imageMsg.mimetype, imageMsg.caption);
      if (seen.ok) {
        return `[Customer sent a photo. What the brain saw in it: ${seen.description}]${imageMsg.caption ? ` Customer wrote with it: "${imageMsg.caption}"` : ''}`;
      }
      return imageMsg.caption
        ? imageMsg.caption
        : '[Customer sent a photo, but the brain could not see it — ask warmly what the photo shows and what they need.]';
    }
    if (videoMsg) {
      const frame = await extractVideoFrameFromMessage(msg);
      if (frame) {
        const seen = await ai.describeCustomerImage(frame, 'image/jpeg', videoMsg.caption);
        if (seen.ok) {
          return `[Customer sent a video. What the brain saw in it: ${seen.description}]${videoMsg.caption ? ` Customer wrote with it: "${videoMsg.caption}"` : ''}`;
        }
      }
      return videoMsg.caption
        ? videoMsg.caption
        : '[Customer sent a video, but the brain could not see it — ask warmly what the video shows and what they need.]';
    }
    if (audioMsg) {
      const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
      const heard = await ai.transcribeAudio(buf, audioMsg.mimetype);
      if (heard.ok && heard.text) return heard.text;
      return '[Customer sent a voice message that could not be heard — politely ask them to type it.]';
    }
  } catch (e) {
    console.error('understandCustomerMedia failed:', e && e.message);
  }
  return null;
}

// One frame from a customer video: download to a temp file, ffmpeg
// extracts the frame at 1s, temp files are removed. Returns a Buffer
// or null (ffmpeg missing/unavailable on the host is an honest null,
// never a fake frame).
async function extractVideoFrameFromMessage(msg) {
  let tmpVideo = null;
  let tmpFrame = null;
  try {
    const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
    tmpVideo = path.join(os.tmpdir(), 'musa-in-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.mp4');
    tmpFrame = path.join(os.tmpdir(), 'musa-frame-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.jpg');
    fs.writeFileSync(tmpVideo, buf);
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', ['-y', '-v', 'error', '-i', tmpVideo, '-ss', '1', '-frames:v', '1', '-q:v', '3', tmpFrame], { timeout: 30000 }, (err) => (err ? reject(err) : resolve()));
    });
    return fs.readFileSync(tmpFrame);
  } catch (e) {
    return null;
  } finally {
    try { if (tmpVideo) fs.unlinkSync(tmpVideo); } catch (_) {}
    try { if (tmpFrame) fs.unlinkSync(tmpFrame); } catch (_) {}
  }
}

async function handleIncoming(businessId, sock, msg) {
  if (!msg.message || msg.key.fromMe) return;
  const business = store.getBusiness(businessId);
  if (!business.linked) return;
  const fromJid = msg.key.remoteJid;
  if (!fromJid || fromJid.endsWith('@g.us')) return; // DMs only, never group messages
  // The customer's WhatsApp name + whether the chat is LID-addressed
  // (2026-11-21, Zaib): a LID is a long numeric ID, not a phone number
  // — the lead must show the real name and never a fake number.
  const displayName = msg.pushName || '';
  const isLid = !!(fromJid && fromJid.endsWith('@lid'));
  // Text first; a picture / video / voice note is understood with
  // Gemini and becomes text the bot can answer to (2026-11-21, Zaib).
  let text = msg.message.conversation
    || msg.message.extendedTextMessage?.text
    || msg.message.imageMessage?.caption
    || msg.message.videoMessage?.caption
    || '';
  const hasMedia = !!(msg.message.imageMessage || msg.message.videoMessage || msg.message.audioMessage);
  if (hasMedia) {
    const understood = await understandCustomerMedia(msg);
    if (understood) text = understood;
  }
  if (!text.trim()) return;

  const key = `${businessId}:${fromJid}`;
  const history = histories.get(key) || [];
  history.push({ role: 'customer', text });
  // Design request (2026-11-22, Zaib: NO picture creation at all —
  // the picture section was deleted from the update). If the customer
  // asks to SEE a design / UI / picture, no picture is made — the
  // reply says the team will share the design (see ai.generateReply).
  const imageRequest = ai.detectImageRequest(text);
  const reply = await ai.generateReply(business, text, history, { imageRequest });
  // Never send the identical reply twice in a row to the same chat —
  // the no-key fallback used to repeat verbatim ("Website create
  // karvani hai" twice -> same reply twice). Vary it instead.
  reply.text = ai.varyIfRepeat(reply.text, lastReplyByChat.get(key), ai.detectLanguage(text));
  // Never let a file name / [image: ...] placeholder reach the customer
  // (2026-11-21: the AI wrote one into its text and the customer only
  // saw the name, not the picture). The real picture is attached above.
  reply.text = ai.stripMediaRefs(reply.text);
  // A design was asked for — never let a refusal ("mere paas direct
  // picture bhejne ka option nahi hai" / "I can't send a picture")
  // reach the customer (2026-11-22, 00:03 PKT chat). The team line
  // below is the honest answer instead.
  if (imageRequest) {
    reply.text = ai.stripPictureRefusal(reply.text);
  }
  // Safety net: a design was asked for — the customer still gets a
  // clear promise that the team will share it.
  if (imageRequest && !/design|team will share|team.*share/i.test(reply.text)) {
    reply.text += ' ' + (ai.detectLanguage(text) === 'en'
      ? 'The team will share the design with you soon and confirm the final one.'
      : 'Team jald aap ko design share karegi aur final confirm karegi.');
  }
  history.push({ role: 'bot', text: reply.text });
  histories.set(key, history.slice(-20));
  lastReplyByChat.set(key, reply.text);

  // Learn from this customer chat (2026-11-21, Zaib): the brain
  // remembers the question + its own answer, so the next customer who
  // asks the same thing gets the learned answer. Personal data is
  // never learned (see ai.learnFromCustomer).
  try { ai.learnFromCustomer(business, text, reply.text); } catch (e) {}
  try { store.saveBusiness(business); } catch (e) { console.error('Could not save business after customer chat:', e && e.message); }

  // Send media first if the AI picked one, then the short text reply.
  // The media always goes WITH a written line about what it is —
  // never a bare photo/video. The caption is ALWAYS the AI's own short
  // human line for that file — the owner's caption is written to teach
  // the BRAIN, and must never be sent to the customer (2026-11-21).
  // Human-like: typing indicator + 3–8s wait BEFORE anything is sent.
  try {
    await sendHumanLike(sock, fromJid, reply.text, async () => {
      if (reply.mediaId) {
        const media = (business.media || []).find((m) => m.id === reply.mediaId);
        if (media) {
          const filePath = path.join(store.DATA_DIR, 'uploads', businessId, media.filename);
          if (fs.existsSync(filePath)) {
            const buffer = fs.readFileSync(filePath);
            const mediaCaption = ai.mediaIntroText(media, ai.detectLanguage(text));
            if (media.kind === 'image') await sock.sendMessage(fromJid, { image: buffer, caption: mediaCaption });
            else if (media.kind === 'video') await sock.sendMessage(fromJid, { video: buffer, caption: mediaCaption });
            else if (media.kind === 'audio') await sock.sendMessage(fromJid, { audio: buffer, ptt: true });
          }
        }
      }
      await sock.sendMessage(fromJid, { text: reply.text });
    });
  } catch (e) {
    // The socket died while sending (2026-11-22, Zaib: the customer
    // saw "typing…" and then nothing — sendMessage threw Boom 428
    // "Connection Closed" while the board still said linked, and the
    // reply silently vanished). The reply must not vanish: mark the
    // socket dead, reconnect, and send the SAME reply once the new
    // socket is live. Text only on the retry — the media may already
    // have gone out, and a second picture would double-send it.
    console.error('Customer reply send failed, reconnecting + retrying:', (e && e.message) || e);
    markSocketDead(businessId);
    try {
      const live = await waitForLiveSocket(businessId, 25000);
      const liveSession = sessions.get(businessId);
      if (live && liveSession && liveSession.sock) {
        await sendHumanLike(liveSession.sock, fromJid, reply.text, async () => {
          await liveSession.sock.sendMessage(fromJid, { text: reply.text });
        });
      } else {
        console.error('Customer reply retry skipped: socket did not come back live in time');
      }
    } catch (e2) {
      console.error('Customer reply retry failed:', (e2 && e2.message) || e2);
    }
  }

  // Confirmation flow: when the customer has fully confirmed their
  // order, the bot says so in the team's words and the conversation
  // is forwarded to the owner as a SHORT lead (name, number, wants,
  // address, agreed price — see leads.parseLead / leadText), not the
  // full chat. Anything else still uses the normal lead capture below.
  if (isConfirmedOrder(text, reply.text, history)) {
    if (!TEAM_LINE_RE.test(reply.text)) {
      try { await sendText(businessId, fromJid, teamLineFor(ai.detectLanguage(text))); } catch (e) { console.error('team line send failed:', e && e.message); }
    }
    const historyText = history.map((h) => `${h.role === 'customer' ? 'Customer' : 'Bot'}: ${h.text}`).join('\n');
    await leads.captureAndForward(business, fromJid, historyText, (bid, jid, t) => sendText(bid, jid, t), { displayName, isLid });
  } else if (leads.looksLikeLead(text, business)) {
    // Lead-looking message but NO confirmation yet (2026-11-22, Zaib:
    // the alert comes only after the customer says "han theek hai") —
    // save the lead so nothing is lost, but send no alert.
    await leads.captureAndForward(business, fromJid, text, (bid, jid, t) => sendText(bid, jid, t), { displayName, isLid, forward: false });
  }
}

// LIVE link check — the ONLY thing the board's status display and the
// send guards may trust. business.linked survives restarts, and
// session.status keeps saying 'linked' after a socket dies, so neither
// can prove the link is alive. `connected` is true only between a real
// connection 'open' and the next 'close'.
function isLiveLinked(businessId) {
  const s = sessions.get(businessId);
  return !!(s && s.sock && s.connected === true && s.status === 'linked');
}

// On boot, reconnect every business whose stored flag says linked and
// whose auth creds are still registered — so a restart / redeploy never
// silently kills the link and the owner never has to re-link. Businesses
// without registered creds are skipped (nothing to reconnect with).
// A stale/invalid identity heals itself: Baileys closes it with
// loggedOut and the handler below wipes the auth + clears the flag.
async function restoreLinkedSessions() {
  let businesses = [];
  try { businesses = store.listBusinesses(); } catch (_) { return; }
  for (const b of businesses) {
    if (!b || !b.id || b.linked !== true) continue;
    if (!isRegistered(b.id)) continue;
    try {
      await startSocket(b.id);
      console.log('Restored WhatsApp session for', b.id);
    } catch (e) {
      console.error('Could not restore WhatsApp session for', b.id, (e && e.message) || e);
    }
  }
}

async function sendText(businessId, jid, text) {
  const session = getSession(businessId);
  // Only a fully linked session can send. A socket that is still waiting
  // for pairing accepts sendMessage() and then hangs indefinitely, which
  // froze lead confirmation — fail fast with the real reason instead.
  if (!isLiveLinked(businessId)) {
    throw new Error('WhatsApp not linked for this business');
  }
  return session.sock.sendMessage(jid, { text });
}

async function disconnect(businessId) {
  // Clear the stored linked flag FIRST, before touching the socket:
  // the board must never keep saying "already linked" for a dead
  // session just because the socket logout below threw or there was no
  // session at all (Zaib hit this 2026-11-21: disconnected + deleted,
  // yet every Get pairing code tap still answered "already linked").
  // Every step below is best-effort and can never stop the flag from
  // being cleared.
  try {
    const business = store.getBusiness(businessId);
    business.linked = false;
    business.linkedAt = null;
    store.saveBusiness(business);
  } catch (_) {}
  clearReconnect(businessId);
  pairingInFlight.delete(businessId);
  reconnectAttempts.delete(businessId);
  const session = getSession(businessId);
  if (session.sock) {
    try { session.sock.ev.removeAllListeners('connection.update'); } catch (_) {}
    try { await session.sock.logout(); } catch (_) {}
  }
  sessions.delete(businessId);
  // Wipe the stored auth state too: a later link must start from a clean
  // identity, never from a logged-out one (see requestPairingCode).
  try { fs.rmSync(authDir(businessId), { recursive: true, force: true }); } catch (_) {}
}

module.exports = { requestPairingCode, getSession, sendText, disconnect, pairingVerdictFromFrame, handleIncoming, humanDelayMs, sendHumanLike, isConfirmedOrder, teamLineFor, findAgreedPrice, isLiveLinked, restoreLinkedSessions, scheduleReconnect, markSocketDead, waitForLiveSocket, reconnectDelayMs, checkSocketLiveness, clearReconnect, sessions, reconnectAttempts, reconnectTimers };
