// Lifetime counters (2026-11-23, Zaib): the admin dashboard totals must
// SURVIVE a restart — the in-memory activity buffer (last 100 events)
// resets to zero on every redeploy, so these counters live on disk in
// stats.json next to businesses.json and are only ever incremented,
// never reset. Sync JSON file I/O, same pattern as src/store.js.
// Never throws: a stats failure must never break the reply path or the
// campaign send that increments it — every function is best-effort.
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');

const STATS_FILE = path.join(store.DATA_DIR, 'stats.json');

function defaultStats() {
  return { incoming: 0, replies: 0, campaignMessages: 0, updatedAt: null };
}

function cleanStats(data) {
  const out = defaultStats();
  if (data && typeof data === 'object') {
    for (const key of ['incoming', 'replies', 'campaignMessages']) {
      const v = Number(data[key]);
      if (Number.isFinite(v) && v > 0) out[key] = Math.floor(v);
    }
    if (typeof data.updatedAt === 'string') out.updatedAt = data.updatedAt;
  }
  return out;
}

function loadStats() {
  try {
    return cleanStats(JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')));
  } catch (_) {
    return defaultStats();
  }
}

function saveStats(stats) {
  try {
    fs.mkdirSync(store.DATA_DIR, { recursive: true });
    const out = cleanStats(stats);
    out.updatedAt = new Date().toISOString();
    fs.writeFileSync(STATS_FILE, JSON.stringify(out, null, 2));
    return out;
  } catch (_) {
    return stats;
  }
}

// Increment one lifetime counter by 1 and persist it. Keys: 'incoming'
// (a customer message arrived), 'replies' (a bot reply was actually
// sent), 'campaignMessages' (one bulk-campaign message went out).
function inc(key) {
  try {
    if (key !== 'incoming' && key !== 'replies' && key !== 'campaignMessages') return null;
    const stats = loadStats();
    stats[key] += 1;
    return saveStats(stats);
  } catch (_) {
    return null;
  }
}

function getStats() {
  return loadStats();
}

module.exports = { STATS_FILE, defaultStats, loadStats, saveStats, inc, getStats };
