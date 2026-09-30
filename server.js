'use strict';
/*
 * ArabianTalk entry point: loads the saved admin data (PostgreSQL when DATABASE_URL is set,
 * otherwise files in data/) and then starts the chat server in app-server.js.
 */
const store = require('./store.js');

store.init().then(
  () => {
    console.log(`[store] admin data: ${store.describe().detail}`);
    require('./app-server.js');
  },
  e => {
    // Don't start with empty settings — they could overwrite the real ones once saved.
    console.error(`[store] ${e.message}`);
    process.exit(1);
  },
);
