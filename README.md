# Your Day Diary — Social Media App

A full social app: login/register, profiles, an Instagram-style @username search,
a feed with posts (like, comment, share), follow/block, real-time chat with
online/offline status, group chats, voice/video calling (WebRTC), and a
settings page with 10 configurable features.

## Stack

Express + Socket.IO + **MySQL** (via `mysql2`) + JWT auth, all served from one
Node process. No separate SQLite files are used.

## Setup

1. **Install MySQL** (or have MySQL Workbench pointed at a running MySQL server).
2. **Create your `.env` file** from the template:
   ```bash
   cp .env.example .env
   ```
   Then edit `.env` and fill in your real `DB_PASSWORD` and a random `JWT_SECRET`.
   `.env` is git-ignored — it never gets committed.
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Run it**:
   ```bash
   npm start
   ```
   On first launch, `server.js` connects to MySQL, creates the `day_diary`
   database if it doesn't exist, and runs `schema.sql` to create all tables.

Then open **http://localhost:3000** in your browser. Open it in two different
browsers (or one normal + one incognito window) to test chat, calls, and
follow/like notifications between two accounts.

## Setting up the schema in MySQL Workbench (optional, manual way)

You don't have to do this by hand — `server.js` runs `schema.sql`
automatically on startup. But if you want to inspect/run it yourself in
Workbench first:

1. Open **MySQL Workbench** and connect to your local MySQL server.
2. **File → Open SQL Script…** and select `schema.sql` from this project.
3. Click the **lightning bolt (⚡ Execute)** icon to run the whole script.
4. In the left-hand **Schemas** panel, refresh — you should see a new
   `day_diary` schema with tables: `users`, `follows`, `posts`, `likes`,
   `comments`, `shares`, `groups`, `group_members`, `messages`, `blocks`.

## What's inside

- `server.js` — the entire backend: Express REST API, Socket.IO (chat,
  presence, WebRTC signaling), JWT auth, all in one file.
- `schema.sql` — the MySQL schema (users, posts, likes, comments, shares,
  follows, blocks, messages, groups, group_members). `server.js` runs this
  automatically on first launch against your MySQL server.
- `public/index.html` — the entire frontend: HTML + CSS + JS in one file
  (no build step, no framework). Talks to the API with `fetch` and to the
  server in real time with Socket.IO.
- `.env.example` — template for your local secrets. Copy to `.env` and fill
  in real values; never commit `.env` itself.

## Features checklist

- Login / register page
- Profile page (name, bio, avatar, edit profile)
- Posts ("my diary entries") with photo upload
- @username ID search, like Instagram
- Online/offline status, shown next to names everywhere
- Real-time chat: 1-on-1 DMs and group chats
- Voice & video calling (WebRTC, peer-to-peer)
- Like, comment, share on posts
- Follow / unfollow / block
- Group creation with multiple members
- Settings page with 10 toggleable features: private account, show online
  status, read receipts, who-can-message-you, email notifications, push
  notifications, dark mode, autoplay videos, two-factor auth toggle, language

## Notes / known limitations

- Images (avatars, post photos) are stored as base64 data URLs directly in
  MySQL for simplicity — fine for a demo, but swap in real file storage
  (S3, disk + multer) before using this with many users or large images.
- Set a real, random `JWT_SECRET` in `.env` before deploying anywhere public.
- Never commit `.env` or hardcode DB credentials in `server.js` — both are
  git-ignored / read from environment variables now.
- Calling uses a public STUN server only (no TURN), so it works well on the
  same network / most home connections but may fail across strict NATs.