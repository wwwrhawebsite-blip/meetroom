/* ============================================================
   YOUR DAY DIARY — Social Media App Backend (single file)
   Stack: Express + Socket.IO + MySQL (mysql2) + JWT auth
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
   ============================================================ */

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'day-diary-dev-secret-change-me';

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'Ajju@2006',
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

let pool;

// ---------------------------------------------------------------
// DB SETUP — connects, creates the database if missing, then
// runs schema.sql (safe to run every time; skips existing tables
// and ignores "index already exists" on repeat runs).
// ---------------------------------------------------------------
async function setupDatabase() {
  // First connect without selecting a database, so we can create it.
  const rootConn = await mysql.createConnection({
    host: DB_CONFIG.host, port: DB_CONFIG.port, user: DB_CONFIG.user, password: DB_CONFIG.password,
    multipleStatements: true,
    ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {})
  });
  await rootConn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_CONFIG.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  await rootConn.end();

  pool = mysql.createPool(DB_CONFIG);

  // Run schema.sql. CREATE TABLE IF NOT EXISTS is safe to repeat.
  // CREATE INDEX has no IF NOT EXISTS in MySQL, so we only add
  // indexes the first time (checked via information_schema).
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
  console.log('Database ready (day_diary).');
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
  privateAccount: false,        // 1. who can see your posts
  showOnlineStatus: true,       // 2. show green dot to others
  readReceipts: true,           // 3. seen ticks in chat
  allowMessagesFrom: 'everyone',// 4. everyone | followers | nobody
  darkMode: false,              // 5. theme
  emailNotifications: true,     // 6.
  pushNotifications: true,      // 7.
  twoFactorAuth: false,         // 8.
  language: 'en',               // 9.
  autoplayVideos: true          // 10.
};

function parseSettings(row) {
  if (!row) return DEFAULT_SETTINGS;
  if (row.settings == null) return DEFAULT_SETTINGS;
  const raw = typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings;
  return { ...DEFAULT_SETTINGS, ...raw };
}

// ---------------------------------------------------------------
// APP + SOCKET SETUP
// ---------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '8mb' })); // base64 images/avatars
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8e6 });

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
    lastSeen: row.last_seen, createdAt: row.created_at
  };
}

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

// ID search — like Instagram's search-by-username
app.get('/api/search', authMiddleware, async (req, res) => {
  const term = (req.query.q || '').trim();
  if (!term) return res.json([]);
  const like = `%${term}%`;
  const rows = await all(
    `SELECT * FROM users WHERE (username LIKE ? OR name LIKE ?) AND id != ? LIMIT 20`,
    [like, like, req.user.id]
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
// ---------------------------------------------------------------
async function hydratePosts(rows, viewerId) {
  const out = [];
  for (const p of rows) {
    const author = await get('SELECT * FROM users WHERE id = ?', [p.user_id]);
    const likeCount = await get('SELECT COUNT(*) c FROM likes WHERE post_id = ?', [p.id]);
    const commentCount = await get('SELECT COUNT(*) c FROM comments WHERE post_id = ?', [p.id]);
    const shareCount = await get('SELECT COUNT(*) c FROM shares WHERE post_id = ?', [p.id]);
    const likedByMe = await get('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?', [p.id, viewerId]);
    out.push({
      id: p.id, content: p.content, image: p.image, createdAt: p.created_at,
      author: publicUser(author),
      likeCount: likeCount.c, commentCount: commentCount.c, shareCount: shareCount.c,
      likedByMe: !!likedByMe
    });
  }
  return out;
}

app.get('/api/feed', authMiddleware, async (req, res) => {
  const rows = await all(
    `SELECT posts.* FROM posts
     WHERE user_id = ?
        OR user_id IN (SELECT following_id FROM follows WHERE follower_id = ?)
     ORDER BY created_at DESC LIMIT 100`,
    [req.user.id, req.user.id]
  );
  res.json(await hydratePosts(rows, req.user.id));
});

app.get('/api/users/:username/posts', authMiddleware, async (req, res) => {
  const user = await get('SELECT id FROM users WHERE username = ?', [req.params.username]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const rows = await all('SELECT * FROM posts WHERE user_id = ? ORDER BY created_at DESC', [user.id]);
  res.json(await hydratePosts(rows, req.user.id));
});

app.post('/api/posts', authMiddleware, async (req, res) => {
  const { content, image } = req.body;
  if (!content && !image) return res.status(400).json({ error: 'Post needs text or an image.' });
  const result = await run('INSERT INTO posts (user_id, content, image) VALUES (?, ?, ?)',
    [req.user.id, content || '', image || '']);
  const rows = await all('SELECT * FROM posts WHERE id = ?', [result.lastID]);
  res.json((await hydratePosts(rows, req.user.id))[0]);
});

app.delete('/api/posts/:id', authMiddleware, async (req, res) => {
  const post = await get('SELECT * FROM posts WHERE id = ?', [req.params.id]);
  if (!post || post.user_id !== req.user.id) return res.status(403).json({ error: 'Not allowed.' });
  await run('DELETE FROM posts WHERE id = ?', [req.params.id]);
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
    if (post) io.to(`user:${post.user_id}`).emit('notification', { type: 'like', from: req.user, postId });
  }
  const likeCount = await get('SELECT COUNT(*) c FROM likes WHERE post_id = ?', [postId]);
  res.json({ likedByMe: !existing, likeCount: likeCount.c });
});

app.get('/api/posts/:id/comments', authMiddleware, async (req, res) => {
  const rows = await all('SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC', [req.params.id]);
  const out = [];
  for (const c of rows) {
    const author = await get('SELECT * FROM users WHERE id = ?', [c.user_id]);
    out.push({ id: c.id, text: c.text, createdAt: c.created_at, author: publicUser(author) });
  }
  res.json(out);
});

app.post('/api/posts/:id/comments', authMiddleware, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Comment cannot be empty.' });
  const result = await run('INSERT INTO comments (post_id, user_id, text) VALUES (?, ?, ?)',
    [req.params.id, req.user.id, text.trim()]);
  const post = await get('SELECT user_id FROM posts WHERE id = ?', [req.params.id]);
  if (post) io.to(`user:${post.user_id}`).emit('notification', { type: 'comment', from: req.user, postId: req.params.id });
  res.json({ id: result.lastID, text: text.trim(), author: req.user, createdAt: new Date().toISOString() });
});

app.post('/api/posts/:id/share', authMiddleware, async (req, res) => {
  await run('INSERT INTO shares (post_id, user_id) VALUES (?, ?)', [req.params.id, req.user.id]);
  const shareCount = await get('SELECT COUNT(*) c FROM shares WHERE post_id = ?', [req.params.id]);
  res.json({ shareCount: shareCount.c });
});

// ---------------------------------------------------------------
// CHAT (history via REST, live via sockets)
// ---------------------------------------------------------------
app.get('/api/messages/:userId', authMiddleware, async (req, res) => {
  const otherId = Number(req.params.userId);
  const rows = await all(
    `SELECT * FROM messages
     WHERE group_id IS NULL AND
       ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
     ORDER BY created_at ASC LIMIT 200`,
    [req.user.id, otherId, otherId, req.user.id]
  );
  await run(`UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ?`, [otherId, req.user.id]);
  res.json(rows);
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
      `SELECT * FROM messages WHERE group_id IS NULL AND
       ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, r.other_id, r.other_id, req.user.id]
    );
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
app.post('/api/groups', authMiddleware, async (req, res) => {
  const { name, memberIds = [] } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Group needs a name.' });
  const result = await run('INSERT INTO `groups` (name, creator_id) VALUES (?, ?)', [name.trim(), req.user.id]);
  const groupId = result.lastID;
  await run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', [groupId, req.user.id]);
  for (const id of memberIds) {
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
    const members = await all(
      `SELECT users.* FROM users JOIN group_members ON group_members.user_id = users.id WHERE group_members.group_id = ?`,
      [g.id]
    );
    out.push({ id: g.id, name: g.name, createdAt: g.created_at, members: members.map(publicUser) });
  }
  res.json(out);
});

app.get('/api/groups/:id/messages', authMiddleware, async (req, res) => {
  const rows = await all('SELECT * FROM messages WHERE group_id = ? ORDER BY created_at ASC LIMIT 200', [req.params.id]);
  res.json(rows);
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

  socket.on('dm:send', async ({ to, text }) => {
    if (!text || !text.trim()) return;
    const blocked = await get('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [to, userId]);
    if (blocked) return socket.emit('error_msg', { error: 'You cannot message this user.' });
    const result = await run('INSERT INTO messages (sender_id, receiver_id, text) VALUES (?, ?, ?)', [userId, to, text.trim()]);
    const msg = { id: result.lastID, sender_id: userId, receiver_id: to, text: text.trim(), created_at: new Date().toISOString(), is_read: 0 };
    io.to(`user:${to}`).emit('dm:receive', msg);
    socket.emit('dm:sent', msg);
  });

  socket.on('dm:typing', ({ to }) => io.to(`user:${to}`).emit('dm:typing', { from: userId }));

  socket.on('group:send', async ({ groupId, text }) => {
    if (!text || !text.trim()) return;
    const member = await get('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
    if (!member) return;
    const result = await run('INSERT INTO messages (sender_id, group_id, text) VALUES (?, ?, ?)', [userId, groupId, text.trim()]);
    const msg = { id: result.lastID, sender_id: userId, group_id: groupId, text: text.trim(), created_at: new Date().toISOString() };
    io.to(`group:${groupId}`).emit('group:receive', msg);
  });

  socket.on('call:invite', ({ to, kind, offer }) => {
    io.to(`user:${to}`).emit('call:incoming', { from: userId, fromUser: socket.user, kind, offer });
  });
  socket.on('call:answer', ({ to, answer }) => io.to(`user:${to}`).emit('call:answered', { from: userId, answer }));
  socket.on('call:ice', ({ to, candidate }) => io.to(`user:${to}`).emit('call:ice', { from: userId, candidate }));
  socket.on('call:decline', ({ to }) => io.to(`user:${to}`).emit('call:declined', { from: userId }));
  socket.on('call:end', ({ to }) => io.to(`user:${to}`).emit('call:ended', { from: userId }));

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