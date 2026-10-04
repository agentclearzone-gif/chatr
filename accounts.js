'use strict';
/*
 * Optional registered profiles. Guests never need one; a registered profile gives a reserved
 * username + password login, saved details (gender, age, country, state), a photo, a short bio
 * and a ✓ badge. Saved through store.js (PostgreSQL table chat_accounts, or data/accounts.json).
 *
 * Passwords are salted scrypt hashes, checked off the main thread. Logging in to a username that
 * doesn't exist takes as long as a wrong password, so timing doesn't reveal who is registered.
 */
const crypto = require('crypto');

const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 32, (e, key) => (e ? rej(e) : res(key))));
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;
const MAX_PHOTO_BYTES = 300 * 1024;
const PHOTO_CACHE = 300;
const CTRL = new RegExp('[\\x00-\\x1f\\x7f' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');

class Accounts {
  constructor(store, filter) {
    this.store = store;
    this.filter = filter;
    this.photos = new Map(); // small LRU cache: key -> { type, data }
    this.dummyHash = null;
  }

  get(name) { return this.store.allAccounts().get(String(name || '').toLowerCase()); }
  count() { return this.store.allAccounts().size; }
  list() { return [...this.store.allAccounts().values()]; }

  checkPassword(pw) {
    if (typeof pw !== 'string' || pw.length < 8) throw new Error('Password must be at least 8 characters');
    if (pw.length > 72) throw new Error('Password must be at most 72 characters');
  }

  cleanBio(bio) {
    const s = typeof bio === 'string' ? bio.replace(CTRL, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    if (!s) return '';
    const r = this.filter.check(s);
    if (r.blocked) throw new Error('Your bio contains a word that isn\'t allowed');
    return r.text;
  }

  async hash(pw) {
    const salt = crypto.randomBytes(16);
    return `${salt.toString('base64')}:${(await scrypt(pw, salt)).toString('base64')}`;
  }

  async verifyHash(stored, pw) {
    const [salt, hash] = stored.split(':');
    const given = await scrypt(String(pw), Buffer.from(salt, 'base64'));
    return crypto.timingSafeEqual(given, Buffer.from(hash, 'base64'));
  }

  /** profile = { g, age, loc, cc } already validated by the caller */
  async register(name, password, profile, bio) {
    if (this.get(name)) throw new Error('That username is already registered');
    this.checkPassword(password);
    const acct = {
      key: name.toLowerCase(), name, hash: await this.hash(password), ...profile, bio: this.cleanBio(bio),
      photoV: null, created: Date.now(), lastLogin: Date.now(),
    };
    if (this.get(name)) throw new Error('That username is already registered'); // taken while hashing
    this.store.saveAccount(acct);
    return acct;
  }

  /** @returns the account, or null for a wrong username/password */
  async login(name, password) {
    const acct = this.get(name);
    if (!acct) {
      // same work as a real check, so a missing account can't be told apart by timing
      this.dummyHash = this.dummyHash || await this.hash('not-a-real-password');
      await this.verifyHash(this.dummyHash, password);
      return null;
    }
    if (typeof password !== 'string' || !password || password.length > 72) return null;
    return (await this.verifyHash(acct.hash, password)) ? acct : null;
  }

  touch(acct) { acct.lastLogin = Date.now(); this.store.saveAccount(acct); }

  update(acct, fields) {
    Object.assign(acct, fields);
    this.store.saveAccount(acct);
    return acct;
  }

  async changePassword(acct, current, next) {
    if (!(await this.verifyHash(acct.hash, current))) throw new Error('Your current password is wrong');
    this.checkPassword(next);
    acct.hash = await this.hash(next);
    this.store.saveAccount(acct);
  }

  setPhoto(acct, dataUrl) {
    const m = typeof dataUrl === 'string' && dataUrl.match(PHOTO_RE);
    if (!m) throw new Error('Please choose a JPEG, PNG or WebP photo');
    const data = Buffer.from(m[2], 'base64');
    if (data.length > MAX_PHOTO_BYTES) throw new Error('Photo is too large');
    const type = `image/${m[1]}`;
    acct.photoV = crypto.createHash('sha1').update(data).digest('hex').slice(0, 10);
    this.store.saveAccount(acct);
    this.store.setPhoto(acct.key, data, type);
    this.cachePhoto(acct.key, { type, data });
    return acct;
  }

  removePhoto(acct) {
    acct.photoV = null;
    this.store.saveAccount(acct);
    this.store.delPhoto(acct.key);
    this.photos.delete(acct.key);
    return acct;
  }

  remove(key) {
    this.photos.delete(key);
    this.store.deleteAccount(key);
  }

  cachePhoto(key, photo) {
    this.photos.delete(key);
    this.photos.set(key, photo);
    if (this.photos.size > PHOTO_CACHE) this.photos.delete(this.photos.keys().next().value);
  }

  async photo(key) {
    const acct = this.store.allAccounts().get(key);
    if (!acct || !acct.photoV) return null;
    let p = this.photos.get(key);
    if (!p) { p = await this.store.getPhoto(key); if (p) this.cachePhoto(key, p); }
    return p;
  }
}

module.exports = Accounts;
