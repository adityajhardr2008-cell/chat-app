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

// Conversations + members
const getConv = db.prepare('SELECT * FROM conversations WHERE id = ?');
const findDirect = db.prepare('SELECT * FROM conversations WHERE direct_key = ?');
const createConv = db.prepare(
  'INSERT INTO conversations (type, name, direct_key, created_by) VALUES (?, ?, ?, ?)'
);
const addMember = db.prepare(
  'INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)'
);
const getMembers = db.prepare(`
  SELECT u.id, u.username
  FROM conversation_members cm JOIN users u ON u.id = cm.user_id
  WHERE cm.conversation_id = ? ORDER BY u.username
`);
const memberCheck = db.prepare(
  'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
);
const myConvIds = db.prepare(
  'SELECT conversation_id AS id FROM conversation_members WHERE user_id = ?'
);
const lastActivity = db.prepare(`
  SELECT COALESCE(
    (SELECT MAX(created_at) FROM messages WHERE conversation_id = ?),
    (SELECT created_at FROM conversations WHERE id = ?)
  ) AS t
`);

// Messages. Deleted messages get their text blanked HERE, so it never reaches a client.
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

function isMember(convId, userId) {
  return !!memberCheck.get(convId, userId);
}

// What the browser needs to know about a conversation, from one user's point of view
function convView(conv, userId) {
  const members = getMembers.all(conv.id);
  const last_at = lastActivity.get(conv.id, conv.id).t;

  if (conv.type === 'direct') {
    const other = members.find((m) => m.id !== userId) || members[0];
    return {
      id: conv.id, type: 'direct', title: other.username,
      other_id: other.id, members, last_at
    };
  }
  return {
    id: conv.id, type: 'group', title: conv.name,
    members, created_by: conv.created_by, last_at
  };
}

// Put every open tab of these users into the conversation's room
function joinRooms(userIds, convId) {
  userIds.forEach((id) => io.in(`user:${id}`).socketsJoin(`conv:${convId}`));
}

// Clean a list of user ids: numbers only, no duplicates, must exist, not in `exclude`
function cleanIds(list, exclude = []) {
  const ids = [...new Set((Array.isArray(list) ? list : []).map(Number))];
  return ids.filter((id) => id && !exclude.includes(id) && findUserById.get(id));
}

// userId -> number of open tabs
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
  res.json(myConvIds.all(me).map((c) => convView(getConv.get(c.id), me)));
});

// Start (or open existing) direct conversation
app.post('/api/conversations', requireLogin, (req, res) => {
  const me = req.session.userId;
  const otherId = Number(req.body.userId);

  if (!otherId || otherId === me) return res.status(400).json({ error: 'Invalid user' });
  if (!findUserById.get(otherId)) return res.status(404).json({ error: 'User not found' });

  const [a, b] = me < otherId ? [me, otherId] : [otherId, me];
  const key = `${a}:${b}`;
  let conv = findDirect.get(key);

  if (!conv) {
    const id = db.transaction(() => {
      const r = createConv.run('direct', null, key, me);
      const convId = Number(r.lastInsertRowid);
      addMember.run(convId, me);
      addMember.run(convId, otherId);
      return convId;
    })();

    conv = getConv.get(id);
    joinRooms([me, otherId], conv.id);
    io.to(`user:${otherId}`).emit('new conversation', convView(conv, otherId));
  }

  res.json(convView(conv, me));
});

// Create a group
app.post('/api/groups', requireLogin, (req, res) => {
  const me = req.session.userId;
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';

  if (!name || name.length > 40) {
    return res.status(400).json({ error: 'Group name must be 1-40 characters' });
  }
  const ids = cleanIds(req.body.memberIds, [me]);
  if (ids.length === 0) return res.status(400).json({ error: 'Add at least one other person' });
  if (ids.length > 50) return res.status(400).json({ error: 'Too many members (max 50)' });

  const convId = db.transaction(() => {
    const r = createConv.run('group', name, null, me);
    const id = Number(r.lastInsertRowid);
    [me, ...ids].forEach((u) => addMember.run(id, u));
    return id;
  })();

  const conv = getConv.get(convId);
  joinRooms([me, ...ids], convId);
  ids.forEach((id) => io.to(`user:${id}`).emit('new conversation', convView(conv, id)));
  res.json(convView(conv, me));
});

// Add people to an existing group (any member can)
app.post('/api/groups/:id/members', requireLogin, (req, res) => {
  const me = req.session.userId;
  const conv = getConv.get(Number(req.params.id));

  if (!conv || conv.type !== 'group' || !isMember(conv.id, me)) {
    return res.status(403).json({ error: 'Not your group' });
  }

  const existing = getMembers.all(conv.id).map((m) => m.id);
  const ids = cleanIds(req.body.userIds, existing);
  if (ids.length === 0) return res.status(400).json({ error: 'No new people to add' });
  if (existing.length + ids.length > 50) {
    return res.status(400).json({ error: 'Too many members (max 50)' });
  }

  ids.forEach((u) => addMember.run(conv.id, u));
  joinRooms(ids, conv.id);

  ids.forEach((id) => io.to(`user:${id}`).emit('new conversation', convView(conv, id)));
  io.to(`conv:${conv.id}`).emit('conversation updated', convView(conv, me));
  res.json(convView(conv, me));
});

app.get('/api/conversations/:id/messages', requireLogin, (req, res) => {
  const convId = Number(req.params.id);
  if (!convId || !isMember(convId, req.session.userId)) {
    return res.status(403).json({ error: 'Not your conversation' });
  }
  res.json(getConversationMessages.all(convId));
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
  myConvIds.all(userId).forEach((c) => socket.join(`conv:${c.id}`));

  // Presence
  const count = (onlineCounts.get(userId) || 0) + 1;
  onlineCounts.set(userId, count);
  if (count === 1) io.emit('presence', { userId, online: true });

  socket.emit('me', { id: userId, username });
  socket.emit('online users', [...onlineCounts.keys()]);

  // Send a message
  socket.on('chat message', (data) => {
    const convId = Number(data && data.conversationId);
    if (!convId || !isMember(convId, userId)) return;

    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text || text.length > 2000) return;

    const result = insertMessage.run(convId, userId, text);
    io.to(`conv:${convId}`).emit('chat message', getMessage.get(result.lastInsertRowid));
  });

  // Typing (forwarded to everyone else in the room, nothing saved)
  socket.on('typing', (data) => {
    const convId = Number(data && data.conversationId);
    if (!convId || !isMember(convId, userId)) return;
    socket.to(`conv:${convId}`).emit('typing', { conversationId: convId, username });
  });

  // Edit (own messages only)
  socket.on('edit message', (data) => {
    const msg = getRawMessage.get(Number(data && data.id));
    if (!msg || msg.user_id !== userId || msg.deleted) return;

    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text || text.length > 2000) return;

    updateMessageText.run(text, msg.id);
    io.to(`conv:${msg.conversation_id}`).emit('message updated', getMessage.get(msg.id));
  });

  // Delete (own messages only)
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