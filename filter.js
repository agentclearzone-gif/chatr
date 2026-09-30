'use strict';
/*
 * Word filter managed from the admin panel. Rules are saved through store.js (database or data/filters.json).
 * Each rule: { id, word, match: 'word' | 'contains', action: 'mask' | 'block', hits, created }
 *  - match 'word'     → only whole words ("ass" won't hit "class")
 *  - match 'contains' → anywhere inside a word
 *  - action 'mask'    → replaced with *** and delivered
 *  - action 'block'   → message is not delivered at all
 * All rules of one action are compiled into a single regex, so checking is one pass per message.
 */
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
const norm = s => s.toLowerCase().replace(/\s+/g, ' ').trim();

class WordFilter {
  constructor(store) {
    this.store = store;
    const saved = store.get('filters');
    this.rules = Array.isArray(saved) ? saved : [];
    this.nextId = this.rules.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    this.dirty = false;
    this.compile();
    // Hit counters change constantly; save them at most every 30 minutes (rule changes save immediately).
    // Rare writes let a serverless database sleep between admin actions and stay within free limits.
    setInterval(() => { if (this.dirty) this.save(); }, 30 * 60 * 1000).unref();
  }

  compile() {
    const build = action => {
      const parts = this.rules.filter(r => r.action === action)
        .sort((a, b) => b.word.length - a.word.length)
        .map(r => r.match === 'word' ? `(?<![\\p{L}\\p{N}_])${escapeRe(r.word)}(?![\\p{L}\\p{N}_])` : escapeRe(r.word));
      return parts.length ? new RegExp(parts.join('|'), 'giu') : null;
    };
    this.blockRe = build('block');
    this.maskRe = build('mask');
    // any rule, ignoring word boundaries — used for usernames like "badword123"
    const all = this.rules.map(r => escapeRe(r.word));
    this.nameRe = all.length ? new RegExp(all.join('|'), 'iu') : null;
    this.byWord = new Map(this.rules.map(r => [norm(r.word), r]));
  }

  save() {
    this.dirty = false;
    this.store.set('filters', this.rules);
  }

  hit(matchText) {
    const r = this.byWord.get(norm(matchText));
    if (r) { r.hits++; this.dirty = true; }
  }

  /** @returns {{ text: string, blocked: boolean, masked: boolean }} */
  check(text) {
    if (this.blockRe) {
      this.blockRe.lastIndex = 0;
      const m = this.blockRe.exec(text);
      if (m) { this.hit(m[0]); return { text, blocked: true, masked: false }; }
    }
    if (this.maskRe) {
      let masked = false;
      const out = text.replace(this.maskRe, m => { masked = true; this.hit(m); return '*'.repeat(m.length); });
      return { text: out, blocked: false, masked };
    }
    return { text, blocked: false, masked: false };
  }

  /** Mask every filtered word (block or mask rules) without counting hits — used for live typing previews. */
  maskAll(text) {
    let out = text;
    for (const re of [this.blockRe, this.maskRe]) if (re) out = out.replace(re, m => '*'.repeat(m.length));
    return out;
  }

  nameAllowed(name) {
    return !this.nameRe || !this.nameRe.test(name);
  }

  list() { return this.rules; }

  add({ word, match, action }) {
    word = typeof word === 'string' ? word.trim().replace(/\s+/g, ' ') : '';
    if (!word || word.length > 60) throw new Error('Word must be 1–60 characters');
    if (!['word', 'contains'].includes(match)) throw new Error('Invalid match type');
    if (!['mask', 'block'].includes(action)) throw new Error('Invalid action');
    if (this.byWord.has(norm(word))) throw new Error('That word is already in the filter');
    if (this.rules.length >= 5000) throw new Error('Filter is full (5000 words)');
    const rule = { id: this.nextId++, word, match, action, hits: 0, created: Date.now() };
    this.rules.push(rule);
    this.compile();
    this.save();
    return rule;
  }

  update(id, { match, action }) {
    const r = this.rules.find(x => x.id === id);
    if (!r) throw new Error('Not found');
    if (match !== undefined) { if (!['word', 'contains'].includes(match)) throw new Error('Invalid match type'); r.match = match; }
    if (action !== undefined) { if (!['mask', 'block'].includes(action)) throw new Error('Invalid action'); r.action = action; }
    this.compile();
    this.save();
    return r;
  }

  remove(id) {
    const i = this.rules.findIndex(x => x.id === id);
    if (i < 0) return false;
    this.rules.splice(i, 1);
    this.compile();
    this.save();
    return true;
  }
}

module.exports = WordFilter;
