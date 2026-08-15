# MeetRoom

A small web app for video/voice calls, group chat, and file/photo sharing —
built with plain Node.js + Express + Socket.io + WebRTC. Anyone with the
room code can join from a browser, no installs needed.

## How it works
- **Video/audio calls**: WebRTC, peer-to-peer mesh (each person connects
  directly to every other person in the room). Works well up to ~15 people
  on a decent connection. Beyond that, a mesh gets heavy on everyone's
  upload bandwidth — if you outgrow this, look into a media server like
  LiveKit or mediasoup, which route media through a central server instead.
- **Chat**: relayed through the server via Socket.io.
- **Files/photos**: sent in chunks through the server, then reassembled
  and offered as a download (or shown inline if it's an image).

## Run it locally
```bash
npm install
npm start
```
Then open `http://localhost:3000` in a couple of browser tabs (or on two
devices on the same network, using your computer's local IP instead of
`localhost`) to test a call between two people.

## Deploy it so others can join
**Important:** this app needs a server that stays running and keeps
persistent connections open (for Socket.io and WebRTC signaling). That
rules out Vercel's serverless functions — same class of issue as the
SQLite problem from before. Use a host with a normal long-running server
instead:

- **Render** (render.com) — free tier, easiest for this
- **Railway** (railway.app)
- **Fly.io**

Any of these: push this project to GitHub, connect the repo, set the
start command to `npm start`, and it'll be live on a public URL you can
share as your room link.

## Notes / things to harden later
- Camera/mic access requires HTTPS in production (all three hosts above
  give you HTTPS automatically) — `localhost` is exempt for local testing.
- There's no login/auth — anyone with the room code and link can join.
  Add a password step if you need that.
- File transfer currently holds the whole file in memory on both ends,
  which is fine for photos and typical documents but not huge video files.
