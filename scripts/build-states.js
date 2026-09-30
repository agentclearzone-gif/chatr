'use strict';
/*
 * Builds geo-states.json: { "<country code>": ["State", ...] } for the login page's state dropdown.
 * Source: the country-state-city package (ISO 3166-2 subdivisions). Re-run after upgrading it:
 *   npm run build:states
 */
const fs = require('fs');
const path = require('path');
const { State } = require('country-state-city');

// Countries where the IP database reports a different level than the ISO list's first entries.
const OVERRIDES = {
  gb: ['England', 'Scotland', 'Wales', 'Northern Ireland'],
};
// Suffixes that only add noise in a dropdown ("Abu Dhabi Emirate" → "Abu Dhabi").
const TRIM_SUFFIX = / (Emirate)$/;

const out = {};
for (const s of State.getAllStates()) {
  const cc = s.countryCode.toLowerCase();
  (out[cc] = out[cc] || new Set()).add(s.name.replace(TRIM_SUFFIX, '').trim());
}
const result = {};
for (const cc of Object.keys(out).sort()) {
  result[cc] = OVERRIDES[cc] || [...out[cc]].sort((a, b) => a.localeCompare(b));
}
const file = path.join(__dirname, '..', 'geo-states.json');
fs.writeFileSync(file, JSON.stringify(result));
const total = Object.values(result).reduce((n, l) => n + l.length, 0);
console.log(`Wrote ${file}: ${Object.keys(result).length} countries, ${total} states, ${Math.round(fs.statSync(file).size / 1024)} KB`);
