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
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // stay logged in for 7 days
});

app.use(sessionMiddleware);
app.use(express.json()); // lets us read JSON sent by the browser

// ---------- Database statements ----------
const findUser = db.prepare('SELECT * FROM users WHERE username = ?');
const createUser = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
const insertMessage = db.prepare('INSERT INTO messages (user_id, text) VALUES (?, ?)');
const getMessage = db.prepare(`
  SELECT m.id, m.text, m.created_at, u.username
  FROM messages m JOIN users u ON u.id = m.user_id
  WHERE m.id = ?
`);
const getRecentMessages = db.prepare(`
  SELECT * FROM (
    SELECT m.id, m.text, m.created_at, u.username
    FROM messages m JOIN users u ON u.id = m.user_id
    ORDER BY m.id DESC LIMIT 50
  ) ORDER BY id ASC
`);

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

  // Log them in straight away
  req.session.userId = result.lastInsertRowid;
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

// ---------- Pages ----------
// The chat page is only for logged-in users
app.get('/', (req, res) => {
  if (!req.session.userId) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static('public', { index: false }));

// ---------- Socket.IO ----------
// Let sockets read the same session cookie as normal requests
io.engine.use(sessionMiddleware);

// Reject sockets that aren't logged in
io.use((socket, next) => {
  const sess = socket.request.session;
  if (sess && sess.userId) return next();
  next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
  const { userId, username } = socket.request.session;
  console.log(`${username} connected`);

  socket.emit('me', { username });
  socket.emit('history', getRecentMessages.all());

  socket.on('chat message', (data) => {
    const text = data && typeof data.text === 'string' ? data.text.trim() : '';
    if (!text || text.length > 2000) return;

    // userId comes from the SESSION, not from the browser, so it can't be faked
    const result = insertMessage.run(userId, text);
    io.emit('chat message', getMessage.get(result.lastInsertRowid));
  });

  socket.on('disconnect', () => {
    console.log(`${username} disconnected`);
  });
});

server.listen(3000, () => {
  console.log('Running at http://localhost:3000');
});