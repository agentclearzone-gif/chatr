'use strict';
/*
 * Chat anti-spam rules plus a strike system.
 *
 * Every violation (links, repeats, flooding, mass private messages, blocked words, rate limits)
 * adds a strike. Strikes fade at 1 per minute. At `muteAt` strikes the user is muted for 5 minutes;
 * at `kickAt` they are kicked and banned for 10 minutes. All thresholds come from Settings.
 */
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]{2,}\s*(?:\.|\(dot\)|\[dot\])\s*(?:com|net|org|io|co|me|ly|xyz|ru|info|biz|top|link|click|site|online|app|gg|tk|ml|ga|cf|to|cc|live|shop|store|club|vip|win|bet|onion|tv|us|uk|de|in)\b/i;
const MUTE_MS = 5 * 60 * 1000;
const DUP_WINDOW_MS = 60 * 1000;

class AntiSpam {
  constructor({ settings, stats, onAutoKick }) {
    this.settings = settings;
    this.stats = stats;
    this.onAutoKick = onAutoKick;
  }

  init(u) {
    u.spam = { strikes: 0, at: Date.now(), mutedUntil: 0, recent: [], chats: [] };
  }

  strikes(u) {
    const s = u.spam;
    const fade = Math.floor((Date.now() - s.at) / 60000);
    if (fade > 0) { s.strikes = Math.max(0, s.strikes - fade); s.at += fade * 60000; }
    return s.strikes;
  }

  mutedFor(u) {
    return Math.max(0, u.spam.mutedUntil - Date.now());
  }

  /** Record a violation. Returns true if the user was kicked as a result. */
  strike(u, kind) {
    this.stats.spam[kind] = (this.stats.spam[kind] || 0) + 1;
    const n = this.strikes(u) + 1;
    u.spam.strikes = n;
    if (n >= this.settings.get('kickAt')) {
      this.stats.spam.autoKicks++;
      this.onAutoKick(u);
      return true;
    }
    if (n >= this.settings.get('muteAt') && !this.mutedFor(u)) {
      u.spam.mutedUntil = Date.now() + MUTE_MS;
      this.stats.spam.autoMutes++;
    }
    return false;
  }

  /** If the user is muted, count the attempt as a strike (so persistent spammers get kicked) and return the reason. */
  checkMuted(u) {
    if (!this.mutedFor(u)) return null;
    this.strike(u, 'mutedAttempts');
    return this.mutedMessage(u);
  }

  mutedMessage(u) {
    const s = Math.ceil(this.mutedFor(u) / 1000);
    return `You are muted for spamming. Try again in ${s >= 60 ? Math.ceil(s / 60) + ' min' : s + 's'}.`;
  }

  /**
   * Check a text message. `where` is 'room' or 'pm'.
   * @returns {string|null} error to show the sender, or null if the message may go through
   */
  checkText(u, text, where) {
    const delay = this.settings.get('newUserRoomDelay');
    if (where === 'room' && delay && Date.now() - u.joined < delay * 1000) {
      this.stats.spam.newUser++;
      const left = Math.ceil((delay * 1000 - (Date.now() - u.joined)) / 1000);
      return `New users can post in the Main Room in ${left}s. You can chat privately right away.`;
    }

    const links = this.settings.get('linkPolicy');
    if ((links === 'all' || (links === 'room' && where === 'room')) && URL_RE.test(text)) {
      this.strike(u, 'links');
      return where === 'room' ? 'Links are not allowed in the Main Room.' : 'Links are not allowed.';
    }

    if (this.settings.get('duplicateCheck')) {
      const now = Date.now();
      const norm = text.toLowerCase().replace(/[\s\p{P}]+/gu, '');
      const recent = u.spam.recent = u.spam.recent.filter(r => now - r.ts < DUP_WINDOW_MS);
      // very short messages ("hi", "ok", "lol") are fine to repeat
      if (norm.length >= 6 && recent.some(r => r.norm === norm)) {
        this.strike(u, 'duplicates');
        return 'Please don\'t send the same message again.';
      }
      recent.push({ norm, ts: now });
      if (recent.length > 8) recent.shift();
    }
    return null;
  }

  /** Called before the first message of a new private conversation. */
  checkNewChat(u) {
    const now = Date.now();
    const chats = u.spam.chats = u.spam.chats.filter(ts => now - ts < 60000);
    if (chats.length >= this.settings.get('maxNewChatsPerMin')) {
      this.strike(u, 'massPm');
      return 'You are starting too many new chats. Please wait a minute.';
    }
    chats.push(now);
    return null;
  }
}

module.exports = AntiSpam;
