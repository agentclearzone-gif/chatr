'use strict';
/*
 * Bot check at login. Two modes:
 *
 *  - Cloudflare Turnstile, when TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set.
 *    Free, usually invisible to people, and the strongest option against bot farms.
 *
 *  - Built-in proof-of-work (default, no third party). The browser must find a nonce so that
 *    SHA-256(salt + nonce) starts with N zero bits. It solves in the background while the person
 *    fills in the form (~0.2–1s), but it makes mass sign-ups by bots slow and expensive.
 *    Challenges are HMAC-signed (no server state), expire after 2 minutes and are single-use.
 *    An IP that asks for lots of challenges gets harder puzzles.
 *
 * CAPTCHA=off in the environment disables the check entirely (used for load tests).
 */
const crypto = require('crypto');

const TTL_MS = 2 * 60 * 1000;
const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

class Captcha {
  constructor({ settings, stats }) {
    this.settings = settings;
    this.stats = stats;
    this.secret = crypto.randomBytes(32);
    this.used = new Map();       // salt -> expiry (replay protection)
    this.perIp = new Map();      // ip -> { n, reset }
    this.turnstile = process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY
      ? { siteKey: process.env.TURNSTILE_SITE_KEY, secret: process.env.TURNSTILE_SECRET_KEY } : null;
    this.forcedOff = process.env.CAPTCHA === 'off';
    setInterval(() => {
      const now = Date.now();
      for (const [s, exp] of this.used) if (exp < now) this.used.delete(s);
      for (const [ip, e] of this.perIp) if (e.reset < now) this.perIp.delete(ip);
    }, 60000).unref();
  }

  mode() {
    if (this.forcedOff || !this.settings.get('captcha')) return 'off';
    return this.turnstile ? 'turnstile' : 'pow';
  }

  difficultyFor(ip) {
    const now = Date.now();
    let e = this.perIp.get(ip);
    if (!e || e.reset < now) { e = { n: 0, reset: now + 10 * 60000 }; this.perIp.set(ip, e); }
    e.n++;
    // 10 challenges per 10 minutes are free; every doubling after that adds a bit (up to +6 ≈ 64× harder).
    const extra = e.n <= 10 ? 0 : Math.min(6, Math.floor(Math.log2(e.n / 10)) + 1);
    return Math.min(28, this.settings.get('powDifficulty') + extra);
  }

  sign(salt) {
    return crypto.createHmac('sha256', this.secret).update(salt).digest('base64url');
  }

  /** What the login page needs to show / solve. */
  challenge(ip) {
    const mode = this.mode();
    if (mode === 'turnstile') return { mode, siteKey: this.turnstile.siteKey };
    if (mode === 'off') return { mode };
    const difficulty = this.difficultyFor(ip);
    const salt = `${Date.now() + TTL_MS}.${crypto.randomBytes(12).toString('hex')}.${difficulty}`;
    return { mode, salt, sig: this.sign(salt), difficulty };
  }

  /** @returns {Promise<boolean>} */
  async verify(cap, ip) {
    const mode = this.mode();
    if (mode === 'off') return true;
    const ok = mode === 'turnstile' ? await this.verifyTurnstile(cap, ip) : this.verifyPow(cap);
    ok ? this.stats.spam.captchaPassed++ : this.stats.spam.captchaFailed++;
    return ok;
  }

  verifyPow(cap) {
    if (!cap || typeof cap !== 'object') return false;
    const { salt, sig, nonce } = cap;
    if (typeof salt !== 'string' || typeof sig !== 'string' || typeof nonce !== 'string') return false;
    if (salt.length > 100 || !/^\d{1,12}$/.test(nonce)) return false;
    const expected = Buffer.from(this.sign(salt));
    const given = Buffer.from(sig);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
    const [exp, , d] = salt.split('.');
    if (+exp < Date.now() || this.used.has(salt)) return false;
    const hash = crypto.createHash('sha256').update(salt + nonce).digest();
    if (!leadingZeroBits(hash, +d)) return false;
    this.used.set(salt, +exp);
    return true;
  }

  async verifyTurnstile(token, ip) {
    if (typeof token !== 'string' || !token || token.length > 2048) return false;
    try {
      const body = new URLSearchParams({ secret: this.turnstile.secret, response: token });
      if (ip) body.set('remoteip', ip.replace(/^::ffff:/, ''));
      const res = await fetch(TURNSTILE_VERIFY, { method: 'POST', body, signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      return data.success === true;
    } catch (e) {
      // Cloudflare unreachable: let people in rather than locking everyone out; rate limits still apply.
      console.warn('[captcha] Turnstile verification unavailable:', e.message);
      return true;
    }
  }
}

function leadingZeroBits(buf, bits) {
  let i = 0;
  for (; bits >= 8; bits -= 8, i++) if (buf[i] !== 0) return false;
  return bits === 0 || (buf[i] >> (8 - bits)) === 0;
}

module.exports = Captcha;
