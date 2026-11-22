// Brain Chat page logic — the owner teaches the bot's brain.
// Uses the shared helpers from app.js: businessId(), api(), apiJson(),
// toast(), esc(). No login — Business ID only, like the other pages.
// The page itself is a chat screen (like the reference): the big
// character + "Hello!" greeting at the top, the chat below it, and a
// white pill composer at the bottom. Nothing else lives on this page.
'use strict';

let brainLoaded = false;

// Always show the LIVE chat: scroll the list to the newest message.
function scrollBrainToBottom() {
  const el = document.getElementById('brainChat');
  if (el) el.scrollTop = el.scrollHeight;
}

// Brain replies come back with markdown (**bold**, - bullets). Render
// the bold as <b> and keep bullets as plain lines — never show raw **
// in the chat. Owner messages are escaped only.
function formatBrainText(text) {
  return esc(text).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

function renderBrainMemory(memory) {
  // The hero (big character + Hello + start pill) shrinks and moves up
  // as soon as the chat has messages — the .compact class, with a CSS
  // transition. With no messages yet, the hero is the greeting.
  const hero = document.getElementById('brainHero');
  const list = memory || [];
  if (hero) hero.classList.toggle('compact', list.length > 0);
  const el = document.getElementById('brainMessages') || document.getElementById('brainChat');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '';
    scrollBrainToBottom();
    return;
  }
  el.innerHTML = list.map((m) => {
    const who = m.role === 'owner' ? 'You' : 'Brain';
    const body = m.role === 'owner' ? esc(m.text) : formatBrainText(m.text);
    return `<div class="chat-msg ${m.role === 'owner' ? 'owner' : 'brain'}"><b>${who}</b><p>${body}</p></div>`;
  }).join('');
  scrollBrainToBottom();
}

// REAL delete: wipes prompt + memory + summary on the server, then
// reloads the (now empty) brain. Lead settings, link and campaigns
// are untouched — only brain knowledge goes.
async function clearBrainData() {
  closeBrainMenu();
  if (!confirm('Delete ALL brain data? Your prompt, memory and summary will be wiped. This cannot be undone.')) return;
  try {
    await apiJson(api('/brain/clear'), { method: 'POST' });
    toast('Brain data deleted — memory is empty now.');
    await loadBrain();
  } catch (e) {
    toast('Could not delete brain data: ' + e.message);
  }
}

async function loadBrain() {
  try {
    const d = await apiJson(api('/brain'));
    renderBrainMemory(d.brainMemory);
    scrollBrainToBottom();
    brainLoaded = true;
  } catch (e) {
    const msg = String(e.message || '');
    toast('Brain could not be loaded: ' + (msg.includes('Business ID') ? 'go to Home and enter your Business ID first.' : msg));
  }
}

function showAnalyzing() {
  const el = document.getElementById('brainMessages') || document.getElementById('brainChat');
  if (!el) return null;
  const div = document.createElement('div');
  div.className = 'chat-msg brain analyzing';
  // Typing indicator: three bouncing dots (WhatsApp-style) while the
  // brain is thinking — no plain "Analyzing…" text.
  div.innerHTML = '<b>Brain</b><div class="typing-dots" aria-label="Brain is typing"><span></span><span></span><span></span></div>';
  el.appendChild(div);
  scrollBrainToBottom();
  return div;
}

async function sendBrainMessage() {
  const input = document.getElementById('brainInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) { toast('Write something first — or tap the mic and speak.'); return; }
  input.value = '';
  const sendBtn = document.getElementById('brainSend');
  if (sendBtn) sendBtn.disabled = true;
  const analyzing = showAnalyzing();
  try {
    const d = await apiJson(api('/brain/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    if (analyzing) analyzing.remove();
    renderBrainMemory(d.brainMemory);
    scrollBrainToBottom(); // newest reply in front, old chat scrolled away
    // No "AI is not connected" toast here: when Gemini is slow or
    // missing, the brain confirms locally in seconds (see ai.js) — the
    // reply itself is the confirmation, never an error message.
  } catch (e) {
    if (analyzing) analyzing.remove();
    toast('Brain reply failed: ' + e.message);
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    input.focus();
  }
}

// --- Three-dot menu: Setup from link + Delete all brain data ------------
function toggleBrainMenu() {
  const menu = document.getElementById('brainMenu');
  const btn = document.getElementById('brainMenuBtn');
  if (!menu) return;
  const open = !menu.classList.contains('open');
  menu.classList.toggle('open', open);
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function closeBrainMenu() {
  const menu = document.getElementById('brainMenu');
  const btn = document.getElementById('brainMenuBtn');
  if (menu) menu.classList.remove('open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

// --- Setup from link: the board reads a website / Facebook / Instagram
// link and fills the brain itself. Brain Chat keeps working alongside
// it — both ways, merge never wipe. The server appends what it learned
// to the brain's memory, so it shows up as a brain message in the chat.
function openLinkSheet() {
  closeBrainMenu();
  const sheet = document.getElementById('brainLinkSheet');
  const overlay = document.getElementById('brainSheetOverlay');
  const status = document.getElementById('brainLinkStatus');
  if (status) status.textContent = '';
  if (sheet) sheet.classList.add('open');
  if (overlay) overlay.classList.add('open');
  const input = document.getElementById('brainLinkUrl');
  if (input) input.focus();
}
function closeLinkSheet() {
  const sheet = document.getElementById('brainLinkSheet');
  const overlay = document.getElementById('brainSheetOverlay');
  if (sheet) sheet.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
}
async function setupBrainFromLink() {
  const input = document.getElementById('brainLinkUrl');
  const status = document.getElementById('brainLinkStatus');
  const goBtn = document.getElementById('brainLinkGo');
  const url = input ? input.value.trim() : '';
  if (!url) { if (status) status.textContent = 'Paste a link first — your website, Facebook page or Instagram.'; return; }
  if (goBtn) goBtn.disabled = true;
  if (status) status.textContent = 'Reading the link…';
  try {
    const d = await apiJson(api('/brain/setup-from-link'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const f = d.facts || {};
    const learned = [f.name, f.category].filter(Boolean).join(' — ')
      || (f.services || []).slice(0, 2).join(', ')
      || 'your business';
    if (status) status.textContent = 'Brain learned: ' + learned;
    toast('Brain learned from the link.');
    setTimeout(() => { closeLinkSheet(); loadBrain(); }, 900);
  } catch (e) {
    if (status) status.textContent = 'Could not read that link: ' + e.message;
  } finally {
    if (goBtn) goBtn.disabled = false;
  }
}

// --- Voice input: continuous speech-to-text, typed into the box --------
// UI v3: the mic keeps listening as long as the user speaks (continuous
// mode, auto-restart on end while recording is on), shows the live
// interim transcript in the input, and NOTHING is sent until the user
// taps Send — the whole transcript goes with one Send tap.
let recognition = null;
let listening = false;
let micBase = ''; // final transcript committed so far in this mic session
function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const hint = document.getElementById('brainMicHint');
  const micBtn = document.getElementById('brainMic');
  if (!SR) {
    toast('Voice input is not supported in this browser — please type instead.');
    return;
  }
  if (listening && recognition) {
    // User tapped the mic again: stop. Set the flag FIRST so onend
    // does not auto-restart.
    listening = false;
    try { recognition.stop(); } catch (_) {}
    return;
  }
  recognition = new SR();
  recognition.lang = 'ur-PK'; // understands Roman Urdu / Urdu / English mixed speech
  recognition.continuous = true; // keep listening while the user speaks
  recognition.interimResults = true; // live transcript while speaking
  recognition.maxAlternatives = 1;
  const input = document.getElementById('brainInput');
  micBase = input && input.value ? input.value.trim() + ' ' : '';
  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) micBase += transcript;
      else interim += transcript;
    }
    if (input) input.value = (micBase + interim).trim();
  };
  recognition.onend = () => {
    // SpeechRecognition stops by itself after pauses — restart while
    // the user is still recording, so speaking never cuts off.
    if (listening) {
      try { recognition.start(); return; } catch (_) {}
    }
    listening = false;
    if (micBtn) micBtn.classList.remove('listening');
    if (hint) hint.style.display = 'none';
  };
  recognition.onerror = (event) => {
    const err = event.error || '';
    // 'no-speech' / 'aborted' are normal mid-session: onend restarts.
    if (err === 'no-speech' || err === 'aborted') return;
    listening = false;
    if (micBtn) micBtn.classList.remove('listening');
    if (hint) hint.style.display = 'none';
    toast('Mic could not listen (' + err + ') — please type instead.');
  };
  try {
    recognition.start();
    listening = true;
    if (micBtn) micBtn.classList.add('listening');
    if (hint) hint.style.display = '';
  } catch (e) {
    toast('Mic could not start — please type instead.');
  }
}

// --- Media inside Brain Chat: a file is NEVER sent without a message ---
// (2026-11-20, Brain improvements). Choosing a file only shows a
// preview chip + a caption box ("Is file ke baare mein batao — kis
// kaam ke liye hai?"). Nothing uploads until the owner writes the
// message and taps "Send to brain". The message travels WITH the
// upload (caption + ownerNote + useFor) and into the describe prompt,
// so Gemini analyses the picture + the owner's words together.
let pendingBrainFile = null;

function showBrainFilePending(file) {
  pendingBrainFile = file;
  const box = document.getElementById('brainFilePending');
  const prev = document.getElementById('brainFilePreview');
  const nameEl = document.getElementById('brainFileName');
  const cap = document.getElementById('brainFileCaption');
  if (!box) return;
  if (nameEl) nameEl.textContent = file.name;
  if (cap) cap.value = '';
  if (prev) {
    prev.innerHTML = '';
    if (file.type.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.alt = file.name;
      prev.appendChild(img);
    } else {
      prev.textContent = file.type.startsWith('video/') ? 'VIDEO' : 'AUDIO';
    }
  }
  box.style.display = '';
  if (cap) cap.focus();
}

function cancelBrainMedia() {
  pendingBrainFile = null;
  const box = document.getElementById('brainFilePending');
  if (box) box.style.display = 'none';
  const cap = document.getElementById('brainFileCaption');
  if (cap) cap.value = '';
  const prev = document.getElementById('brainFilePreview');
  if (prev) prev.innerHTML = '';
}

async function sendBrainMedia() {
  const cap = document.getElementById('brainFileCaption');
  const caption = cap ? cap.value.trim() : '';
  if (!pendingBrainFile) { toast('Choose a photo or video first.'); return; }
  if (!caption) { toast('Pehle batayein — ye file kis kaam ke liye hai?'); if (cap) cap.focus(); return; }
  const file = pendingBrainFile;
  cancelBrainMedia();
  await uploadBrainMedia(file, caption);
}

async function uploadBrainMedia(file, caption) {
  if (!file) return;
  const note = String(caption || '').trim();
  // Purpose (2026-11-21): knowledge = brain-only, never sent to a
  // customer; customer = the brain may send it when it fits. The
  // radios default to knowledge.
  const purposeEl = document.querySelector('input[name="brainFilePurpose"]:checked');
  const purpose = purposeEl && purposeEl.value === 'customer' ? 'customer' : 'knowledge';
  toast('Uploading ' + file.name + '…');
  const fd = new FormData();
  fd.append('file', file);
  fd.append('purpose', purpose);
  // The owner's message goes with the file: caption (what it is),
  // ownerNote (what it is for) and useFor (when to send it) — the
  // brain uses all three, and describe analyses picture + words.
  if (note) { fd.append('caption', note); fd.append('ownerNote', note); fd.append('useFor', note); }
  try {
    const d = await apiJson(api('/media'), { method: 'POST', body: fd });
    const media = d.media;
    toast('Uploaded. The brain is analysing it…');
    const analyzing = showAnalyzing();
    try {
      const desc = await apiJson(api('/media/' + encodeURIComponent(media.id) + '/describe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caption: note }),
      });
      if (analyzing) analyzing.remove();
      // The server also saved this analysis into the brain's memory.
      await loadBrain();
      toast('Brain understood your ' + media.kind + ': ' + (desc.description || '').slice(0, 80) + '…');
    } catch (e) {
      if (analyzing) analyzing.remove();
      toast('Uploaded, but analysis failed: ' + e.message);
      await loadBrain();
    }
  } catch (e) {
    toast('Upload failed: ' + e.message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('brainInput');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendBrainMessage(); }
    });
  }
  const micBtn = document.getElementById('brainMic');
  if (micBtn) micBtn.addEventListener('click', toggleMic);
  // Composer attach buttons: + takes any file, the image button takes
  // photos, the video button takes videos. All three only show the
  // preview chip — nothing uploads until the owner writes the message.
  const wireFileButton = (btnId, inputId) => {
    const btn = document.getElementById(btnId);
    const fileInput = document.getElementById(inputId);
    if (btn && fileInput) btn.addEventListener('click', () => fileInput.click());
    if (fileInput) {
      fileInput.addEventListener('change', () => {
        const f = fileInput.files[0];
        fileInput.value = '';
        if (f) showBrainFilePending(f);
      });
    }
  };
  wireFileButton('brainPlus', 'brainFile');
  wireFileButton('brainImageBtn', 'brainImageFile');
  wireFileButton('brainVideoBtn', 'brainVideoFile');
  const linkInput = document.getElementById('brainLinkUrl');
  if (linkInput) {
    linkInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); setupBrainFromLink(); }
    });
  }
  // Tapping anywhere outside the three-dot menu closes it.
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('brainMenu');
    const btn = document.getElementById('brainMenuBtn');
    if (menu && menu.classList.contains('open') && btn && !btn.contains(e.target) && !menu.contains(e.target)) closeBrainMenu();
  });
  const capInput = document.getElementById('brainFileCaption');
  if (capInput) {
    capInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendBrainMedia(); }
    });
  }
  loadBrain();
});
