'use strict';
/*
 * Site appearance, editable from the admin panel (Appearance page) and saved through store.js
 * (database, or data/theme.json + data/uploads/ for images).
 * Colors become CSS variables; texts and images are rendered into the login page by the server,
 * so visitors never see a flash of the old theme.
 */
const crypto = require('crypto');

const PRESETS = {
  violet:  { label: 'Violet',        primary: '#5b3df5', primary2: '#3b1fc1', bg: '#f7f7fb', card: '#ffffff', text: '#0f1222', muted: '#6b7280' },
  gold:    { label: 'Dubai Gold',    primary: '#b8862f', primary2: '#8a611d', bg: '#f4ede2', card: '#fffdf9', text: '#1f1a14', muted: '#6b6358' },
  rose:    { label: 'Rose',          primary: '#e91e63', primary2: '#c2185b', bg: '#f5f6fa', card: '#ffffff', text: '#111827', muted: '#4b5563' },
  emerald: { label: 'Emerald Oasis', primary: '#0f7b5f', primary2: '#0a5a45', bg: '#edf4f0', card: '#ffffff', text: '#10231c', muted: '#56675f' },
  royal:   { label: 'Royal Blue',    primary: '#2952a3', primary2: '#1c3a78', bg: '#eef1f8', card: '#ffffff', text: '#141b2d', muted: '#586079' },
  desert:  { label: 'Desert Rose',   primary: '#b4546b', primary2: '#8c3a4f', bg: '#f7ece8', card: '#fffaf8', text: '#26161a', muted: '#6d5a5e' },
};
const COLOR_KEYS = ['primary', 'primary2', 'bg', 'card', 'text', 'muted'];
const TEXTS = { // key: [min, max]
  brandMain: [1, 24], brandAccent: [0, 24], tagline: [0, 60], description: [0, 300], buttonText: [1, 30],
  // search engines: <title>, meta description, and the short visible "about" text under the login card
  seoTitle: [0, 70], seoDesc: [0, 170], seoHeading: [0, 80], seoText: [0, 700],
};
const { label: _l, ...VIOLET } = PRESETS.violet;
const DEFAULTS = {
  preset: 'violet', ...VIOLET,
  brandMain: 'Chate', brandAccent: 'X', tagline: 'CHAT • CONNECT • DUBAI',
  description: 'Free anonymous chat. Your chats are deleted as soon as you or the other person leaves. Moderators may review live chats to keep everyone safe.',
  buttonText: 'Start chatting',
  seoTitle: 'ChateX – Free Arab Chat Rooms | شات عربي بدون تسجيل',
  seoDesc: 'Free anonymous chat with people from the UAE, Saudi Arabia, Egypt, Qatar, Kuwait and the whole Arab world. Private 1-to-1 chat, rooms and photos. No sign-up.',
  seoHeading: 'Free Arab chat rooms – meet new people instantly',
  seoText: 'ChateX is a free, anonymous chat site for the Arab world and beyond. Pick a name and start chatting in seconds: private one-to-one chats, group rooms, photo sharing and emoji, with no app to install and no sign-up. Meet people from the UAE, Saudi Arabia, Egypt, Qatar, Kuwait, Oman, Bahrain, Jordan, Lebanon, Iraq, Morocco and more. Your chats are deleted as soon as you leave.\nشات عربي مجاني ودردشة بدون تسجيل: تعرّف على أصدقاء جدد من الإمارات والسعودية ومصر وقطر والكويت وكل الدول العربية.',
  siteUrl: '',       // e.g. https://chatex.com: used for the canonical link, social previews and the sitemap
  showHero: false, showPattern: true,
  heroImage: null,   // { type, v } when an admin uploaded one (the bytes live in the store)
  logoImage: null,
};
const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/; // no SVG: it could carry scripts
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

class Theme {
  constructor(store) {
    this.store = store;
    const saved = store.get('theme') || {};
    // the site was renamed (ArabianTalk → chatMe → ChateX): update a saved name that is still an old default
    const renamed = ['Arabian|Talk', 'chat|Me'].includes(saved.brandMain + '|' + saved.brandAccent);
    if (renamed) Object.assign(saved, { brandMain: DEFAULTS.brandMain, brandAccent: DEFAULTS.brandAccent });
    this.values = { ...DEFAULTS };
    try { this.apply(saved); } catch {}
    // new violet design (matches the chat app): sites still on the old Dubai Gold default switch once
    if (!saved.violetDesign) {
      if (!saved.preset || saved.preset === 'gold') Object.assign(this.values, VIOLET, { preset: 'violet', showHero: false });
      this.values.violetDesign = true;
      this.save();
    } else if (renamed) this.save();
    this.values.violetDesign = true;
    for (const slot of ['hero', 'logo']) {
      const blob = store.getBlob(slot);
      if (blob) this.values[slot + 'Image'] = { type: blob.type, v: crypto.createHash('sha1').update(blob.data).digest('hex').slice(0, 10) };
    }
  }

  all() { return { ...this.values }; }

  apply(patch) {
    const next = { ...this.values };
    for (const [k, v] of Object.entries(patch || {})) {
      if (COLOR_KEYS.includes(k)) {
        if (!/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${k} must be a color like #b8862f`);
        next[k] = v.toLowerCase();
      } else if (k in TEXTS) {
        const raw = k === 'seoText' ? String(v ?? '').replace(/\r/g, '').replace(/\n{2,}/g, '\n') : String(v ?? ''); // seoText keeps line breaks (paragraphs)
        const s = raw.replace(k === 'seoText' ? /[\x00-\x09\x0b-\x1f\x7f]/g : /[\x00-\x1f\x7f]/g, ' ').trim();
        const [lo, hi] = TEXTS[k];
        if (s.length < lo || s.length > hi) throw new Error(`${k} must be ${lo}–${hi} characters`);
        next[k] = s;
      } else if (k === 'siteUrl') {
        const s = String(v ?? '').trim().replace(/\/+$/, '');
        if (s && !/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(s)) throw new Error('Site address must look like https://www.example.com');
        next[k] = s.toLowerCase();
      } else if (k === 'showHero' || k === 'showPattern') {
        next[k] = v === true;
      } else if (k === 'preset') {
        next[k] = PRESETS[v] || v === 'custom' ? v : 'custom';
      }
    }
    this.values = next;
  }

  update(patch) {
    this.apply(patch);
    this.save();
    return this.all();
  }

  save() {
    this.store.set('theme', this.values);
  }

  /** Uploaded image for 'hero' | 'logo': { type, data } or undefined. */
  image(slot) {
    return this.values[slot + 'Image'] ? this.store.getBlob(slot) : undefined;
  }

  /** slot: 'hero' | 'logo'; dataUrl: data:image/png|jpeg|webp;base64,… */
  saveImage(slot, dataUrl) {
    if (slot !== 'hero' && slot !== 'logo') throw new Error('Unknown image slot');
    const m = typeof dataUrl === 'string' && dataUrl.match(IMAGE_RE);
    if (!m) throw new Error('Please upload a PNG, JPEG or WebP image');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('Image is too large (max 4 MB)');
    const type = `image/${m[1]}`;
    this.store.setBlob(slot, buf, type);
    this.values[slot + 'Image'] = { type, v: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10) };
    this.save();
    return this.all();
  }

  removeImage(slot) {
    if (slot !== 'hero' && slot !== 'logo') throw new Error('Unknown image slot');
    this.store.delBlob(slot);
    this.values[slot + 'Image'] = null;
    this.save();
    return this.all();
  }
}

// Default logo: a dome/arch with a chat bubble, drawn in the theme's colors.
Theme.DEFAULT_LOGO = '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="atLogoGrad" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0" style="stop-color:color-mix(in srgb,var(--primary) 75%,#fff)"/><stop offset="1" style="stop-color:var(--primary-2)"/></linearGradient></defs>' +
  '<path fill="url(#atLogoGrad)" d="M24 5C13 5 4.5 12.6 4.5 22c0 4.9 2.3 9.3 6 12.4L9 42l8.2-4.1c2.1.7 4.4 1 6.8 1 11 0 19.5-7.6 19.5-17S35 5 24 5z"/>' +
  '<circle cx="16" cy="22" r="2.6" fill="#fff"/><circle cx="24" cy="22" r="2.6" fill="#fff"/><circle cx="32" cy="22" r="2.6" fill="#fff"/></svg>';

/** The theme's colors as CSS custom properties. */
Theme.cssVars = t => `:root{--primary:${t.primary};--primary-2:${t.primary2};--bg:${t.bg};--card:${t.card};--text:${t.text};--muted:${t.muted}}`;

Theme.PRESETS = PRESETS;
Theme.DEFAULTS = DEFAULTS;
module.exports = Theme;
