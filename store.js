'use strict';
/*
 * Where admin data lives (word filter, bans, anti-spam settings, appearance + uploaded images, rooms)
 * and registered user profiles (accounts + profile photos). Chats are never stored here.
 *
 *  - DATABASE_URL set  → PostgreSQL (e.g. Neon, Supabase, Render Postgres). Survives restarts and redeploys.
 *  - otherwise         → JSON files in data/ (fine locally or on a server with a persistent disk).
 *
 * Everything is loaded into memory once at startup, so reads are instant and synchronous; writes
 * go to the database in the background, in order. The database is only touched when something
 * changes, which lets serverless databases (Neon) sleep and stay within free-tier compute hours.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const KEYS = ['filters', 'bans', 'settings', 'theme', 'rooms'];
const BLOBS = ['hero', 'logo'];
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const TYPE = Object.fromEntries(Object.entries(EXT).map(([t, e]) => [e, t]));

class FileStore {
  constructor(dir) {
    this.dir = dir;
    this.kind = 'files';
    this.cache = new Map();
    this.blobs = new Map();
    this.accounts = new Map(); // username (lowercase) -> account
    this.accountsTimer = null;
  }

  async init() {
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(this.dir, 'accounts.json'), 'utf8')))) this.accounts.set(k, v); } catch {}
    for (const key of KEYS) {
      try { this.cache.set(key, JSON.parse(fs.readFileSync(path.join(this.dir, key + '.json'), 'utf8'))); } catch {}
    }
    for (const key of BLOBS) {
      for (const ext of Object.values(EXT)) {
        const file = path.join(this.dir, 'uploads', `${key}.${ext}`);
        if (fs.existsSync(file)) { this.blobs.set(key, { type: TYPE[ext], data: fs.readFileSync(file) }); break; }
      }
    }
  }

  describe() { return { kind: 'files', persistent: false, detail: `JSON files in ${path.relative(process.cwd(), this.dir) || '.'}` }; }
  get(key) { return this.cache.get(key); }

  set(key, value) {
    this.cache.set(key, value);
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, key + '.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
    fs.renameSync(file + '.tmp', file);
  }

  getBlob(key) { return this.blobs.get(key); }

  setBlob(key, data, type) {
    this.delBlob(key);
    this.blobs.set(key, { type, data });
    fs.mkdirSync(path.join(this.dir, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'uploads', `${key}.${EXT[type]}`), data);
  }

  delBlob(key) {
    this.blobs.delete(key);
    for (const ext of Object.values(EXT)) try { fs.unlinkSync(path.join(this.dir, 'uploads', `${key}.${ext}`)); } catch {}
  }

  // ---- registered accounts (all in accounts.json, written at most once a second) + photos in avatars/
  allAccounts() { return this.accounts; }
  saveAccount(acct) { this.accounts.set(acct.key, acct); this.writeAccountsSoon(); }
  deleteAccount(key) { this.accounts.delete(key); this.delPhoto(key); this.writeAccountsSoon(); }
  writeAccountsSoon() {
    if (this.accountsTimer) return;
    this.accountsTimer = setTimeout(() => this.writeAccounts(), 1000);
  }
  writeAccounts() {
    clearTimeout(this.accountsTimer); this.accountsTimer = null;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, 'accounts.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(Object.fromEntries(this.accounts)));
    fs.renameSync(file + '.tmp', file);
  }
  async getPhoto(key) {
    for (const ext of Object.values(EXT)) {
      try { return { type: TYPE[ext], data: await fs.promises.readFile(path.join(this.dir, 'avatars', `${key}.${ext}`)) }; } catch {}
    }
    return null;
  }
  setPhoto(key, data, type) {
    this.delPhoto(key);
    fs.mkdirSync(path.join(this.dir, 'avatars'), { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'avatars', `${key}.${EXT[type]}`), data);
  }
  delPhoto(key) {
    for (const ext of Object.values(EXT)) try { fs.unlinkSync(path.join(this.dir, 'avatars', `${key}.${ext}`)); } catch {}
  }

  async flush() { if (this.accountsTimer) this.writeAccounts(); }
}

class PgStore {
  constructor(url) {
    this.url = url;
    this.kind = 'postgres';
    this.cache = new Map();
    this.blobs = new Map();
    this.queue = Promise.resolve();
    this.lastError = null;
    this.accounts = new Map();
  }

  async init() {
    const { Pool } = require('pg');
    // SSL: the URL's own sslmode wins; hosts without a dot (localhost, Render's internal "dpg-…" names)
    // are on a private network; anything else on the internet gets verified TLS.
    let host = '';
    try { host = new URL(this.url).hostname; } catch {}
    const ssl = /[?&]sslmode=/.test(this.url) || !host.includes('.') || host === '127.0.0.1' ? undefined : { rejectUnauthorized: true };
    // Short idle timeout: connections close when unused, so serverless databases can go to sleep.
    this.pool = new Pool({ connectionString: this.url, max: 3, idleTimeoutMillis: 5000, connectionTimeoutMillis: 20000, allowExitOnIdle: true, ...(ssl ? { ssl } : {}) });
    this.pool.on('error', e => { this.lastError = e.message; console.warn('[store] database connection error:', e.message); });

    // The database may be waking up (Neon) or still starting: retry for up to a minute.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.pool.query(`CREATE TABLE IF NOT EXISTS chat_settings (
          key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
        await this.pool.query(`CREATE TABLE IF NOT EXISTS chat_files (
          key text PRIMARY KEY, content_type text NOT NULL, data bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
        await this.pool.query(`CREATE TABLE IF NOT EXISTS chat_accounts (
          username text PRIMARY KEY, data jsonb NOT NULL, photo bytea, photo_type text, updated_at timestamptz NOT NULL DEFAULT now())`);
        break;
      } catch (e) {
        if (attempt >= 6) throw new Error(`could not connect to the database: ${e.message}`);
        console.warn(`[store] database not ready (${e.message}); retrying…`);
        await new Promise(r => setTimeout(r, attempt * 2000));
      }
    }
    for (const row of (await this.pool.query('SELECT key, value FROM chat_settings')).rows) this.cache.set(row.key, row.value);
    for (const row of (await this.pool.query('SELECT key, content_type, data FROM chat_files')).rows) this.blobs.set(row.key, { type: row.content_type, data: row.data });
    for (const row of (await this.pool.query('SELECT username, data FROM chat_accounts')).rows) this.accounts.set(row.username, row.data);

    // First connection: copy anything already saved in local files into the database.
    const files = new FileStore(DATA_DIR);
    await files.init();
    const copied = [];
    for (const key of KEYS) if (!this.cache.has(key) && files.get(key) !== undefined) { this.set(key, files.get(key)); copied.push(key); }
    for (const key of BLOBS) if (!this.blobs.has(key) && files.getBlob(key)) { const b = files.getBlob(key); this.setBlob(key, b.data, b.type); copied.push(key + ' image'); }
    if (!this.accounts.size && files.allAccounts().size) {
      for (const acct of files.allAccounts().values()) {
        this.saveAccount(acct);
        const photo = await files.getPhoto(acct.key);
        if (photo) this.setPhoto(acct.key, photo.data, photo.type);
      }
      copied.push(`${files.allAccounts().size} accounts`);
    }
    await this.flush();
    if (copied.length) console.log(`[store] copied local settings into the database: ${copied.join(', ')}`);
  }

  describe() {
    let host = '';
    try { host = new URL(this.url).hostname; } catch {}
    return { kind: 'postgres', persistent: true, detail: `PostgreSQL at ${host}`, error: this.lastError };
  }

  get(key) { return this.cache.get(key); }

  write(label, sql, params) {
    this.queue = this.queue
      .then(() => this.pool.query(sql, params))
      .then(() => { this.lastError = null; })
      .catch(e => { this.lastError = e.message; console.error(`[store] could not save ${label}:`, e.message); });
    return this.queue;
  }

  set(key, value) {
    this.cache.set(key, value);
    this.write(key, `INSERT INTO chat_settings (key, value, updated_at) VALUES ($1, $2, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
  }

  getBlob(key) { return this.blobs.get(key); }

  setBlob(key, data, type) {
    this.blobs.set(key, { type, data });
    this.write(key + ' image', `INSERT INTO chat_files (key, content_type, data, updated_at) VALUES ($1, $2, $3, now())
      ON CONFLICT (key) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = now()`, [key, type, data]);
  }

  delBlob(key) {
    this.blobs.delete(key);
    this.write(key + ' image', 'DELETE FROM chat_files WHERE key = $1', [key]);
  }

  // ---- registered accounts: profile data cached in memory, photos fetched on demand
  allAccounts() { return this.accounts; }
  saveAccount(acct) {
    this.accounts.set(acct.key, acct);
    this.write('account', `INSERT INTO chat_accounts (username, data, updated_at) VALUES ($1, $2, now())
      ON CONFLICT (username) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [acct.key, JSON.stringify(acct)]);
  }
  deleteAccount(key) {
    this.accounts.delete(key);
    this.write('account', 'DELETE FROM chat_accounts WHERE username = $1', [key]);
  }
  async getPhoto(key) {
    await this.queue; // a photo saved a moment ago must be readable
    const r = await this.pool.query('SELECT photo, photo_type FROM chat_accounts WHERE username = $1 AND photo IS NOT NULL', [key]);
    return r.rows[0] ? { type: r.rows[0].photo_type, data: r.rows[0].photo } : null;
  }
  setPhoto(key, data, type) {
    this.write('profile photo', 'UPDATE chat_accounts SET photo = $2, photo_type = $3, updated_at = now() WHERE username = $1', [key, data, type]);
  }
  delPhoto(key) {
    this.write('profile photo', 'UPDATE chat_accounts SET photo = NULL, photo_type = NULL, updated_at = now() WHERE username = $1', [key]);
  }

  /** Wait for pending writes (used on shutdown). */
  async flush() { await this.queue; }
}

const store = process.env.DATABASE_URL ? new PgStore(process.env.DATABASE_URL) : new FileStore(DATA_DIR);
store.DATA_DIR = DATA_DIR;
store.EXT = EXT;
module.exports = store;
