# ArabianTalk

A fast, responsive, anonymous chatroom. It has a main room, private one-to-one chats and picture sharing. The user list shows gender, age, location and a country flag. The admin panel at `/admin` has a word filter, live conversation review and stats by country. Chat history is never written to disk. When a user disconnects, every conversation with them is deleted, including the copy moderators can see.

## Run

```bash
npm install
npm start            # http://localhost:3000
```

Node 18+ is required. On this Mac, Node is installed at `~/.local/node/bin`. To make it available in your shell, run:
`echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> ~/.zshrc`

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket port |
| `MAX_USERS` | `10000` | Hard cap on concurrent users |
| `MAX_PER_IP` | `20` | Connections allowed per IP (localhost is exempt) |
| `TRUST_PROXY` | off | Set `1` behind nginx or a load balancer so per-IP limits use `X-Forwarded-For` |
| `ADMIN_PASSWORD` | generated | Admin panel password. If not set, one is generated on first start and saved in `data/admin-password.txt` |
| `IMG_STORE_MB` | `300` | Memory set aside for pictures kept for moderator review. Beyond this, admins see a placeholder |
| `DATA_DIR` | `./data` | Where the word filter, bans and generated password are stored |
| `DATABASE_URL` | – | PostgreSQL connection string. When set, all admin data is saved in the database (see *Saving admin settings*) |
| `GEO_DB` | `city` | `country` uses the 8 MB country-only IP database (no state detection, ~120 MB less memory) |
| `GEO_LOCK` | off | Set `1` to lock each user's country to their IP location, so the dropdown is disabled and the server enforces it |
| `GEO_DEV_IP` | – | For local testing only: the IP to look up for requests from localhost, e.g. `193.99.144.80` → Germany |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | – | Use Cloudflare Turnstile as the bot check instead of the built-in puzzle |
| `CAPTCHA` | on | `off` disables the bot check completely (needed for `loadtest.js`) |
| `ALLOWED_ORIGIN` | any | e.g. `https://chat.example.com`, which rejects WebSocket connections from other sites |

## Features

- **User list** with a pink (female) or blue (male) avatar and row, `Name / 24 Yrs, Kansas, United States`, a red unread badge and the country flag. The list is virtualized, so it scrolls smoothly with 10,000 users. It has All/Female/Male tabs and search by name or location.
- **Main Room**: public chat. Messages are rate-limited to 1 per 2 seconds per user, with a burst of 4.
- **Private chat**: text, emoji and pictures, with a typing indicator, delivery-failure notices and a Block option.
- **Pictures** are resized to 1280px JPEG in the browser (typically 100–300 KB) and passed straight to the recipient. A copy stays in memory for moderators until the chat ends. Pictures are only allowed in private chats, because sending them to 7,000 people in the main room would use too much bandwidth.
- **No history on disk**: everything lives in memory. When a user leaves, closes the tab or loses connection, every client deletes its conversation with them. **Leave** or **✕** (close chat) also deletes your own copy.
- **Notification sound**: a short chime plays when a private message arrives, generated in the browser so there's no sound file. The 🔔/🔕 button next to *Leave* turns it off, and the choice is remembered.
- **Live typing** in private chats: the other person sees your text as you type it, shown as a dashed bubble with a blinking cursor. It's sent about 8 times a second, never stored, and never sent in the Main Room. Filtered words are masked in the preview too. A notice above the message box tells the person typing that it's on, with a one-click **Turn off**, after which the other person only sees "typing…". Admins can disable it for everyone on the Anti-spam page.
- **Responsive**: two panels on desktop. On a phone, the list and chat each fill the screen, with a back button.

## Country and state auto-detect

The login page asks `GET /geo` for the visitor's **country and state** and pre-selects both. The country shows with its flag, and a note under the form says "Detected from your IP: Dubai, United Arab Emirates". The **State / Region** dropdown lists every state of the chosen country, loaded per country from `GET /states?cc=ae`. If detection is wrong, the person picks the right one, and that correction is remembered in their browser for next time. The server only accepts a state from the chosen country's list, so the user list stays clean.

- **IP data:** the free **DB-IP City Lite** database (CC BY 4.0). The server downloads it (~60 MB compressed, ~130 MB in memory) to `data/` on first start and refreshes it monthly. Lookups happen in memory and take microseconds, and no outside service is called per visitor. On a small server, set `GEO_DB=country` to use the 8 MB country-only database instead; the state is then left for the person to pick.
- **State lists:** `geo-states.json` (4,700+ states and regions for 197 countries, from the `country-state-city` package). Rebuild it with `npm run build:states`. The UK is listed as England / Scotland / Wales / Northern Ireland, matching what the IP data reports. Small territories without states (e.g. Macau) hide the state box.
- **Matching:** detected region names are matched to the list, ignoring accents, word order and words like "Province". An alias table covers different spellings (e.g. "Mazovia" → "Masovian Voivodeship", "West Java" → "Jawa Barat", France's pre-2016 regions). On 60,000 random IPs, **98.4%** of detected regions matched a list entry: 100% for the US, UK, Germany, France, China, Japan and Korea. The rest (mostly Taiwan, which the IP data only labels "Taiwan") are left for the person to pick.
- Visitors on the same computer or local network as the server get the server's public-IP location. Behind a proxy, set `TRUST_PROXY=1`. The "IP Geolocation by DB-IP" credit on the login page is required by the license.
- The admin **Users** table shows each user's IP country flag and a **≠ IP** tag when their chosen country doesn't match.

## Saving admin settings (PostgreSQL or files)

Everything an admin changes is kept in `store.js`: the word filter, bans, anti-spam settings, rooms (with password hashes), and the appearance theme with uploaded pictures and logo. Chats are never saved.

- **`DATABASE_URL` set → PostgreSQL.** Two tables are created automatically: `chat_settings` (JSON values) and `chat_files` (uploaded images). Settings survive restarts and redeploys. That's what you want on Render's free plan, whose disk is wiped on every restart.
- **Not set → JSON files in `data/`** (local development, or a server with a persistent disk).
- Everything is loaded into memory at startup, so reading settings never waits for the database. Changes are written in the background, in order. The database is only touched when something changes (plus word-filter hit counts every 30 minutes), so a serverless database like Neon can sleep between admin actions and stay inside its free compute hours.
- **First connection:** any settings already in local `data/` files are copied into the database automatically.
- **If the database can't be reached at startup**, the server retries for about 30 seconds and then refuses to start, instead of starting with blank settings that could overwrite your real ones. The admin Overview shows where settings are saved, and flags database errors.

**Free PostgreSQL:** [Neon](https://neon.com) has a free plan that doesn't expire. Create a project, copy the connection string (it ends in `?sslmode=require`), and add it on Render as `DATABASE_URL`. Render's own free PostgreSQL also works, but it is deleted after 30 days.

## How users chat

- **1-to-1 mode by default:** after logging in, users aren't in any room. They tap someone in **People** to chat privately, and join group rooms from the **Rooms** tab if they want.
- **Sidebar tabs:** **People** (quick search plus an **All / ♀ Female / ♂ Male** filter) · **Rooms** · **Inbox** · **History** · **Search** · **Friends**, with unread badges.
- **Search:** find people online by username (partial match), gender (All / Female / Male) and country. The country list shows countries with people online first, with counts. Tap a result to start a private chat.
- **Inbox:** everyone who has messaged you this visit, newest first, with how many messages they sent, the last one, and unread ones highlighted.
- **History:** every chat from this visit, including people who have left. Those chats become read-only and are marked "left". Everything is deleted from the browser when *you* leave. Chats are never stored on the server, apart from the live moderation copy, which is deleted when either person leaves.

## Profiles (optional)

Guests can chat without signing up. On the login screen users can also **Log in** or **Create a profile**. Guests can create a profile mid-chat by tapping their name.
- A profile gives a **reserved username + password**, **saved details** (gender, age, country, state), an optional **photo** (cropped to 256 px) and **bio** (160 characters, word-filtered), and a **✓** badge next to their name. Others see the bio on a profile card when they open a chat with them.
- Users edit their profile and change their password by tapping their name.
- **Security:** passwords are salted scrypt hashes. Logging in to a username that doesn't exist takes as long as a wrong password. 8 wrong passwords per IP means a 15-minute wait. At most 3 new profiles per IP per hour, and sign-ups need the bot check. A profile can't be logged in twice at once, and guests can't use a registered name.
- **Storage:** the `chat_accounts` table (PostgreSQL) or `data/accounts.json` plus `data/avatars/`. **On Render's free plan, set `DATABASE_URL`, or all profiles are lost when the server restarts.**
- **Friends:** registered users can add each other as friends. Open a chat with a ✓ profile and tap **＋ Add friend**. The other person gets a request (toast, sound and a badge on the ❤ **Friends** tab) and can accept or decline; mutual requests become friends instantly. The Friends tab lists requests, online friends (with a green dot, tap to chat), offline friends, and sent requests. Friends get a ❤ in the People list. Friendships are saved with the profiles (up to 500 friends and 100 pending requests, rate-limited). Guests are invited to create a profile.
- **Admin → Accounts:** search profiles, remove a photo, clear a bio, or delete an account (if they're online, the user is removed from the chat).

## Rooms (Admin → # Rooms)

- **Create, edit, reorder and delete rooms.** Each room has a name, an optional description and an optional **password**.
- **Password-protected rooms** show a 🔒 in the room list. Users must enter the password to join; the server checks it. Passwords are stored as salted scrypt hashes in `data/rooms.json`, never in plain text. Password checks run off the main thread, so guessing can't slow the chat down. Wrong guesses are rate-limited (5 tries, then one every 10 seconds), and hammering past that counts as a spam strike.
- **Changing a room's password** doesn't remove people already inside; it applies to new joiners. **Deleting a room** removes everyone in it, with a notice, and clears its messages from the moderation log.
- Users join rooms themselves from the Rooms tab (nobody is put in a room automatically). Use ↑ ↓ to set the order rooms are listed in.
- Users see all rooms in the sidebar with live member counts and unread badges, can be in several rooms at once, and can leave any room. Room messages are sent **only to that room's members**, so extra rooms don't slow anything down at 7,000 users.
- The room message log (moderation) has a room filter.
- **Chat on/off per room:** the Chat column toggles whether anyone can post in that room. When it's off, people can still be in the room, but the message box is disabled with a notice. Private messages still work, and the server enforces it.
- **Room flood limit** (Admin → Anti-spam): the most messages one user can post in rooms in any 30 seconds (default 6, across all rooms). Going over is refused with a wait time and counts as a spam strike.

## Appearance (Admin → 🎨 Appearance)

The default look is **Dubai Gold**: a cream background with an Arabic geometric pattern, a gold dome logo, a two-tone "Arabian**Talk**" wordmark, a Dubai skyline in the corner of the login card, gold icon badges and a gold gradient button. The chat screens use the same accent color.

Everything is editable from the admin panel, with a live phone preview:
- **Color presets:** Dubai Gold, Rose, Emerald Oasis, Royal Blue, Desert Rose. You can also set your own main color, dark shade, page and card backgrounds, and text colors. It warns you if the main color is too light for white button text.
- **Texts:** site name (plain part + colored part), tagline, login description and button text.
- **Images:** upload your own corner picture and logo (PNG, JPEG or WebP; resized in the browser before upload; max 4 MB), or switch back to the defaults. SVG uploads are refused because they can contain scripts. You can also turn the corner picture and background pattern on or off.

Settings are saved in `data/theme.json` and images in `data/uploads/`. The server writes them into the login page itself, so visitors never see the old look flash first. The default skyline (`public/hero-dubai.svg`) is an original illustration.

## Anti-spam and bot protection

All settings are on the admin **🛡️ Anti-spam** page, take effect immediately, and are saved in `data/settings.json`.

**At login, bots are stopped by:**
- **Built-in invisible bot check (default).** The browser solves a small SHA-256 proof-of-work puzzle in a background thread while the person fills in the form. It takes about 0.2s on a laptop and under a second on a phone, and people never see it. Bots must spend CPU for every account. Puzzles are signed, expire after 2 minutes, and work only once. An IP that requests many puzzles automatically gets harder ones, up to 64× harder.
- **Cloudflare Turnstile (recommended for production).** Create a free widget at dash.cloudflare.com → Turnstile, then set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`. It is much stronger against bot farms and usually invisible to people.
- **A hidden trap field** that people never see but form-filling bots do.

**In chat, spam is stopped by:**
- **Links:** blocked in the Main Room by default. They can be allowed everywhere or blocked everywhere.
- **Repeats:** sending the same message again within 60s is blocked. Short replies like "ok" are allowed.
- **New-user wait:** new users wait 20s before posting in the Main Room, which stops join-and-spam bots. Private chat works right away.
- **Mass messaging:** at most 8 new private chats per minute.
- The existing flood limits and word filter.

**Strikes:** every violation is a strike, and strikes fade at 1 per minute. At 5 strikes the user is muted for 5 minutes. Messages sent while muted also count, so at 10 strikes the user is kicked and banned for 10 minutes (the ban shows in **Bans**). The Users table shows each user's strikes and mute status.

## Admin panel — `http://localhost:3000/admin`

Sign in with `ADMIN_PASSWORD` (or the password in `data/admin-password.txt`). The panel updates every 4 seconds.

- **Overview**: online now, peak, joins, message counts, filtered-message counts and kicks/bans. It also has an online-users-over-time chart (last 24 hours), a **users-by-country table** (online, female/male split, average age, joins since start), and gender and age-group charts. Clicking a country opens its user list.
- **Conversations**: every private chat happening right now. Search by username, show only flagged chats, and read the full transcript, including pictures, blocked messages and the original text behind masked words. Each participant has Kick/Ban buttons.
- **Main Room**: the last 500 room messages, with search and a "filtered only" view.
- **Users**: search by name, location or IP, filter by country or gender, see each user's time online, message count and chats, and kick or ban them.
- **Word filter**: add words or phrases (paste many at once, separated by commas), choose *whole word* or *anywhere*, and *mask with \*\*\*\** or *block the message*. Changes take effect immediately and are saved in `data/filters.json`. A tester box shows exactly what users would see, and each word shows how many times it was caught. The filter also applies to usernames and locations.
- **Bans**: bans by IP address and browser for 1 hour up to permanent, shown to the user with your reason. Unban from the list. Saved in `data/bans.json`.

Security: the password is checked in constant time, and failed logins are limited to 8 per 15 minutes per IP. Sessions use an HttpOnly, SameSite=Strict cookie with a 12-hour sliding expiry. Changes require an `X-Admin` header, which protects against CSRF. **Serve `/admin` over HTTPS in production**, and consider limiting it to your IP in nginx.

**Privacy:** moderators can read private chats while they are live, and the login screen says so. If you operate in the EU or UK (GDPR) or California (CCPA), also add a privacy policy covering this.

## How it handles 5,000–7,000 users

- A single Node process uses raw WebSockets (`ws`) with per-message compression turned off. Compression costs a lot of CPU and around 300 KB of RAM per socket.
- **Batched fan-out**: joins, leaves and main-room messages are collected and sent to everyone every 60 ms. Each broadcast is converted to a Buffer once and reused for all 7,000 sockets. Without batching, 7,000 people reconnecting at once would cause about 49 million sends; with it, there is one broadcast per tick.
- New users get a cached snapshot of the user list, rebuilt at most once per tick, followed by small join/leave updates.
- Slow clients (more than 2 MB waiting to be sent) are skipped instead of letting server memory grow. Dead connections are found with a ping every 25 seconds.
- There are rate limits per user for room messages, private messages, pictures and typing notices. Input is validated, and messages are shown as plain text, so they can't inject HTML.

### Load test result (MacBook i7, server and 7,000 clients on the same laptop, moderation and a 200-word filter on)

```
users connected: 7000/7000, failed: 0      server RSS ≈ 210 MB
room message latency     p50=49–58ms  p99=257–445ms   (includes the 60ms batch window)
private message latency  p50=4–6ms    p99=223–410ms   (~750 private msgs/sec + 280 room talkers)
admin overview API with 7,000 online: ~2ms
```

To reproduce it, start the server with `CAPTCHA=off node server.js`, then run `node loadtest.js 7000`. First raise the file limit with `ulimit -n 65536`. macOS defaults to 256.

## Updates and caching

At startup the server gives every script and stylesheet a content hash (`/app.js?v=3f2a…`). Browsers cache these files permanently and pick up changed files as soon as you restart after a deploy, so nobody gets stale code. HTML pages are revalidated with an ETag, which usually returns a tiny 304 response.

## Production notes

- Put it behind nginx or Caddy for HTTPS (`wss://`) and set `TRUST_PROXY=1`. Allow WebSocket upgrades on `/ws` and set `proxy_read_timeout` to at least 60s.
- Raise the OS file limit on the server (e.g. `LimitNOFILE=65536` in systemd).
- 7,000 users fit comfortably on one small VPS (1–2 vCPU, 1 GB RAM). Going well past about 20,000 would need several processes sharing presence and room messages through Redis pub/sub. Private messages would then be routed by user ID.
- Flags are loaded from `flagcdn.com`. To self-host them, copy the PNGs into `public/` and change `flagUrl` in `app.js`.
