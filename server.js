/* ============================================================
   YOUR DAY DIARY — Social Media App Backend (single file)
   Stack: Express + Socket.IO + MySQL (mysql2) + JWT auth + Multer
   Run:   npm install
          node server.js
   Then open http://localhost:3000

   Configure your MySQL connection with environment variables
   (or just edit the defaults below):
     DB_HOST (default: localhost)
     DB_PORT (default: 3306)
     DB_USER (default: root)
     DB_PASSWORD (default: '')
     DB_NAME (default: day_diary)

   ---- PERFORMANCE NOTES (why this version is fast) ----
   1. Photos are uploaded as files (multer) and stored on disk
      under /public/uploads, referenced by a short URL. The old
      version stored full base64 images/videos as LONGTEXT inside
      every API response — that's what made the feed, chat, and
      profile pages slow to load, especially on phones.
   2. Video support has been removed entirely (per request). Video
      was the single biggest source of huge payloads.
   3. Feed/profile post queries were rewritten from N+1 per-post
      lookups into single JOIN + subquery-count queries.
   4. Feed is paginated (cursor-based, 20 posts per page) with
      infinite scroll instead of loading up to 100 posts at once.
   5. Indexes were added for every hot lookup path (posts by user,
      likes/comments/shares by post, messages by conversation).
   ============================================================ */

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const multer = require('multer');
const { Server } = require('socket.io');

// web-push is optional — if it isn't installed or VAPID keys aren't
// configured, real mobile push notifications are simply disabled and
// the app falls back to in-app/socket notifications only.
let webpush = null;
try { webpush = require('web-push'); } catch (e) { webpush = null; }

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'day-diary-dev-secret-change-me';

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'day_diary',
  waitForConnections: true,
  connectionLimit: 10,
  ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {})
};

if (!process.env.DB_PASSWORD) {
  console.warn('⚠️  DB_PASSWORD is not set — using an empty password. Create a .env file (see .env.example).');
}
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET is not set — using the insecure default. Set it in .env before deploying.');
}

// ---------------------------------------------------------------
// WEB PUSH (real mobile notifications, even when the app/tab is
// closed). Generate a key pair once with:
//   npx web-push generate-vapid-keys
// then set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT in
// your .env. Without these, push is silently disabled.
// ---------------------------------------------------------------
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const PUSH_ENABLED = !!(webpush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (webpush && PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('Web push notifications: enabled.');
} else {
  console.warn('⚠️  Web push notifications are disabled (missing the web-push package or VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY in .env). Mobile users will only get notifications while the app is open in front of them.');
}

let pool;

// ---------------------------------------------------------------
// UPLOADS — photos are saved to disk instead of shipped as base64
// inside JSON. Only image mimetypes are accepted (video removed).
// ---------------------------------------------------------------
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
      const safeExt = /^\.(jpe?g|png|webp|gif)$/.test(ext) ? ext : '.jpg';
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt}`);
    }
  }),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB per photo
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) return cb(new Error('Only photo uploads (jpeg/png/webp/gif) are allowed.'));
    cb(null, true);
  }
});

// ---------------------------------------------------------------
// DB SETUP — connects, creates the database if missing, then
// runs schema.sql (safe to run every time; skips existing tables
// and ignores "index already exists" on repeat runs).
// ---------------------------------------------------------------
async function setupDatabase() {
  const rootConn = await mysql.createConnection({
    host: DB_CONFIG.host, port: DB_CONFIG.port, user: DB_CONFIG.user, password: DB_CONFIG.password,
    multipleStatements: true,
    ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {})
  });
  await rootConn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_CONFIG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  await rootConn.end();

  pool = mysql.createPool(DB_CONFIG);

  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = schemaSql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length && !s.toUpperCase().startsWith('CREATE DATABASE') && !s.toUpperCase().startsWith('USE '));

  const conn = await pool.getConnection();
  try {
    for (const stmt of statements) {
      try {
        await conn.query(stmt);
      } catch (err) {
        // Ignore "duplicate index" (1061) and "duplicate key name" errors on repeat runs
        if (err.errno === 1061) continue;
        throw err;
      }
    }
  } finally {
    conn.release();
  }

  // ---- lightweight migrations for installs created before this update ----
  // media_type is retained but only ever 'image' or 'none' now (video removed).
  await migrateColumn('posts', 'media_type', "VARCHAR(10) NOT NULL DEFAULT 'none'");
  await migrateColumn('messages', 'media', 'LONGTEXT NULL');
  await migrateColumn('messages', 'media_type', "VARCHAR(10) NOT NULL DEFAULT 'none'");
  await migrateColumn('messages', 'shared_post_id', 'INT NULL');
  await migrateColumn('messages', 'deleted_for', 'VARCHAR(50) NULL'); // csv of user ids who cleared this thread
  await migrateColumn('group_members', 'is_admin', 'TINYINT(1) NOT NULL DEFAULT 0');
  await migrateColumn('groups', 'photo', 'LONGTEXT NULL');
  await migrateColumn('groups', 'description', 'VARCHAR(500) NULL');

  // push_subscriptions may not exist on installs created before push
  // support was added — create it here too, so upgrades don't need
  // a manual migration step.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      endpoint VARCHAR(1000) NOT NULL,
      keys_json TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_sub (user_id, endpoint(255)),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `).catch((err) => { if (err.errno !== 1061) throw err; });

  console.log('Database ready (day_diary).');
}

async function migrateColumn(table, column, definition) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) c FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
    [DB_CONFIG.database, table, column]
  );
  if (rows[0].c === 0) {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
}

function q(sql, params = []) { return pool.query(sql, params); }
async function run(sql, params = []) {
  const [result] = await pool.query(sql, params);
  return { lastID: result.insertId, changes: result.affectedRows };
}
async function get(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows[0];
}
async function all(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

const DEFAULT_SETTINGS = {
  privateAccount: false,
  showOnlineStatus: true,
  readReceipts: true,
  allowMessagesFrom: 'everyone',
  darkMode: true,
  emailNotifications: true,
  pushNotifications: true,
  notificationSound: true,          // ringtone/beep on new message, call, notification
  twoFactorAuth: false,
  language: 'en',
  autoplayVideos: true,             // kept for backward compatibility, unused (video removed)
  showActivityStatus: true,
  hideLikeCounts: false,
  allowTagging: true,
  allowSharingOfMyPosts: true,
  dataSaver: false,
  // ---- Premium / professional settings ----
  accountType: 'free',              // 'free' | 'premium'
  accentColor: '#0095f6',
  proBadge: true,                   // show a badge on premium profiles
  priorityInbox: false,             // premium: sort DMs from followers first
  customStatus: '',                 // premium: short status line on profile
  // ---- per-user mute lists (client enforces silence for these) ----
  mutedConversations: [],
  mutedGroups: []
};

function parseSettings(row) {
  if (!row) return { ...DEFAULT_SETTINGS };
  if (row.settings == null) return { ...DEFAULT_SETTINGS };
  const raw = typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings;
  return { ...DEFAULT_SETTINGS, ...raw };
}

// ---------------------------------------------------------------
// APP + SOCKET SETUP
// ---------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '2mb' })); // no more base64 media in JSON bodies
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '30d',       // aggressively cache uploaded photos + static assets
  etag: true
}));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 2 * 1024 * 1024
});

// userId -> Set of socket ids (multiple tabs/devices)
const onlineUsers = new Map();

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function publicUser(row) {
  if (!row) return null;
  const settings = parseSettings(row);
  return {
    id: row.id, username: row.username, name: row.name, bio: row.bio,
    avatar: row.avatar, isOnline: !!onlineUsers.get(row.id)?.size && settings.showOnlineStatus,
    lastSeen: settings.showActivityStatus ? row.last_seen : null, createdAt: row.created_at,
    accountType: settings.accountType, proBadge: settings.accountType === 'premium' && settings.proBadge,
    accentColor: settings.accentColor, customStatus: settings.accountType === 'premium' ? settings.customStatus : ''
  };
}

// ---------------------------------------------------------------
// PUSH NOTIFICATIONS — send a real OS-level push to every device
// a user has subscribed on. Silently a no-op if push isn't
// configured, the user has pushNotifications off, or has no
// subscriptions (e.g. hasn't granted permission on any device).
// ---------------------------------------------------------------
async function sendPushToUser(userId, { title, body, tag, url }) {
  if (!PUSH_ENABLED) return;
  try {
    const user = await get('SELECT settings FROM users WHERE id = ?', [userId]);
    const settings = parseSettings(user);
    if (!settings.pushNotifications) return;
    const subs = await all('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId]);
    if (!subs.length) return;
    const payload = JSON.stringify({ title, body, tag, url: url || '/' });
    await Promise.all(subs.map(async (s) => {
      try {
        const subscription = { endpoint: s.endpoint, keys: JSON.parse(s.keys_json || '{}') };
        await webpush.sendNotification(subscription, payload);
      } catch (err) {
        // 404/410 = the subscription is gone (uninstalled, expired, etc.) — clean it up.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await run('DELETE FROM push_subscriptions WHERE id = ?', [s.id]);
        }
      }
    }));
  } catch (err) {
    console.error('Push send failed:', err.message);
  }
}

// ---------------------------------------------------------------
// PUSH SUBSCRIPTION ROUTES
// ---------------------------------------------------------------
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: PUSH_ENABLED ? VAPID_PUBLIC_KEY : null });
});

app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: 'Push notifications are not configured on this server.' });
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid push subscription.' });
  await run(
    'INSERT INTO push_subscriptions (user_id, endpoint, keys_json) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE keys_json = VALUES(keys_json)',
    [req.user.id, sub.endpoint, JSON.stringify(sub.keys || {})]
  );
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', authMiddleware, async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) await run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [req.user.id, endpoint]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// UPLOAD ROUTE — photos only. Returns a short URL to store on a
// post/message/profile instead of embedding base64 everywhere.
// ---------------------------------------------------------------
app.post('/api/upload', authMiddleware, (req, res) => {
  upload.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
    if (!req.file) return res.status(400).json({ error: 'No photo received.' });
    res.json({ url: `/uploads/${req.file.filename}` });
  });
});

// ---------------------------------------------------------------
// AUTH ROUTES
// ---------------------------------------------------------------
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, name } = req.body;
    if (!username || !email || !password || !name) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (!/^[a-zA-Z0-9_.]{3,20}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-20 chars: letters, numbers, _ or .' });
    }
    const existing = await get('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
    if (existing) return res.status(409).json({ error: 'Username or email already taken.' });

    const hash = await bcrypt.hash(password, 10);
    const result = await run(
      'INSERT INTO users (username, email, password_hash, name, settings) VALUES (?, ?, ?, ?, ?)',
      [username, email, hash, name, JSON.stringify(DEFAULT_SETTINGS)]
    );
    const token = jwt.sign({ id: result.lastID, username }, JWT_SECRET, { expiresIn: '30d' });
    const user = await get('SELECT * FROM users WHERE id = ?', [result.lastID]);
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await get('SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
    if (!user) return res.status(401).json({ error: 'Invalid username or password.' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// ---------------------------------------------------------------
// PROFILE + SETTINGS
// ---------------------------------------------------------------
app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json({ ...publicUser(user), settings: parseSettings(user) });
});

app.get('/api/users/:username', authMiddleware, async (req, res) => {
  const user = await get('SELECT * FROM users WHERE username = ?', [req.params.username]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const followers = await get('SELECT COUNT(*) c FROM follows WHERE following_id = ?', [user.id]);
  const following = await get('SELECT COUNT(*) c FROM follows WHERE follower_id = ?', [user.id]);
  const postCount = await get('SELECT COUNT(*) c FROM posts WHERE user_id = ?', [user.id]);
  const isFollowing = await get('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?', [req.user.id, user.id]);
  const isBlocked = await get('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [req.user.id, user.id]);
  res.json({
    ...publicUser(user),
    followers: followers.c, following: following.c, postCount: postCount.c,
    isFollowing: !!isFollowing, isBlocked: !!isBlocked, isMe: user.id === req.user.id
  });
});

app.put('/api/profile', authMiddleware, async (req, res) => {
  const { name, bio, avatar } = req.body;
  await run('UPDATE users SET name = COALESCE(?, name), bio = COALESCE(?, bio), avatar = COALESCE(?, avatar) WHERE id = ?',
    [name ?? null, bio ?? null, avatar ?? null, req.user.id]);
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json(publicUser(user));
});

app.put('/api/settings', authMiddleware, async (req, res) => {
  const user = await get('SELECT settings FROM users WHERE id = ?', [req.user.id]);
  const current = parseSettings(user);
  const merged = { ...current, ...req.body };
  await run('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify(merged), req.user.id]);
  res.json(merged);
});

app.get('/api/blocked', authMiddleware, async (req, res) => {
  const rows = await all(
    `SELECT users.* FROM users JOIN blocks ON blocks.blocked_id = users.id WHERE blocks.blocker_id = ?`,
    [req.user.id]
  );
  res.json(rows.map(publicUser));
});

app.get('/api/search', authMiddleware, async (req, res) => {
  const term = (req.query.q || '').trim();
  if (!term) return res.json([]);
  const like = `%${term}%`;
  const startsWith = `${term}%`;
  const rows = await all(
    `SELECT * FROM users WHERE (username LIKE ? OR name LIKE ?) AND id != ?
     ORDER BY (username LIKE ?) DESC, (name LIKE ?) DESC, username ASC
     LIMIT 20`,
    [like, like, req.user.id, startsWith, startsWith]
  );
  res.json(rows.map(publicUser));
});

// ---------------------------------------------------------------
// FOLLOW SYSTEM
// ---------------------------------------------------------------
app.post('/api/follow/:userId', authMiddleware, async (req, res) => {
  const targetId = Number(req.params.userId);
  if (targetId === req.user.id) return res.status(400).json({ error: "You can't follow yourself." });
  await run('INSERT IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)', [req.user.id, targetId]);
  io.to(`user:${targetId}`).emit('notification', { type: 'follow', from: req.user });
  sendPushToUser(targetId, { title: 'New follower', body: `${req.user.username} started following you.`, tag: 'follow-' + req.user.id, url: '/' });
  res.json({ ok: true });
});

app.post('/api/unfollow/:userId', authMiddleware, async (req, res) => {
  await run('DELETE FROM follows WHERE follower_id = ? AND following_id = ?', [req.user.id, Number(req.params.userId)]);
  res.json({ ok: true });
});

app.post('/api/block/:userId', authMiddleware, async (req, res) => {
  const targetId = Number(req.params.userId);
  await run('INSERT IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)', [req.user.id, targetId]);
  await run('DELETE FROM follows WHERE (follower_id = ? AND following_id = ?) OR (follower_id = ? AND following_id = ?)',
    [req.user.id, targetId, targetId, req.user.id]);
  res.json({ ok: true });
});

app.post('/api/unblock/:userId', authMiddleware, async (req, res) => {
  await run('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [req.user.id, Number(req.params.userId)]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// POSTS / FEED / LIKES / COMMENTS / SHARES
// (images only — video support removed for speed)
// ---------------------------------------------------------------
function detectMediaType(dataUrlOrPath) {
  return dataUrlOrPath ? 'image' : 'none';
}

// Single JOIN + correlated-subquery query instead of N+1 per-post
// round trips. This is the main fix for the slow-loading feed.
// `viewerId` is also used to enforce private accounts: a private
// author's posts are only included for the author themself or an
// accepted follower.
async function fetchPostsFast({ where, params, viewerId, limit, before }) {
  const clauses = [where];
  const values = [...params];
  if (before) {
    clauses.push('posts.id < ?');
    values.push(before);
  }
  // Private-account guard: hide posts from private authors unless the
  // viewer is the author or already follows them.
  clauses.push(`(
    posts.user_id = ?
    OR COALESCE(JSON_EXTRACT(users.settings, '$.privateAccount'), false) = false
    OR EXISTS(SELECT 1 FROM follows WHERE follows.follower_id = ? AND follows.following_id = posts.user_id)
  )`);
  values.push(viewerId, viewerId);
  const sql = `
    SELECT posts.id, posts.content, posts.image, posts.media_type, posts.created_at, posts.user_id,
           users.username, users.name, users.bio, users.avatar, users.settings AS author_settings,
           users.last_seen, users.created_at AS author_created_at,
           (SELECT COUNT(*) FROM likes WHERE likes.post_id = posts.id) AS likeCount,
           (SELECT COUNT(*) FROM comments WHERE comments.post_id = posts.id) AS commentCount,
           (SELECT COUNT(*) FROM shares WHERE shares.post_id = posts.id) AS shareCount,
           EXISTS(SELECT 1 FROM likes WHERE likes.post_id = posts.id AND likes.user_id = ?) AS likedByMe
    FROM posts
    JOIN users ON users.id = posts.user_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY posts.id DESC
    LIMIT ?`;
  const rows = await all(sql, [viewerId, ...values, limit]);
  return rows.map(p => {
    const authorSettings = parseSettings({ settings: p.author_settings });
    const author = publicUser({
      id: p.user_id, username: p.username, name: p.name, bio: p.bio, avatar: p.avatar,
      settings: p.author_settings, last_seen: p.last_seen, created_at: p.author_created_at
    });
    return {
      id: p.id, content: p.content, image: p.image,
      mediaType: p.media_type || detectMediaType(p.image),
      createdAt: p.created_at,
      author,
      likeCount: authorSettings.hideLikeCounts && p.user_id !== viewerId ? null : p.likeCount,
      commentCount: p.commentCount, shareCount: p.shareCount,
      likedByMe: !!p.likedByMe,
      allowSharing: authorSettings.allowSharingOfMyPosts !== false || p.user_id === viewerId
    };
  });
}

app.get('/api/feed', authMiddleware, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const before = req.query.before ? Number(req.query.before) : null;
  const posts = await fetchPostsFast({
    where: `(user_id = ? OR user_id IN (SELECT following_id FROM follows WHERE follower_id = ?))`,
    params: [req.user.id, req.user.id],
    viewerId: req.user.id, limit, before
  });
  res.json({ posts, hasMore: posts.length === limit });
});

app.get('/api/users/:username/posts', authMiddleware, async (req, res) => {
  const user = await get('SELECT id FROM users WHERE username = ?', [req.params.username]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const limit = Math.min(Number(req.query.limit) || 30, 60);
  const before = req.query.before ? Number(req.query.before) : null;
  const posts = await fetchPostsFast({
    where: `user_id = ?`, params: [user.id], viewerId: req.user.id, limit, before
  });
  res.json({ posts, hasMore: posts.length === limit });
});

app.post('/api/posts', authMiddleware, async (req, res) => {
  const { content, image } = req.body;
  if (!content && !image) return res.status(400).json({ error: 'Post needs text or a photo.' });
  const type = detectMediaType(image);
  const result = await run('INSERT INTO posts (user_id, content, image, media_type) VALUES (?, ?, ?, ?)',
    [req.user.id, content || '', image || '', type]);
  const posts = await fetchPostsFast({ where: 'posts.id = ?', params: [result.lastID], viewerId: req.user.id, limit: 1 });
  res.json(posts[0]);
});

app.delete('/api/posts/:id', authMiddleware, async (req, res) => {
  const post = await get('SELECT * FROM posts WHERE id = ?', [req.params.id]);
  if (!post || post.user_id !== req.user.id) return res.status(403).json({ error: 'Not allowed.' });
  await run('DELETE FROM posts WHERE id = ?', [req.params.id]);
  if (post.image && post.image.startsWith('/uploads/')) {
    fs.unlink(path.join(__dirname, 'public', post.image), () => {});
  }
  res.json({ ok: true });
});

app.post('/api/posts/:id/like', authMiddleware, async (req, res) => {
  const postId = req.params.id;
  const existing = await get('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?', [postId, req.user.id]);
  if (existing) {
    await run('DELETE FROM likes WHERE post_id = ? AND user_id = ?', [postId, req.user.id]);
  } else {
    await run('INSERT INTO likes (post_id, user_id) VALUES (?, ?)', [postId, req.user.id]);
    const post = await get('SELECT user_id FROM posts WHERE id = ?', [postId]);
    if (post) {
      io.to(`user:${post.user_id}`).emit('notification', { type: 'like', from: req.user, postId });
      sendPushToUser(post.user_id, { title: 'New like', body: `${req.user.username} liked your entry.`, tag: 'post-' + postId, url: '/' });
    }
  }
  const likeCount = await get('SELECT COUNT(*) c FROM likes WHERE post_id = ?', [postId]);
  res.json({ likedByMe: !existing, likeCount: likeCount.c });
});

app.get('/api/posts/:id/comments', authMiddleware, async (req, res) => {
  const rows = await all(
    `SELECT comments.*, users.username, users.name, users.avatar, users.settings AS author_settings
     FROM comments JOIN users ON users.id = comments.user_id
     WHERE post_id = ? ORDER BY comments.created_at ASC`,
    [req.params.id]
  );
  res.json(rows.map(c => ({
    id: c.id, text: c.text, createdAt: c.created_at,
    author: publicUser({ id: c.user_id, username: c.username, name: c.name, avatar: c.avatar, settings: c.author_settings })
  })));
});

app.post('/api/posts/:id/comments', authMiddleware, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Comment cannot be empty.' });
  const result = await run('INSERT INTO comments (post_id, user_id, text) VALUES (?, ?, ?)',
    [req.params.id, req.user.id, text.trim()]);
  const post = await get('SELECT user_id FROM posts WHERE id = ?', [req.params.id]);
  if (post) {
    io.to(`user:${post.user_id}`).emit('notification', { type: 'comment', from: req.user, postId: req.params.id });
    sendPushToUser(post.user_id, { title: 'New comment', body: `${req.user.username} commented on your entry.`, tag: 'post-' + req.params.id, url: '/' });
  }
  res.json({ id: result.lastID, text: text.trim(), author: req.user, createdAt: new Date().toISOString() });
});

app.post('/api/posts/:id/share', authMiddleware, async (req, res) => {
  await run('INSERT INTO shares (post_id, user_id) VALUES (?, ?)', [req.params.id, req.user.id]);
  const shareCount = await get('SELECT COUNT(*) c FROM shares WHERE post_id = ?', [req.params.id]);
  res.json({ shareCount: shareCount.c });
});

app.post('/api/posts/:id/share-to/:userId', authMiddleware, async (req, res) => {
  const post = await get('SELECT * FROM posts WHERE id = ?', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  const toId = Number(req.params.userId);
  const blocked = await get('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [toId, req.user.id]);
  if (blocked) return res.status(403).json({ error: 'You cannot message this user.' });

  const result = await run(
    'INSERT INTO messages (sender_id, receiver_id, text, media, media_type, shared_post_id) VALUES (?, ?, ?, ?, ?, ?)',
    [req.user.id, toId, '', post.image || null, post.media_type || 'none', post.id]
  );
  await run('INSERT INTO shares (post_id, user_id) VALUES (?, ?)', [post.id, req.user.id]);
  const author = await get('SELECT * FROM users WHERE id = ?', [post.user_id]);
  const msg = {
    id: result.lastID, sender_id: req.user.id, receiver_id: toId, text: '',
    media: post.image || null, media_type: post.media_type || 'none',
    shared_post_id: post.id,
    shared_post: { id: post.id, content: post.content, image: post.image, mediaType: post.media_type, author: publicUser(author) },
    created_at: new Date().toISOString(), is_read: 0
  };
  io.to(`user:${toId}`).emit('dm:receive', msg);
  sendPushToUser(toId, { title: req.user.username, body: '📎 Shared an entry with you', tag: 'dm-' + req.user.id, url: '/' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// CHAT (history via REST, live via sockets)
// ---------------------------------------------------------------
async function attachSharedPost(rows) {
  const out = [];
  for (const m of rows) {
    if (m.shared_post_id) {
      const post = await get('SELECT * FROM posts WHERE id = ?', [m.shared_post_id]);
      if (post) {
        const author = await get('SELECT * FROM users WHERE id = ?', [post.user_id]);
        m.shared_post = { id: post.id, content: post.content, image: post.image, mediaType: post.media_type, author: publicUser(author) };
      }
    }
    out.push(m);
  }
  return out;
}

app.get('/api/messages/:userId', authMiddleware, async (req, res) => {
  const otherId = Number(req.params.userId);
  const rows = await all(
    `SELECT * FROM messages
     WHERE group_id IS NULL AND
       ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
       AND NOT FIND_IN_SET(?, COALESCE(deleted_for, ''))
     ORDER BY created_at ASC LIMIT 200`,
    [req.user.id, otherId, otherId, req.user.id, req.user.id]
  );
  const hadUnread = rows.some(m => m.sender_id === otherId && m.receiver_id === req.user.id && !m.is_read);
  await run(`UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ?`, [otherId, req.user.id]);
  if (hadUnread) io.to(`user:${otherId}`).emit('dm:seen', { by: req.user.id });
  res.json(await attachSharedPost(rows));
});

// Clear a 1:1 conversation for the requesting user only (soft-delete
// via a comma-separated "deleted_for" list so the other side keeps
// their copy — used by the new "Clear chat" chat-settings option).
app.delete('/api/messages/:userId', authMiddleware, async (req, res) => {
  const otherId = Number(req.params.userId);
  const rows = await all(
    `SELECT id, deleted_for FROM messages WHERE group_id IS NULL AND
     ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))`,
    [req.user.id, otherId, otherId, req.user.id]
  );
  for (const m of rows) {
    const set = new Set((m.deleted_for || '').split(',').filter(Boolean));
    set.add(String(req.user.id));
    await run('UPDATE messages SET deleted_for = ? WHERE id = ?', [[...set].join(','), m.id]);
  }
  res.json({ ok: true });
});

app.get('/api/conversations', authMiddleware, async (req, res) => {
  const rows = await all(
    `SELECT DISTINCT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS other_id
     FROM messages WHERE group_id IS NULL AND (sender_id = ? OR receiver_id = ?)`,
    [req.user.id, req.user.id, req.user.id]
  );
  const out = [];
  for (const r of rows) {
    if (!r.other_id) continue;
    const other = await get('SELECT * FROM users WHERE id = ?', [r.other_id]);
    const last = await get(
      `SELECT * FROM messages WHERE group_id IS NULL AND NOT FIND_IN_SET(?, COALESCE(deleted_for, '')) AND
       ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, req.user.id, r.other_id, r.other_id, req.user.id]
    );
    if (!last) continue; // conversation was fully cleared by this user
    const unread = await get(
      `SELECT COUNT(*) c FROM messages WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
      [r.other_id, req.user.id]
    );
    out.push({ user: publicUser(other), lastMessage: last, unread: unread.c });
  }
  out.sort((a, b) => new Date(b.lastMessage?.created_at || 0) - new Date(a.lastMessage?.created_at || 0));
  res.json(out);
});

// ---------------------------------------------------------------
// GROUPS
// ---------------------------------------------------------------
async function requireGroupAdmin(groupId, userId) {
  const row = await get('SELECT is_admin FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
  return !!row && !!row.is_admin;
}

function groupPublic(g, members) {
  return {
    id: g.id, name: g.name, photo: g.photo || null, description: g.description || '',
    creatorId: g.creator_id, createdAt: g.created_at,
    members: members.map(m => ({ ...publicUser(m), isAdmin: !!m.is_admin }))
  };
}

async function getGroupMembers(groupId) {
  return all(
    `SELECT users.*, group_members.is_admin FROM users
     JOIN group_members ON group_members.user_id = users.id WHERE group_members.group_id = ?`,
    [groupId]
  );
}

app.post('/api/groups', authMiddleware, async (req, res) => {
  const { name, memberIds = [] } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Group needs a name.' });
  const result = await run('INSERT INTO `groups` (name, creator_id) VALUES (?, ?)', [name.trim(), req.user.id]);
  const groupId = result.lastID;
  await run('INSERT INTO group_members (group_id, user_id, is_admin) VALUES (?, ?, 1)', [groupId, req.user.id]);
  for (const id of memberIds) {
    if (Number(id) === req.user.id) continue;
    await run('INSERT IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)', [groupId, id]);
  }
  res.json({ id: groupId, name: name.trim() });
});

app.get('/api/groups', authMiddleware, async (req, res) => {
  const rows = await all(
    `SELECT \`groups\`.* FROM \`groups\`
     JOIN group_members ON group_members.group_id = \`groups\`.id
     WHERE group_members.user_id = ?`,
    [req.user.id]
  );
  const out = [];
  for (const g of rows) {
    const members = await getGroupMembers(g.id);
    out.push(groupPublic(g, members));
  }
  res.json(out);
});

app.get('/api/groups/:id', authMiddleware, async (req, res) => {
  const g = await get('SELECT * FROM `groups` WHERE id = ?', [req.params.id]);
  if (!g) return res.status(404).json({ error: 'Group not found.' });
  const membership = await get('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?', [g.id, req.user.id]);
  if (!membership) return res.status(403).json({ error: 'Not a member of this group.' });
  const members = await getGroupMembers(g.id);
  res.json({ ...groupPublic(g, members), isAdmin: !!(await requireGroupAdmin(g.id, req.user.id)) });
});

app.put('/api/groups/:id', authMiddleware, async (req, res) => {
  const isAdmin = await requireGroupAdmin(req.params.id, req.user.id);
  if (!isAdmin) return res.status(403).json({ error: 'Only group admins can edit group settings.' });
  const { name, photo, description } = req.body;
  await run('UPDATE `groups` SET name = COALESCE(?, name), photo = COALESCE(?, photo), description = COALESCE(?, description) WHERE id = ?',
    [name ?? null, photo ?? null, description ?? null, req.params.id]);
  const g = await get('SELECT * FROM `groups` WHERE id = ?', [req.params.id]);
  const members = await getGroupMembers(g.id);
  io.to(`group:${g.id}`).emit('group:updated', groupPublic(g, members));
  res.json(groupPublic(g, members));
});

app.post('/api/groups/:id/members/:userId', authMiddleware, async (req, res) => {
  const isAdmin = await requireGroupAdmin(req.params.id, req.user.id);
  if (!isAdmin) return res.status(403).json({ error: 'Only group admins can add members.' });
  await run('INSERT IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)', [req.params.id, req.params.userId]);
  const memberSockets = onlineUsers.get(Number(req.params.userId));
  if (memberSockets) memberSockets.forEach(sid => io.sockets.sockets.get(sid)?.join(`group:${req.params.id}`));
  const g = await get('SELECT * FROM `groups` WHERE id = ?', [req.params.id]);
  const members = await getGroupMembers(g.id);
  io.to(`group:${g.id}`).emit('group:updated', groupPublic(g, members));
  res.json(groupPublic(g, members));
});

app.delete('/api/groups/:id/members/:userId', authMiddleware, async (req, res) => {
  const isAdmin = await requireGroupAdmin(req.params.id, req.user.id);
  const removingSelf = Number(req.params.userId) === req.user.id;
  if (!isAdmin && !removingSelf) return res.status(403).json({ error: 'Only group admins can remove members.' });
  await run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [req.params.id, req.params.userId]);
  const memberSockets = onlineUsers.get(Number(req.params.userId));
  if (memberSockets) memberSockets.forEach(sid => io.sockets.sockets.get(sid)?.leave(`group:${req.params.id}`));
  const g = await get('SELECT * FROM `groups` WHERE id = ?', [req.params.id]);
  if (g) {
    const members = await getGroupMembers(g.id);
    io.to(`group:${g.id}`).emit('group:updated', groupPublic(g, members));
    io.to(`user:${req.params.userId}`).emit('group:removed', { groupId: g.id });
    return res.json(groupPublic(g, members));
  }
  res.json({ ok: true });
});

app.post('/api/groups/:id/admins/:userId', authMiddleware, async (req, res) => {
  const isAdmin = await requireGroupAdmin(req.params.id, req.user.id);
  if (!isAdmin) return res.status(403).json({ error: 'Only group admins can promote members.' });
  await run('UPDATE group_members SET is_admin = 1 WHERE group_id = ? AND user_id = ?', [req.params.id, req.params.userId]);
  const g = await get('SELECT * FROM `groups` WHERE id = ?', [req.params.id]);
  const members = await getGroupMembers(g.id);
  io.to(`group:${g.id}`).emit('group:updated', groupPublic(g, members));
  res.json(groupPublic(g, members));
});

app.get('/api/groups/:id/messages', authMiddleware, async (req, res) => {
  const rows = await all('SELECT * FROM messages WHERE group_id = ? ORDER BY created_at ASC LIMIT 200', [req.params.id]);
  res.json(await attachSharedPost(rows));
});

// ---------------------------------------------------------------
// SOCKET.IO — auth, presence, chat, groups, calls (WebRTC signaling)
// ---------------------------------------------------------------
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', async (socket) => {
  const userId = socket.user.id;
  socket.join(`user:${userId}`);

  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socket.id);

  await run('UPDATE users SET is_online = 1 WHERE id = ?', [userId]);
  io.emit('presence', { userId, isOnline: true });

  const groups = await all('SELECT group_id FROM group_members WHERE user_id = ?', [userId]);
  groups.forEach((g) => socket.join(`group:${g.group_id}`));

  socket.on('dm:send', async ({ to, text, media }) => {
    const hasMedia = !!media;
    if ((!text || !text.trim()) && !hasMedia) return;
    const blocked = await get('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [to, userId]);
    if (blocked) return socket.emit('error_msg', { error: 'You cannot message this user.' });
    const result = await run(
      'INSERT INTO messages (sender_id, receiver_id, text, media, media_type) VALUES (?, ?, ?, ?, ?)',
      [userId, to, (text || '').trim(), media || null, hasMedia ? 'image' : 'none']
    );
    const msg = {
      id: result.lastID, sender_id: userId, receiver_id: to, text: (text || '').trim(),
      media: media || null, media_type: hasMedia ? 'image' : 'none',
      created_at: new Date().toISOString(), is_read: 0
    };
    io.to(`user:${to}`).emit('dm:receive', msg);
    socket.emit('dm:sent', msg);
    sendPushToUser(to, { title: socket.user.username, body: msg.text || '📷 Photo', tag: 'dm-' + userId, url: '/' });
  });

  socket.on('dm:typing', ({ to }) => io.to(`user:${to}`).emit('dm:typing', { from: userId }));

  // Marks the other person's messages to us as read, and tells their
  // client (in real time) so the "seen" ticks can turn blue. This is
  // what the Settings → Privacy → "Read receipts" toggle controls;
  // the client only calls this when that setting is on.
  socket.on('dm:seen', async ({ peerId }) => {
    if (!peerId) return;
    const { changes } = await run(
      'UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0',
      [peerId, userId]
    );
    if (changes > 0) io.to(`user:${peerId}`).emit('dm:seen', { by: userId });
  });

  socket.on('group:send', async ({ groupId, text, media }) => {
    const hasMedia = !!media;
    if ((!text || !text.trim()) && !hasMedia) return;
    const member = await get('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    if (!member) return;
    const result = await run(
      'INSERT INTO messages (sender_id, group_id, text, media, media_type) VALUES (?, ?, ?, ?, ?)',
      [userId, groupId, (text || '').trim(), media || null, hasMedia ? 'image' : 'none']
    );
    const msg = {
      id: result.lastID, sender_id: userId, group_id: groupId, text: (text || '').trim(),
      media: media || null, media_type: hasMedia ? 'image' : 'none',
      created_at: new Date().toISOString()
    };
    io.to(`group:${groupId}`).emit('group:receive', msg);
    const members = await all('SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?', [groupId, userId]);
    members.forEach(m => sendPushToUser(m.user_id, { title: socket.user.username, body: msg.text || '📷 Photo', tag: 'group-' + groupId, url: '/' }));
  });

  // -------- WebRTC call signaling (1:1 voice/video calling — this is
  // live calling, not stored "video" content, so it was kept) --------
  socket.on('call:invite', ({ to, kind, offer }) => {
    io.to(`user:${to}`).emit('call:incoming', { from: userId, fromUser: socket.user, kind, offer });
    sendPushToUser(to, { title: 'Incoming call', body: `${socket.user.username} is calling you`, tag: 'call-' + userId, url: '/' });
  });
  socket.on('call:answer', ({ to, answer }) => io.to(`user:${to}`).emit('call:answered', { from: userId, answer }));
  socket.on('call:ice', ({ to, candidate }) => io.to(`user:${to}`).emit('call:ice', { from: userId, candidate }));
  socket.on('call:decline', ({ to }) => io.to(`user:${to}`).emit('call:declined', { from: userId }));
  socket.on('call:end', ({ to }) => io.to(`user:${to}`).emit('call:ended', { from: userId }));
  socket.on('call:mute', ({ to, muted }) => io.to(`user:${to}`).emit('call:peer_mute', { from: userId, muted }));
  socket.on('call:video_toggle', ({ to, videoOn }) => io.to(`user:${to}`).emit('call:peer_video_toggle', { from: userId, videoOn }));

  socket.on('disconnect', async () => {
    const set = onlineUsers.get(userId);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        onlineUsers.delete(userId);
        await run("UPDATE users SET is_online = 0, last_seen = NOW() WHERE id = ?", [userId]);
        io.emit('presence', { userId, isOnline: false });
      }
    }
  });
});

// ---------------------------------------------------------------
// START
// ---------------------------------------------------------------
setupDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Your Day Diary running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to connect to MySQL. Check your DB_HOST/DB_USER/DB_PASSWORD/DB_NAME.');
    console.error(err.message);
    process.exit(1);
  });
