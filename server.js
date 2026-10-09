require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---------- Sessions ----------
const sessionMiddleware = session({
  store: new SqliteStore({ client: db }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
});

app.use(sessionMiddleware);
app.use(express.json());

// ---------- Database statements ----------
const findUser = db.prepare('SELECT * FROM users WHERE username = ?');
const findUserById = db.prepare('SELECT id, username FROM users WHERE id = ?');
const createUser = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
const searchUsers = db.prepare(
  'SELECT id, username FROM users WHERE username LIKE ? AND id != ? ORDER BY username LIMIT 10'
);

const findConversation = db.prepare('SELECT * FROM conversations WHERE user1_id = ? AND user2_id = ?');
const createConversation = db.prepare('INSERT INTO conversations (user1_id, user2_id) VALUES (?, ?)');
const getConversationById = db.prepare('SELECT * FROM conversations WHERE id = ?');
const getMyConversations = db.prepare(`
  SELECT c.id, u.id AS other_id, u.username AS other_username
  FROM conversations c
  JOIN users u ON u.id = CASE WHEN c.user1_id = ? THEN c.user2_id ELSE c.user1_id END
  WHERE c.user1_id = ? OR c.user2_id = ?
  ORDER BY c.id DESC
`);

// Columns we send to browsers. Deleted messages get their text blanked HERE,
// so the original text can never reach any client.
const MSG_COLS = `
  m.id, m.conversation_id, m.user_id,
  CASE WHEN m.deleted = 1 THEN '' ELSE m.text END AS text,
  m.deleted, m.created_at, m.edited_at, u.username
`;

const insertMessage = db.prepare(
  'INSERT INTO messages (conversation_id, user_id, text) VALUES (?, ?, ?)'
);
const getRawMessage = db.prepare('SELECT * FROM messages WHERE id = ?');
const getMessage = db.prepare(`
  SELECT ${MSG_COLS}
  FROM messages m JOIN users u ON u.id = m.user_id
  WHERE m.id = ?
`);
const getConversationMessages = db.prepare(`
  SELECT * FROM (
    SELECT ${MSG_COLS}
    FROM messages m JOIN users u ON u.id = m.user_id
    WHERE m.conversation_id = ?
    ORDER BY m.id DESC LIMIT 50
  ) ORDER BY id ASC
`);
const updateMessageText = db.prepare(
  'UPDATE messages SET text = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?'
);
const softDeleteMessage = db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?');

// ---------- Helpers ----------
function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function isMember(conv, userId) {
  return !!conv && (conv.user1_id === userId || conv.user2_id === userId);
}

// userId -> number of open sockets (tabs) for that user
const onlineCounts = new Map();

// ---------- Auth routes ----------
app.post('/register', (req, res) => {
  const { username, password } = req.body;

  if (!username || username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 3-20 characters' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (findUser.get(username)) {
    return res.status(400).json({ error: 'Username already taken' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = createUser.run(username, hash);

  req.session.userId = Number(result.lastInsertRowid);
  req.session.username = username;
  res.json({ ok: true });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = findUser.get(username || '');

  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ ok: true });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------- Chat API ----------
app.get('/api/users', requireLogin, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  res.json(searchUsers.all(`%${q}%`, req.session.userId));
});

app.get('/api/conversations', requireLogin, (req, res) => {
  const me = req.session.userId;
  res.json(getMyConversations.all(me, me, me));
});

app.post('/api/conversations', requireLogin, (req, res) => {
  const me = req.session.userId;
  const otherId = Number(req.body.userId);

  if (!otherId || otherId === me) return res.status(400).json({ error: 'Invalid user' });
  const other = findUserById.get(otherId);
  if (!other) return res.status(404).json({ error: 'User not found' });

  const [a, b] = me < otherId ? [me, otherId] : [otherId, me];
  let conv = findConversation.get(a, b);

  if (!conv) {
    const result = createConversation.run(a, b);
    conv = getConversationById.get(result.lastInsertRowid);

    io.in(`user:${me}`).socketsJoin(`conv:${conv.id}`);
    io.in(`user:${otherId}`).socketsJoin(`conv:${conv.id}`);

    io.to(`user:${otherId}`).emit('new conversation', {
      id: conv.id,
      other_id: me,
      other_username: req.session.username
    });
  }

  res.json({ id: conv.id, other_id: other.id, other_username: other.username });
});

app.get('/api/conversations/:id/messages', requireLogin, (req, res) => {
  const conv = getConversationById.get(Number(req.params.id));
  if (!isMember(conv, req.session.userId)) {
    return res.status(403).json({ error: 'Not your conversation' });
  }
  res.json(getConversationMessages.all(conv.id));
});

// ---------- Pages ----------
app.get('/', (req, res) => {
  if (!req.session.userId) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static('public', { index: false }));

// ---------- Socket.IO ----------
io.engine.use(sessionMiddleware);

io.use((socket, next) => {
  const sess = socket.request.session;
  if (sess && sess.userId) return next();
  next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
  const { userId, username } = socket.request.session;
  console.log(`${username} connected`);

  socket.join(`user:${userId}`);
  getMyConversations.all(userId, userId, userId).forEach((c) => {
    socket.join(`conv:${c.id}`);
  });

  // --- Presence: count this tab; announce only if user just came online ---
  const count = (onlineCounts.get(userId) || 0) + 1;
  onlineCounts.set(userId, count);
  if (count === 1) io.emit('presence', { userId, online: true });

  socket.emit('me', { id: userId, username });
  socket.emit('online users', [...onlineCounts.keys()]); // who is online right now

  // --- Send a message ---
  socket.on('chat message', (data) => {
    const conv = getConversationById.get(Number(data && data.conversationId));
    if (!isMember(conv, userId)) return;

    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text || text.length > 2000) return;

    const result = insertMessage.run(conv.id, userId, text);
    io.to(`conv:${conv.id}`).emit('chat message', getMessage.get(result.lastInsertRowid));
  });

  // --- Typing: forward to the OTHER people in the room, nothing is saved ---
  socket.on('typing', (data) => {
    const conv = getConversationById.get(Number(data && data.conversationId));
    if (!isMember(conv, userId)) return;
    socket.to(`conv:${conv.id}`).emit('typing', { conversationId: conv.id, username });
  });

  // --- Edit (only your own, not deleted ones) ---
  socket.on('edit message', (data) => {
    const msg = getRawMessage.get(Number(data && data.id));
    if (!msg || msg.user_id !== userId || msg.deleted) return;

    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text || text.length > 2000) return;

    updateMessageText.run(text, msg.id);
    io.to(`conv:${msg.conversation_id}`).emit('message updated', getMessage.get(msg.id));
  });

  // --- Delete (only your own) ---
  socket.on('delete message', (data) => {
    const msg = getRawMessage.get(Number(data && data.id));
    if (!msg || msg.user_id !== userId) return;

    softDeleteMessage.run(msg.id);
    io.to(`conv:${msg.conversation_id}`).emit('message updated', getMessage.get(msg.id));
  });

  socket.on('disconnect', () => {
    console.log(`${username} disconnected`);

    const left = (onlineCounts.get(userId) || 1) - 1;
    if (left <= 0) {
      onlineCounts.delete(userId);
      io.emit('presence', { userId, online: false });
    } else {
      onlineCounts.set(userId, left);
    }
  });
});

server.listen(3000, () => {
  console.log('Running at http://localhost:3000');
});