'use strict';
/* Anti-spam settings, editable from the admin panel and persisted in data/settings.json. */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  captcha: true,            // bot check at login
  powDifficulty: 18,        // built-in puzzle: leading zero bits (each +1 doubles the work)
  linkPolicy: 'room',       // 'allow' | 'room' (no links in Main Room) | 'all' (no links anywhere)
  duplicateCheck: true,     // reject the same message repeated within 60s
  newUserRoomDelay: 20,     // seconds before a new user may post in the Main Room
  maxNewChatsPerMin: 8,     // new private conversations a user may start per minute
  muteAt: 5,                // strikes → muted for 5 minutes
  kickAt: 10,               // strikes → kicked + banned for 10 minutes
  liveTyping: true,         // private chats: the other person sees text as it is typed
};
const RANGES = {
  powDifficulty: [12, 24], newUserRoomDelay: [0, 3600], maxNewChatsPerMin: [1, 500], muteAt: [2, 100], kickAt: [3, 200],
};

class Settings {
  constructor(file) {
    this.file = file;
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    this.values = { ...DEFAULTS };
    try { this.apply(saved); } catch { /* ignore a bad file, keep defaults */ }
  }

  get(key) { return this.values[key]; }
  all() { return { ...this.values }; }

  apply(patch) {
    const next = { ...this.values };
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULTS)) continue;
      if (typeof DEFAULTS[k] === 'boolean') next[k] = v === true || v === 'true';
      else if (k === 'linkPolicy') {
        if (!['allow', 'room', 'all'].includes(v)) throw new Error('Invalid link policy');
        next[k] = v;
      } else {
        const n = Math.round(Number(v));
        const [lo, hi] = RANGES[k];
        if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${k} must be between ${lo} and ${hi}`);
        next[k] = n;
      }
    }
    if (next.kickAt <= next.muteAt) throw new Error('Auto-kick must need more strikes than auto-mute');
    this.values = next;
  }

  update(patch) {
    this.apply(patch);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2));
    return this.all();
  }
}

module.exports = Settings;
