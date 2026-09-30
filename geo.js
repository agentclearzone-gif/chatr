'use strict';
/*
 * IP → country + state lookup using the free DB-IP "IP to City Lite" database (CC BY 4.0,
 * https://db-ip.com). The database is downloaded to data/ on first start and refreshed
 * monthly; lookups are in-memory and take microseconds, so nothing is sent to a third
 * party per visitor.
 *
 * The city database is ~130 MB in RAM. Set GEO_DB=country to use the 8 MB country-only
 * database instead (state detection is then off; people pick their state by hand).
 *
 * Detected state names are matched to the dropdown list in geo-states.json
 * (e.g. "Abu Dhabi Emirate", "Abu Dhabi" and "Abū Ẓaby" all match "Abu Dhabi").
 *
 * If TRUST_PROXY=1 and a CDN country header is present (Cloudflare, CloudFront, Vercel),
 * that header is used for the country.
 *
 * Visitors on the same machine or local network (127.0.0.1, 192.168.x.x, …) have no location of
 * their own; they share the server's internet connection, so its public IP is looked up instead.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { Reader } = require('mmdb-lib');
const STATES = require('./geo-states.json');

const MAX_AGE_MS = 35 * 24 * 3600 * 1000;
const CDN_HEADERS = ['cf-ipcountry', 'cloudfront-viewer-country', 'x-vercel-ip-country'];
const PUBLIC_IP_SERVICES = ['https://api.ipify.org', 'https://checkip.amazonaws.com', 'https://icanhazip.com'];

function isPrivate(ip) {
  ip = ip.replace(/^::ffff:/, '');
  if (ip === '::1' || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip)) return true;
  const m = ip.match(/^(\d+)\.(\d+)\./);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

// ---------- matching a detected region name to the dropdown list ----------
const GENERIC = new Set(['emirate', 'state', 'province', 'region', 'governorate', 'prefecture', 'oblast', 'county',
  'department', 'district', 'municipality', 'autonomous', 'republic', 'of', 'the', 'city', 'capital', 'territory',
  'federal', 'voivodeship', 'canton', 'krai', 'okrug', 'division', 'metropolitan', 'special', 'administrative']);
const WORD_FIX = { st: 'saint', ste: 'sainte', mt: 'mount' };
function normState(s) {
  const words = s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .map(w => WORD_FIX[w] || w);
  const core = words.filter(w => !GENERIC.has(w));
  return (core.length ? core : words).join(' ');
}
const sortedWords = n => n.split(' ').sort().join(' ');

// Names the IP database uses that differ from the list (English vs local names, pre-2016 French regions, …).
const ALIASES = {
  bg: { 'Sofia-grad': 'Sofia City Province' },
  bh: { Manama: 'Capital Governorate' },
  br: { 'Federal District': 'Distrito Federal' },
  ba: { 'Federation of B&H': 'Federation of Bosnia and Herzegovina' },
  ch: { 'Basel-City': 'Basel-Stadt' },
  cz: { Prague: 'Praha, Hlavní město' },
  de: { 'Rheinland-Pfalz': 'Rhineland-Palatinate', 'Nordrhein-Westfalen': 'North Rhine-Westphalia', Bayern: 'Bavaria',
    Hessen: 'Hesse', Niedersachsen: 'Lower Saxony', Sachsen: 'Saxony', 'Sachsen-Anhalt': 'Saxony-Anhalt', 'Thüringen': 'Thuringia' },
  dk: { 'Capital Region': 'Capital Region of Denmark', 'Central Jutland': 'Central Denmark Region', 'North Denmark': 'North Denmark Region',
    'South Denmark': 'Region of Southern Denmark', Zealand: 'Region Zealand' },
  fr: { Brittany: 'Bretagne', Normandy: 'Normandie', 'Upper Normandy': 'Normandie', 'Lower Normandy': 'Normandie', 'New Aquitaine': 'Nouvelle-Aquitaine',
    Aquitaine: 'Nouvelle-Aquitaine', Limousin: 'Nouvelle-Aquitaine', 'Poitou-Charentes': 'Nouvelle-Aquitaine', 'Rhône-Alpes': 'Auvergne-Rhône-Alpes',
    Auvergne: 'Auvergne-Rhône-Alpes', 'Midi-Pyrénées': 'Occitanie', 'Languedoc-Roussillon': 'Occitanie', Occitania: 'Occitanie',
    'Nord-Pas-de-Calais': 'Hauts-de-France', Picardy: 'Hauts-de-France', Lorraine: 'Grand-Est', 'Champagne-Ardenne': 'Grand-Est', 'Grand Est': 'Grand-Est',
    Burgundy: 'Bourgogne-Franche-Comté', 'Franche-Comté': 'Bourgogne-Franche-Comté', Centre: 'Centre-Val de Loire', Corsica: 'Corse',
    'Pays de la Loire': 'Pays-de-la-Loire', "Provence-Alpes-Côte d'Azur": 'Provence-Alpes-Côte-d’Azur' },
  it: { 'The Marches': 'Marche' },
  kw: { 'Al Asimah': 'Capital Governorate' },
  mk: { 'Grad Skopje': 'Greater Skopje' },
  mx: { 'Mexico City': 'Ciudad de México', 'México': 'Estado de México' },
  ph: { 'National Capital Region': 'Metro Manila' },
  pl: { Mazovia: 'Masovian Voivodeship', 'Lesser Poland': 'Lesser Poland Voivodeship', 'Greater Poland': 'Greater Poland Voivodeship',
    'Kujawsko-Pomorskie': 'Kuyavian-Pomeranian Voivodeship', 'Warmia-Masuria': 'Warmian-Masurian Voivodeship', Podlasie: 'Podlaskie Voivodeship' },
  ro: { 'București': 'Bucharest' },
  az: { Baki: 'Baku' },
  es: { 'Castille-La Mancha': 'Castilla La Mancha' },
  qa: { 'Baladiyat ad Dawhah': 'Doha' },
  sa: { 'Mecca Region': 'Makkah' },
  ua: { Odesa: 'Odeska oblast' },
  ru: { Primorye: 'Primorsky Krai', Kuzbass: 'Kemerovo Oblast', 'Udmurtiya Republic': 'Udmurt Republic', 'Altay Kray': 'Altai Krai',
    "Leningradskaya Oblast'": 'Leningrad Oblast', 'Khanty-Mansia': 'Khanty-Mansi Autonomous Okrug' },
  us: { 'Washington, D.C.': 'District of Columbia', 'Washington DC': 'District of Columbia' },
};
// Indonesian provinces are listed in Indonesian ("Jawa Barat"); the IP database uses English ("West Java").
const ID_DIR = { west: 'barat', east: 'timur', central: 'tengah', north: 'utara', south: 'selatan', southeast: 'tenggara' };
const ID_ISLAND = { java: 'jawa', sumatra: 'sumatera', kalimantan: 'kalimantan', sulawesi: 'sulawesi', papua: 'papua', 'nusa tenggara': 'nusa tenggara', maluku: 'maluku' };

const stateIndex = new Map(); // cc -> { list: [{ name, norm }], aliases: Map(norm -> name) }
function statesOf(cc) {
  if (!stateIndex.has(cc)) {
    const list = (STATES[cc] || []).map(name => ({ name, norm: normState(name) }));
    const aliases = new Map(Object.entries(ALIASES[cc] || {}).map(([k, v]) => [k.toLowerCase(), v]));
    stateIndex.set(cc, { list, aliases });
  }
  return stateIndex.get(cc);
}
function rewrite(cc, n) {
  let m;
  if (cc === 'kr' && (m = n.match(/^(\w+?)(nam|buk) do$/))) return `${m[2] === 'nam' ? 'south' : 'north'} ${m[1]}`; // Jeollanam-do → South Jeolla
  if (cc === 'id' && (m = n.match(/^(west|east|central|north|south|southeast) (.+)$/)) && ID_ISLAND[m[2]]) return `${ID_ISLAND[m[2]]} ${ID_DIR[m[1]]}`;
  if (cc === 'ee' && (m = n.match(/^(\w+)maa$/))) return m[1];                                              // Harjumaa → Harju
  if (cc === 'pl') return n.replace(/ia$/, 'ian');                                                              // Silesia → Silesian
  return n;
}
/** The dropdown entry for a detected region name, or '' if there's no confident match. */
function matchState(cc, detected) {
  if (!detected) return '';
  const { list, aliases } = statesOf(cc);
  const alias = aliases.get(detected.trim().toLowerCase());   // exact spelling from the IP database
  if (alias) return alias;
  const n = rewrite(cc, normState(detected));
  const compact = n.replace(/ /g, ''), sorted = sortedWords(n);
  const exact = list.find(s => s.norm === n || s.norm.replace(/ /g, '') === compact || sortedWords(s.norm) === sorted);
  if (exact) return exact.name;
  const pad = s => ` ${s} `;
  const partial = list.filter(s => pad(s.norm).includes(pad(n)) || pad(n).includes(pad(s.norm)));
  return partial.length === 1 ? partial[0].name : '';
}

class Geo {
  constructor({ dataDir, trustProxy, devIp }) {
    this.edition = process.env.GEO_DB === 'country' ? 'country' : 'city';
    this.file = path.join(dataDir, `dbip-${this.edition}-lite.mmdb`);
    this.trustProxy = trustProxy;
    this.devIp = devIp;          // used for loopback requests during local testing
    this.reader = null;
    this.serverIp = '';          // this machine's public IP, for local-network visitors
    this.warnedProxy = false;
    this.load();
    this.refreshIfStale();
    this.ready = this.findServerIp();
    setInterval(() => this.refreshIfStale(), 24 * 3600 * 1000).unref();
    setInterval(() => this.findServerIp(), 10 * 60 * 1000).unref();
  }

  async findServerIp() {
    for (const url of PUBLIC_IP_SERVICES) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        const ip = (await res.text()).trim();
        if (/^[0-9a-f.:]{3,45}$/i.test(ip) && !isPrivate(ip)) { this.serverIp = ip; return; }
      } catch {}
    }
  }

  load() {
    try {
      this.reader = new Reader(fs.readFileSync(this.file));
      console.log(`[geo] loaded ${path.basename(this.file)}`);
    } catch {
      this.reader = null;
    }
  }

  refreshIfStale() {
    let age = Infinity;
    try { age = Date.now() - fs.statSync(this.file).mtimeMs; } catch {}
    if (age < MAX_AGE_MS || this.downloading) return;
    this.downloading = true;
    downloadDb(path.dirname(this.file), this.edition)
      .then(buf => { this.reader = new Reader(buf); console.log(`[geo] loaded ${path.basename(this.file)}`); })
      .catch(e => console.warn(`[geo] could not download the IP database: ${e.message}. Location auto-detect is off until it succeeds.`))
      .finally(() => { this.downloading = false; });
  }

  /** Location for a request: { cc, state } — lowercase country code and a name from the state list ('' if unknown). */
  locate(req, ip) {
    let cc = '';
    if (this.trustProxy) {
      for (const h of CDN_HEADERS) {
        const v = (req.headers[h] || '').toString().trim().toLowerCase();
        if (/^[a-z]{2}$/.test(v) && v !== 'xx' && v !== 't1') { cc = v; break; }
      }
    }
    if (ip && isPrivate(ip) && !(this.devIp && /^(::ffff:)?127\.|^::1$/.test(ip))) {
      if (req.headers['x-forwarded-for'] && !this.trustProxy) {
        // Behind a reverse proxy we can't see the visitor's real IP; guessing would give everyone the server's location.
        if (!this.warnedProxy) { this.warnedProxy = true; console.warn('[geo] Requests come through a proxy. Set TRUST_PROXY=1 so visitors\' real IPs (and locations) are used.'); }
        return { cc, state: '' };
      }
      ip = this.serverIp;
    }
    const r = this.lookup(ip);
    if (!cc) cc = r.cc;
    return { cc, state: r.cc === cc ? r.state : '' };
  }

  /** Country only (used on every WebSocket connection). */
  country(req, ip) {
    return this.locate(req, ip).cc;
  }

  lookup(ip) {
    if (!this.reader || !ip) return { cc: '', state: '' };
    ip = ip.replace(/^::ffff:/, '');
    if (this.devIp && (ip === '127.0.0.1' || ip === '::1')) ip = this.devIp;
    try {
      const r = this.reader.get(ip);
      const cc = (r && r.country && r.country.iso_code || '').toLowerCase();
      const sub = r && r.subdivisions && r.subdivisions[0] && r.subdivisions[0].names && r.subdivisions[0].names.en;
      return { cc, state: cc ? matchState(cc, sub || '') : '', raw: sub || '' };
    } catch {
      return { cc: '', state: '' };
    }
  }
}

/** Download this month's DB-IP database into `dir`; returns the file contents once validated. */
async function downloadDb(dir, edition) {
  // DB-IP publishes one file per month; fall back to last month early in a new month.
  const now = new Date();
  const months = [0, 1].map(back => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
  const file = path.join(dir, `dbip-${edition}-lite.mmdb`);
  fs.mkdirSync(dir, { recursive: true });
  let lastErr;
  for (const m of months) {
    try {
      console.log(`[geo] downloading DB-IP ${edition} database ${m}…`);
      await fetchGzToFile(`https://download.db-ip.com/free/dbip-${edition}-lite-${m}.mmdb.gz`, file + '.tmp');
      const buf = fs.readFileSync(file + '.tmp');
      new Reader(buf); // validate before replacing the current file
      fs.renameSync(file + '.tmp', file);
      console.log(`[geo] downloaded DB-IP ${edition} database ${m} (${Math.round(buf.length / 1048576)} MB)`);
      return buf;
    } catch (e) { lastErr = e; }
  }
  try { fs.unlinkSync(file + '.tmp'); } catch {}
  throw lastErr;
}

// Streams straight to disk so a 130 MB database never sits in memory twice (small hosts have 512 MB).
function fetchGzToFile(url, dest, redirects = 3) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'chatr' }, timeout: 120000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchGzToFile(new URL(res.headers.location, url).href, dest, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const out = fs.createWriteStream(dest);
      res.pipe(zlib.createGunzip()).on('error', reject).pipe(out).on('finish', resolve).on('error', reject);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

Geo.STATES = STATES;
Geo.matchState = matchState;
Geo.downloadDb = downloadDb;
module.exports = Geo;
