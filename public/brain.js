// Brain Chat page logic — the owner teaches the bot's brain.
// Uses the shared helpers from app.js: businessId(), api(), apiJson(),
// toast(), esc(). No login — Business ID only, like the other pages.
'use strict';

let brainLoaded = false;

// Warm greeting shown ONLY in the UI when the brain has no messages
// yet — it is never sent to the server and never stored in the brain's
// memory. It just makes the chat feel like a friendly conversation.
const BRAIN_GREETING = 'Salam! Main aapka Brain hoon. Apne business ke baare mein kuch bhi batayein — main samajh kar aapke customers se khud baat kar lunga.';

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
  // Messages render into #brainMessages; the summary card sits above
  // them inside the same scrollable list, so it scrolls away as the
  // conversation grows and the live chat stays in front.
  const el = document.getElementById('brainMessages') || document.getElementById('brainChat');
  if (!el) return;
  const list = memory || [];
  if (!list.length) {
    el.innerHTML = `<div class="chat-msg brain"><b>Brain</b><p>${formatBrainText(BRAIN_GREETING)}</p></div>`;
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
  if (!confirm('Delete ALL brain data? Your prompt, memory and summary will be wiped. This cannot be undone.')) return;
  try {
    await apiJson(api('/brain/clear'), { method: 'POST' });
    toast('Brain data deleted — memory is empty now.');
    await loadBrain();
  } catch (e) {
    toast('Could not delete brain data: ' + e.message);
  }
}

function renderBrainSummary(summary) {
  const box = document.getElementById('brainSummary');
  const txt = document.getElementById('brainSummaryText');
  if (!box || !txt) return;
  if (!summary || (!summary.services.length && !summary.prices.length && !summary.location && !summary.name)) {
    box.style.display = 'none';
    return;
  }
  const parts = [];
  if (summary.name) parts.push(`Business: ${summary.name}`);
  if (summary.category) parts.push(`Category: ${summary.category}`);
  if (summary.services.length) parts.push(`Services: ${summary.services.slice(0, 4).join(' | ')}`);
  if (summary.prices.length) parts.push(`Rates: ${summary.prices.slice(0, 4).join(' | ')}`);
  if (summary.deals.length) parts.push(`Deals: ${summary.deals.slice(0, 3).join(' | ')}`);
  if (summary.location) parts.push(`Location: ${summary.location}`);
  txt.textContent = parts.join('\n');
  box.style.display = '';
}

function renderBrainAiBadge(aiConnected) {
  const badge = document.getElementById('brainAiBadge');
  if (!badge) return;
  // The badge shows connection status only — when Gemini is not
  // connected the brain still works locally and confirms in seconds,
  // so the badge never says "AI not connected".
  badge.textContent = aiConnected ? '● AI connected' : '● Brain ready';
  badge.className = 'badge ' + (aiConnected ? 'linked' : 'waiting');
}

async function loadBrain() {
  try {
    const d = await apiJson(api('/brain'));
    renderBrainMemory(d.brainMemory);
    renderBrainSummary(d.brainSummary);
    renderBrainAiBadge(d.aiConnected);
    scrollBrainToBottom(); // summary showing changes the height — stay on the live chat
    brainLoaded = true;
  } catch (e) {
    toast('Brain could not be loaded: ' + e.message);
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
    renderBrainSummary(d.brainSummary);
    renderBrainAiBadge(d.aiConnected);
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
  toast('Uploading ' + file.name + '…');
  const fd = new FormData();
  fd.append('file', file);
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
  const fileInput = document.getElementById('brainFile');
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      fileInput.value = '';
      // Only shows the preview + caption box — nothing uploads yet.
      if (f) showBrainFilePending(f);
    });
  }
  const capInput = document.getElementById('brainFileCaption');
  if (capInput) {
    capInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendBrainMedia(); }
    });
  }
  loadBrain();
});
