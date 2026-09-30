'use strict';
/*
 * Downloads the IP-location database ahead of time (used as a build step on Render and similar
 * hosts), so the server has it immediately when it starts or wakes up instead of downloading it then.
 *   npm run fetch:geo
 */
const path = require('path');
const Geo = require('../geo.js');

const dir = process.env.GEO_DIR || path.join(__dirname, '..', 'data');
const edition = process.env.GEO_DB === 'country' ? 'country' : 'city';
Geo.downloadDb(dir, edition).then(
  () => process.exit(0),
  e => { console.warn(`[geo] download failed (${e.message}); the server will retry when it starts.`); process.exit(0); },
);
