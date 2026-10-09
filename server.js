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

// ---------- Settings you may want to tweak ----------
const PENDING_LIMIT = 3;                 // messages a stranger can send before you accept
const NOTE_MS = 24 * 60 * 60 * 1000;     // notes disappear after 24 hours
const GROUP_MAX = 50;

// ---------- Sessions ----------
const sessionMiddleware = session({
  store: new SqliteStore({ client: db }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
});

app.use(sessionMiddleware);
app.use(express.json({ limit: '1mb' }));

// =====================================================================
// Database statements
// =====================================================================
// ----- users -----
const USER_COLS = `
  id, username, display_name, bio, note, note_at, avatar_v,
  read_receipts, pfp_vis, bio_vis,
  (avatar IS NOT NULL AND avatar != '') AS has_avatar
`;
const getUser = db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`);
const findUserByName = db.prepare('SELECT * FROM users WHERE username = ?');
const createUser = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
const getAvatar = db.prepare('SELECT avatar FROM users WHERE id = ?');
const searchUsers = db.prepare(`
  SELECT id FROM users
  WHERE (username LIKE ? OR display_name LIKE ?) AND id != ?
    AND id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)
  ORDER BY username LIMIT 10
`);
const updateProfile = db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?');
const setUserAvatar = db.prepare('UPDATE users SET avatar = ?, avatar_v = avatar_v + 1 WHERE id = ?');
const setNote = db.prepare('UPDATE users SET note = ?, note_at = CURRENT_TIMESTAMP WHERE id = ?');
const clearNote = db.prepare('UPDATE users SET note = NULL, note_at = NULL WHERE id = ?');
const setSettings = db.prepare('UPDATE users SET read_receipts = ?, pfp_vis = ?, bio_vis = ? WHERE id = ?');

// ----- blocks -----
const blockedEither = db.prepare(
  'SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)'
);
const iBlocked = db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?');
const addBlock = db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)');
const removeBlock = db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?');
const listBlocks = db.prepare('SELECT blocked_id AS id FROM blocks WHERE blocker_id = ?');

// ----- friendships -----
const getFriendship = db.prepare('SELECT * FROM friendships WHERE user_a = ? AND user_b = ?');
const insertFriendship = db.prepare(
  "INSERT INTO friendships (user_a, user_b, requested_by, status) VALUES (?, ?, ?, 'pending')"
);
const acceptFriendship = db.prepare(
  "UPDATE friendships SET status = 'accepted' WHERE user_a = ? AND user_b = ?"
);
const deleteFriendship = db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?');
const friendRows = db.prepare(`
  SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS id, status, requested_by
  FROM friendships WHERE user_a = ? OR user_b = ?
`);

// ----- conversations / members -----
const getConv = db.prepare('SELECT * FROM conversations WHERE id = ?');
const findDirect = db.prepare('SELECT * FROM conversations WHERE direct_key = ?');
const createConv = db.prepare(
  'INSERT INTO conversations (type, name, direct_key, created_by, status) VALUES (?, ?, ?, ?, ?)'
);
const setConvStatus = db.prepare('UPDATE conversations SET status = ? WHERE id = ?');
const updateGroup = db.prepare('UPDATE conversations SET name = ?, about = ? WHERE id = ?');
const setConvAvatar = db.prepare('UPDATE conversations SET avatar = ?, avatar_v = avatar_v + 1 WHERE id = ?');
const getConvAvatar = db.prepare('SELECT avatar FROM conversations WHERE id = ?');

const addMemberRow = db.prepare(
  'INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, status, invited_by) VALUES (?, ?, ?, ?)'
);
const setMemberStatus = db.prepare(
  'UPDATE conversation_members SET status = ? WHERE conversation_id = ? AND user_id = ?'
);
const removeMemberRow = db.prepare(
  'DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
);
const memberIds = db.prepare(
  'SELECT user_id AS id FROM conversation_members WHERE conversation_id = ? AND status = ?'
);
const memberRow = db.prepare(
  'SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
);
const memberRowCount = db.prepare('SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ?');
const myConvRows = db.prepare(
  'SELECT conversation_id AS id, status AS my_status FROM conversation_members WHERE user_id = ?'
);
const coMembers = db.prepare(`
  SELECT DISTINCT b.user_id AS id
  FROM conversation_members a JOIN conversation_members b ON a.conversation_id = b.conversation_id
  WHERE a.user_id = ? AND a.status = 'member' AND b.status = 'member' AND b.user_id != ?
`);
const lastActivity = db.prepare(`
  SELECT COALESCE(
    (SELECT MAX(created_at) FROM messages WHERE conversation_id = ?),
    (SELECT created_at FROM conversations WHERE id = ?)
  ) AS t
`);
const unreadCount = db.prepare(`
  SELECT COUNT(*) AS n FROM messages
  WHERE conversation_id = ? AND user_id != ? AND deleted = 0 AND kind = 'user'
    AND id > COALESCE((SELECT last_read_id FROM conversation_members
                       WHERE conversation_id = ? AND user_id = ?), 0)
`);
const lastMsgId = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE conversation_id = ?');
const setRead = db.prepare(`
  UPDATE conversation_members SET
    last_read_id = MAX(last_read_id, ?),
    receipt_read_id = CASE WHEN ? = 1 THEN MAX(receipt_read_id, ?) ELSE receipt_read_id END
  WHERE conversation_id = ? AND user_id = ?
`);

// ----- messages -----
// Deleted messages get their text blanked HERE, so it never reaches a client.
const MSG_COLS = `
  m.id, m.conversation_id, m.user_id, m.kind,
  CASE WHEN m.deleted = 1 THEN '' ELSE m.text END AS text,
  m.deleted, m.created_at, m.edited_at,
  COALESCE(NULLIF(u.display_name, ''), u.username) AS username
`;
const insertMessage = db.prepare(
  "INSERT INTO messages (conversation_id, user_id, text, kind) VALUES (?, ?, ?, 'user')"
);
const insertSystem = db.prepare(
  "INSERT INTO messages (conversation_id, user_id, text, kind) VALUES (?, ?, ?, 'system')"
);
const getRawMessage = db.prepare('SELECT * FROM messages WHERE id = ?');
const getMessage = db.prepare(`
  SELECT ${MSG_COLS} FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?
`);
const getConversationMessages = db.prepare(`
  SELECT * FROM (
    SELECT ${MSG_COLS} FROM messages m JOIN users u ON u.id = m.user_id
    WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 80
  ) ORDER BY id ASC
`);
const updateMessageText = db.prepare(
  'UPDATE messages SET text = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?'
);
const softDeleteMessage = db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?');
const sentCount = db.prepare(
  "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND user_id = ? AND kind = 'user'"
);

// =====================================================================
// Helpers
// =====================================================================
const displayName = (u) => (u.display_name && u.display_name.trim()) || u.username;
const noteExpiry = (u) =>
  u.note && u.note_at ? new Date(u.note_at.replace(' ', 'T') + 'Z').getTime() + NOTE_MS : 0;
const pair = (a, b) => (a < b ? [a, b] : [b, a]);
const directKey = (a, b) => pair(a, b).join(':');

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

const isBlockedEither = (a, b) => !!blockedEither.get(a, b, b, a);

function friendship(a, b) {
  const [x, y] = pair(a, b);
  return getFriendship.get(x, y);
}
const areFriends = (a, b) => {
  const f = friendship(a, b);
  return !!f && f.status === 'accepted';
};
const friendIds = (me) =>
  friendRows.all(me, me, me).filter((r) => r.status === 'accepted').map((r) => r.id);

function friendState(me, other) {
  if (me === other) return 'self';
  if (isBlockedEither(me, other)) return 'blocked';
  const f = friendship(me, other);
  if (!f) return 'none';
  if (f.status === 'accepted') return 'friends';
  return f.requested_by === me ? 'outgoing' : 'incoming';
}

// What viewer `viewerId` is allowed to see of user `u`
function publicUser(u, viewerId) {
  if (!u) return null;
  const self = u.id === viewerId;
  const blocked = !self && isBlockedEither(u.id, viewerId);
  const friend = !self && !blocked && areFriends(u.id, viewerId);
  const allowed = (vis) => self || (!blocked && (vis === 'everyone' || friend));
  const expiry = noteExpiry(u);
  const showNote = (self || friend) && expiry > Date.now(); // notes: friends only, no setting

  return {
    id: u.id,
    username: u.username,
    display_name: displayName(u),
    avatar_url: u.has_avatar && allowed(u.pfp_vis) ? `/api/avatar/user/${u.id}?v=${u.avatar_v}` : null,
    bio: allowed(u.bio_vis) ? u.bio || '' : '',
    bio_hidden: !allowed(u.bio_vis),
    note: showNote ? u.note : null,
    note_expires: showNote ? expiry : 0
  };
}

function selfProfile(id) {
  const u = getUser.get(id);
  return {
    ...publicUser(u, id),
    read_receipts: !!u.read_receipts,
    pfp_vis: u.pfp_vis,
    bio_vis: u.bio_vis
  };
}

const isMember = (convId, userId) => {
  const r = memberRow.get(convId, userId);
  return !!r && r.status === 'member';
};
const allMemberIds = (convId) => memberIds.all(convId, 'member').map((r) => r.id);

// A declined message request is hidden from the person who declined it
const visibleTo = (conv, userId) =>
  !(conv.type === 'direct' && conv.status === 'declined' && conv.created_by !== userId);

// What the browser needs to know about a conversation, from one user's point of view
function convView(conv, me) {
  const mr = memberRow.get(conv.id, me);
  const myStatus = mr ? mr.status : 'member';

  const view = {
    id: conv.id,
    type: conv.type,
    created_by: conv.created_by,
    my_status: myStatus,
    last_at: lastActivity.get(conv.id, conv.id).t,
    unread: myStatus === 'member' ? unreadCount.get(conv.id, me, conv.id, me).n : 0
  };

  if (conv.type === 'direct') {
    const otherId = allMemberIds(conv.id).find((id) => id !== me);
    // The sender of a declined request is never told it was declined
    view.status = conv.status === 'declined' && conv.created_by === me ? 'pending' : conv.status;
    view.other = publicUser(getUser.get(otherId), me);
    view.blocked_by_me = !!iBlocked.get(me, otherId);
  } else {
    view.status = 'active';
    view.name = conv.name;
    view.about = conv.about || '';
    view.avatar_url = conv.avatar ? `/api/avatar/group/${conv.id}?v=${conv.avatar_v}` : null;
    const ids = allMemberIds(conv.id);
    view.member_count = ids.length;
    if (myStatus === 'member') {
      view.members = ids.map((id) => publicUser(getUser.get(id), me));
      view.invited = memberIds.all(conv.id, 'invited').map((r) => publicUser(getUser.get(r.id), me));
    } else {
      const inviter = mr && mr.invited_by ? getUser.get(mr.invited_by) : null;
      view.invited_by = inviter ? displayName(inviter) : null;
    }
  }
  return view;
}

// Send every (eligible) member their own view of a conversation
function emitConvUpdate(convId, event = 'conversation updated') {
  const conv = getConv.get(convId);
  if (!conv) return;
  allMemberIds(convId).forEach((id) => {
    if (visibleTo(conv, id)) io.to(`user:${id}`).emit(event, convView(conv, id));
  });
}

function joinRooms(userIds, convId) {
  userIds.forEach((id) => io.in(`user:${id}`).socketsJoin(`conv:${convId}`));
}

function postSystem(convId, actorId, text) {
  const r = insertSystem.run(convId, actorId, text);
  io.to(`conv:${convId}`).emit('chat message', getMessage.get(r.lastInsertRowid));
}

function cleanIds(list, exclude = []) {
  const ids = [...new Set((Array.isArray(list) ? list : []).map(Number))];
  return ids.filter((id) => id && !exclude.includes(id) && getUser.get(id));
}

// Tell everyone who can see this user that their profile changed
function notifyUserUpdated(userId) {
  const u = getUser.get(userId);
  const viewers = new Set([...friendIds(userId), ...coMembers.all(userId, userId).map((r) => r.id)]);
  viewers.delete(userId);
  viewers.forEach((v) => io.to(`user:${v}`).emit('user updated', publicUser(u, v)));
  io.to(`user:${userId}`).emit('me updated', selfProfile(userId));
}

// Friendship / block between two users changed: refresh what each can see of the other
function refreshPair(a, b) {
  [[a, b], [b, a]].forEach(([viewer, target]) => {
    io.to(`user:${viewer}`).emit('user updated', publicUser(getUser.get(target), viewer));
    io.to(`user:${viewer}`).emit('friends changed');
  });
  const conv = findDirect.get(directKey(a, b));
  if (conv) emitConvUpdate(conv.id);
}

// Friends can chat freely: turn a pending message request into a normal chat
function activateDirect(a, b) {
  const conv = findDirect.get(directKey(a, b));
  if (conv && conv.status !== 'active') {
    setConvStatus.run('active', conv.id);
    emitConvUpdate(conv.id);
  }
}

// Only small JPEGs (the browser resizes pictures before uploading)
function parseJpegDataUrl(s) {
  if (typeof s !== 'string' || s.length > 400000) return null;
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(s);
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  return s;
}

function sendAvatar(res, dataUrl) {
  if (!dataUrl) return res.status(404).end();
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=86400'); // URL has ?v= so changes bust the cache
  res.send(buf);
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// userId -> number of open tabs
const onlineCounts = new Map();

// =====================================================================
// Auth routes
// =====================================================================
function startSession(req, res, user) {
  const oldSid = req.sessionID;
  io.in(`sess:${oldSid}`).disconnectSockets(true); // drop sockets of any previous login
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start session' });
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.save(() => res.json({ ok: true }));
  });
}

app.post('/register', (req, res) => {
  const { username, password } = req.body;

  if (typeof username !== 'string' || username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 3-20 characters' });
  }
  if (!/^[A-Za-z0-9_.]+$/.test(username)) {
    return res.status(400).json({ error: 'Username can only use letters, numbers, _ and .' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 64) {
    return res.status(400).json({ error: 'Password must be 6-64 characters' });
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return res.status(400).json({ error: 'Password needs at least one letter and one number' });
  }
  if (findUserByName.get(username)) {
    return res.status(400).json({ error: 'Username already taken' });
  }

  const result = createUser.run(username, bcrypt.hashSync(password, 10));
  startSession(req, res, { id: Number(result.lastInsertRowid), username });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = findUserByName.get(typeof username === 'string' ? username : '');

  if (!user || !bcrypt.compareSync(typeof password === 'string' ? password : '', user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  startSession(req, res, user);
});

app.post('/logout', (req, res) => {
  io.in(`sess:${req.sessionID}`).disconnectSockets(true); // kick this session's open tabs
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// =====================================================================
// Profile + settings
// =====================================================================
app.get('/api/me', requireLogin, (req, res) => {
  if (!getUser.get(req.session.userId)) return res.status(401).json({ error: 'Not logged in' });
  res.json(selfProfile(req.session.userId));
});

app.put('/api/profile', requireLogin, (req, res) => {
  const me = req.session.userId;
  const name = text(req.body.display_name, 30);
  const bio = text(req.body.bio, 150);
  updateProfile.run(name || null, bio, me);
  notifyUserUpdated(me);
  res.json(selfProfile(me));
});

app.put('/api/profile/avatar', requireLogin, (req, res) => {
  const me = req.session.userId;
  if (req.body.remove) {
    setUserAvatar.run(null, me);
  } else {
    const img = parseJpegDataUrl(req.body.image);
    if (!img) return res.status(400).json({ error: 'Invalid image' });
    setUserAvatar.run(img, me);
  }
  notifyUserUpdated(me);
  res.json(selfProfile(me));
});

app.put('/api/profile/note', requireLogin, (req, res) => {
  const me = req.session.userId;
  const note = text(req.body.note, 60);
  if (note) setNote.run(note, me);
  else clearNote.run(me);
  notifyUserUpdated(me);
  res.json(selfProfile(me));
});

app.put('/api/settings', requireLogin, (req, res) => {
  const me = req.session.userId;
  const cur = getUser.get(me);
  const vis = (v, fallback) => (v === 'everyone' || v === 'friends' ? v : fallback);
  setSettings.run(
    typeof req.body.read_receipts === 'boolean' ? (req.body.read_receipts ? 1 : 0) : cur.read_receipts,
    vis(req.body.pfp_vis, cur.pfp_vis),
    vis(req.body.bio_vis, cur.bio_vis),
    me
  );
  notifyUserUpdated(me); // visibility changed, so everyone's view of you may change
  res.json(selfProfile(me));
});

// Profile preview of any user (respects their privacy settings)
app.get('/api/users/:id', requireLogin, (req, res) => {
  const me = req.session.userId;
  const u = getUser.get(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({
    user: publicUser(u, me),
    friend_state: friendState(me, u.id),
    blocked_by_me: !!iBlocked.get(me, u.id)
  });
});

app.get('/api/users', requireLogin, (req, res) => {
  const me = req.session.userId;
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const rows = searchUsers.all(`%${q}%`, `%${q}%`, me, me);
  res.json(rows.map((r) => publicUser(getUser.get(r.id), me)));
});

// Profile pictures are served through here so privacy settings are enforced
app.get('/api/avatar/user/:id', requireLogin, (req, res) => {
  const me = req.session.userId;
  const u = getUser.get(Number(req.params.id));
  if (!u || !publicUser(u, me).avatar_url) return res.status(404).end();
  sendAvatar(res, (getAvatar.get(u.id) || {}).avatar);
});

app.get('/api/avatar/group/:id', requireLogin, (req, res) => {
  const convId = Number(req.params.id);
  if (!memberRow.get(convId, req.session.userId)) return res.status(404).end();
  sendAvatar(res, (getConvAvatar.get(convId) || {}).avatar);
});

// =====================================================================
// Friends
// =====================================================================
app.get('/api/friends', requireLogin, (req, res) => {
  const me = req.session.userId;
  const out = { friends: [], incoming: [], outgoing: [] };
  friendRows.all(me, me, me).forEach((r) => {
    const u = publicUser(getUser.get(r.id), me);
    if (r.status === 'accepted') out.friends.push(u);
    else if (r.requested_by === me) out.outgoing.push(u);
    else out.incoming.push(u);
  });
  res.json(out);
});

app.post('/api/friends/request', requireLogin, (req, res) => {
  const me = req.session.userId;
  const other = Number(req.body.userId);
  if (!other || other === me || !getUser.get(other)) return res.status(400).json({ error: 'Invalid user' });
  if (isBlockedEither(me, other)) return res.status(403).json({ error: "You can't send a request to this user" });

  const f = friendship(me, other);
  if (f) {
    if (f.status === 'pending' && f.requested_by !== me) {
      // They already asked us, so this just accepts it
      const [a, b] = pair(me, other);
      acceptFriendship.run(a, b);
      activateDirect(me, other);
      refreshPair(me, other);
    }
    return res.json({ ok: true });
  }

  const [a, b] = pair(me, other);
  insertFriendship.run(a, b, me);
  refreshPair(me, other);
  res.json({ ok: true });
});

app.post('/api/friends/respond', requireLogin, (req, res) => {
  const me = req.session.userId;
  const other = Number(req.body.userId);
  const f = other && friendship(me, other);
  if (!f || f.status !== 'pending' || f.requested_by === me) {
    return res.status(400).json({ error: 'No request to respond to' });
  }
  const [a, b] = pair(me, other);
  if (req.body.accept) {
    acceptFriendship.run(a, b);
    activateDirect(me, other);
  } else {
    deleteFriendship.run(a, b);
  }
  refreshPair(me, other);
  res.json({ ok: true });
});

// Unfriend, or cancel a request you sent
app.delete('/api/friends/:id', requireLogin, (req, res) => {
  const me = req.session.userId;
  const other = Number(req.params.id);
  if (!other || !friendship(me, other)) return res.status(404).json({ error: 'Not found' });
  const [a, b] = pair(me, other);
  deleteFriendship.run(a, b);
  refreshPair(me, other);
  res.json({ ok: true });
});

// =====================================================================
// Blocking
// =====================================================================
app.get('/api/blocks', requireLogin, (req, res) => {
  res.json(
    listBlocks.all(req.session.userId).map((r) => {
      const u = getUser.get(r.id);
      return { id: u.id, username: u.username, display_name: displayName(u) };
    })
  );
});

app.post('/api/blocks', requireLogin, (req, res) => {
  const me = req.session.userId;
  const other = Number(req.body.userId);
  if (!other || other === me || !getUser.get(other)) return res.status(400).json({ error: 'Invalid user' });

  addBlock.run(me, other);
  const f = friendship(me, other);
  if (f) {
    const [a, b] = pair(me, other);
    deleteFriendship.run(a, b);
  }
  // Blocking someone who sent a message request also declines it
  const conv = findDirect.get(directKey(me, other));
  if (conv && conv.status === 'pending' && conv.created_by === other) setConvStatus.run('declined', conv.id);

  refreshPair(me, other);
  res.json({ ok: true });
});

app.delete('/api/blocks/:id', requireLogin, (req, res) => {
  const me = req.session.userId;
  const other = Number(req.params.id);
  removeBlock.run(me, other);
  refreshPair(me, other);
  res.json({ ok: true });
});

// =====================================================================
// Conversations
// =====================================================================
app.get('/api/conversations', requireLogin, (req, res) => {
  const me = req.session.userId;
  res.json(
    myConvRows
      .all(me)
      .map((r) => getConv.get(r.id))
      .filter((c) => c && visibleTo(c, me))
      .map((c) => convView(c, me))
  );
});

// Start (or open) a direct conversation
app.post('/api/conversations', requireLogin, (req, res) => {
  const me = req.session.userId;
  const otherId = Number(req.body.userId);

  if (!otherId || otherId === me) return res.status(400).json({ error: 'Invalid user' });
  if (!getUser.get(otherId)) return res.status(404).json({ error: 'User not found' });
  if (isBlockedEither(me, otherId)) {
    return res.status(403).json({
      error: iBlocked.get(me, otherId) ? 'Unblock this user to message them' : "You can't message this user"
    });
  }

  let conv = findDirect.get(directKey(me, otherId));

  if (!conv) {
    // Friends chat straight away; everyone else starts as a message request
    const status = areFriends(me, otherId) ? 'active' : 'pending';
    const id = db.transaction(() => {
      const r = createConv.run('direct', null, directKey(me, otherId), me, status);
      const convId = Number(r.lastInsertRowid);
      addMemberRow.run(convId, me, 'member', null);
      addMemberRow.run(convId, otherId, 'member', null);
      return convId;
    })();
    conv = getConv.get(id);
    joinRooms([me, otherId], id);
    io.to(`user:${otherId}`).emit('new conversation', convView(conv, otherId));
  } else if (conv.status !== 'active' && conv.created_by !== me) {
    // You're reaching out to someone who requested you: that counts as accepting
    setConvStatus.run('active', conv.id);
    emitConvUpdate(conv.id);
    conv = getConv.get(conv.id);
  }

  res.json(convView(conv, me));
});

// Accept or delete a message request
app.post('/api/conversations/:id/respond', requireLogin, (req, res) => {
  const me = req.session.userId;
  const conv = getConv.get(Number(req.params.id));
  if (!conv || conv.type !== 'direct' || !isMember(conv.id, me) || conv.created_by === me || conv.status !== 'pending') {
    return res.status(400).json({ error: 'Nothing to respond to' });
  }
  if (req.body.action === 'accept') {
    setConvStatus.run('active', conv.id);
    emitConvUpdate(conv.id);
    return res.json(convView(getConv.get(conv.id), me));
  }
  setConvStatus.run('declined', conv.id); // sender isn't told
  res.json({ ok: true });
});

app.get('/api/conversations/:id/messages', requireLogin, (req, res) => {
  const me = req.session.userId;
  const convId = Number(req.params.id);
  const conv = getConv.get(convId);
  if (!conv || !isMember(convId, me)) return res.status(403).json({ error: 'Not your conversation' });

  // Read receipts: only if BOTH people have them on (like WhatsApp)
  let otherRead = null;
  if (conv.type === 'direct') {
    const otherId = allMemberIds(convId).find((id) => id !== me);
    const o = getUser.get(otherId);
    const m = getUser.get(me);
    if (o.read_receipts && m.read_receipts && !isBlockedEither(me, otherId)) {
      otherRead = memberRow.get(convId, otherId).receipt_read_id;
    }
  }
  res.json({ messages: getConversationMessages.all(convId), other_read: otherRead });
});

// =====================================================================
// Groups
// =====================================================================
// Everyone added to a group gets an invite they must accept
function inviteUsers(conv, inviterId, ids) {
  const room = GROUP_MAX - memberRowCount.get(conv.id).n;
  const added = [];
  ids.forEach((id) => {
    if (added.length >= room) return;
    if (isBlockedEither(inviterId, id) || memberRow.get(conv.id, id)) return;
    addMemberRow.run(conv.id, id, 'invited', inviterId);
    added.push(id);
  });
  added.forEach((id) => io.to(`user:${id}`).emit('new conversation', convView(conv, id)));
  return added;
}

app.post('/api/groups', requireLogin, (req, res) => {
  const me = req.session.userId;
  const name = text(req.body.name, 40);
  if (!name) return res.status(400).json({ error: 'Group name must be 1-40 characters' });

  const ids = cleanIds(req.body.memberIds, [me]);
  if (ids.length === 0) return res.status(400).json({ error: 'Add at least one other person' });

  const convId = db.transaction(() => {
    const r = createConv.run('group', name, null, me, 'active');
    const id = Number(r.lastInsertRowid);
    addMemberRow.run(id, me, 'member', null);
    return id;
  })();

  joinRooms([me], convId);
  const conv = getConv.get(convId);
  inviteUsers(conv, me, ids);
  postSystem(convId, me, `${displayName(getUser.get(me))} created the group`);
  res.json(convView(getConv.get(convId), me));
});

// Invite more people (any member can)
app.post('/api/groups/:id/members', requireLogin, (req, res) => {
  const me = req.session.userId;
  const conv = getConv.get(Number(req.params.id));
  if (!conv || conv.type !== 'group' || !isMember(conv.id, me)) {
    return res.status(403).json({ error: 'Not your group' });
  }
  const ids = cleanIds(req.body.userIds);
  const added = inviteUsers(conv, me, ids);
  if (!added.length) return res.status(400).json({ error: 'No one new could be invited' });

  emitConvUpdate(conv.id);
  res.json(convView(getConv.get(conv.id), me));
});

// Accept or decline an invite
app.post('/api/groups/:id/respond', requireLogin, (req, res) => {
  const me = req.session.userId;
  const conv = getConv.get(Number(req.params.id));
  const mr = conv && memberRow.get(conv.id, me);
  if (!conv || conv.type !== 'group' || !mr || mr.status !== 'invited') {
    return res.status(400).json({ error: 'No invite found' });
  }

  if (req.body.accept) {
    setMemberStatus.run('member', conv.id, me);
    setRead.run(lastMsgId.get(conv.id).id, 0, 0, conv.id, me); // old messages don't count as unread
    joinRooms([me], conv.id);
    postSystem(conv.id, me, `${displayName(getUser.get(me))} joined`);
    emitConvUpdate(conv.id);
    return res.json(convView(getConv.get(conv.id), me));
  }

  removeMemberRow.run(conv.id, me);
  io.to(`user:${me}`).emit('conversation removed', { id: conv.id });
  emitConvUpdate(conv.id);
  res.json({ ok: true });
});

app.post('/api/groups/:id/leave', requireLogin, (req, res) => {
  const me = req.session.userId;
  const conv = getConv.get(Number(req.params.id));
  if (!conv || conv.type !== 'group' || !isMember(conv.id, me)) {
    return res.status(403).json({ error: 'Not your group' });
  }
  const name = displayName(getUser.get(me));

  removeMemberRow.run(conv.id, me);
  io.in(`user:${me}`).socketsLeave(`conv:${conv.id}`);
  io.to(`user:${me}`).emit('conversation removed', { id: conv.id });
  postSystem(conv.id, me, `${name} left`);
  emitConvUpdate(conv.id);
  res.json({ ok: true });
});

// Edit group name / about
app.put('/api/groups/:id', requireLogin, (req, res) => {
  const me = req.session.userId;
  const conv = getConv.get(Number(req.params.id));
  if (!conv || conv.type !== 'group' || !isMember(conv.id, me)) {
    return res.status(403).json({ error: 'Not your group' });
  }
  const name = text(req.body.name, 40);
  const about = text(req.body.about, 200);
  if (!name) return res.status(400).json({ error: 'Group name can\u2019t be empty' });

  updateGroup.run(name, about, conv.id);
  if (name !== conv.name) {
    postSystem(conv.id, me, `${displayName(getUser.get(me))} renamed the group to \u201c${name}\u201d`);
  }
  emitConvUpdate(conv.id);
  res.json(convView(getConv.get(conv.id), me));
});

app.put('/api/groups/:id/avatar', requireLogin, (req, res) => {
  const me = req.session.userId;
  const conv = getConv.get(Number(req.params.id));
  if (!conv || conv.type !== 'group' || !isMember(conv.id, me)) {
    return res.status(403).json({ error: 'Not your group' });
  }
  if (req.body.remove) {
    setConvAvatar.run(null, conv.id);
  } else {
    const img = parseJpegDataUrl(req.body.image);
    if (!img) return res.status(400).json({ error: 'Invalid image' });
    setConvAvatar.run(img, conv.id);
  }
  emitConvUpdate(conv.id);
  res.json(convView(getConv.get(conv.id), me));
});

// =====================================================================
// Pages
// =====================================================================
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store'); // stops the back button showing a previous user's chats
  if (!req.session.userId || !getUser.get(req.session.userId)) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login.html', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.session.userId && getUser.get(req.session.userId)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use(express.static('public', { index: false }));

// =====================================================================
// Socket.IO
// =====================================================================
io.engine.use(sessionMiddleware);

io.use((socket, next) => {
  const sess = socket.request.session;
  if (sess && sess.userId && getUser.get(sess.userId)) return next();
  next(new Error('unauthorized'));
});

const notice = (socket, msg) => socket.emit('notice', msg);

io.on('connection', (socket) => {
  const userId = socket.request.session.userId;
  console.log(`${socket.request.session.username} connected`);

  socket.join(`user:${userId}`);
  socket.join(`sess:${socket.request.sessionID}`);
  myConvRows.all(userId).filter((r) => r.my_status === 'member').forEach((r) => socket.join(`conv:${r.id}`));

  // Presence
  const count = (onlineCounts.get(userId) || 0) + 1;
  onlineCounts.set(userId, count);
  if (count === 1) io.emit('presence', { userId, online: true });

  socket.emit('me', selfProfile(userId));
  socket.emit('online users', [...onlineCounts.keys()]);

  // ----- Send a message -----
  socket.on('chat message', (data) => {
    const convId = Number(data && data.conversationId);
    const conv = convId && getConv.get(convId);
    if (!conv || !isMember(convId, userId)) return;

    const body = typeof data.text === 'string' ? data.text.trim() : '';
    if (!body || body.length > 2000) return;

    let room = `conv:${convId}`;

    if (conv.type === 'direct') {
      const otherId = allMemberIds(convId).find((id) => id !== userId);
      if (isBlockedEither(userId, otherId)) {
        return notice(socket, iBlocked.get(userId, otherId)
          ? 'Unblock this user to send messages'
          : "This message couldn't be sent");
      }
      if (conv.status !== 'active') {
        if (conv.created_by === userId) {
          // Still a request: limited messages until they accept
          if (sentCount.get(convId, userId).n >= PENDING_LIMIT) {
            return notice(socket, 'Wait for them to accept your request before sending more');
          }
          if (conv.status === 'declined') room = `user:${userId}`; // quietly stays with the sender
        } else {
          // Replying to a request counts as accepting it
          setConvStatus.run('active', convId);
          emitConvUpdate(convId);
        }
      }
    }

    const result = insertMessage.run(convId, userId, body);
    io.to(room).emit('chat message', getMessage.get(result.lastInsertRowid));
  });

  // ----- Typing -----
  socket.on('typing', (data) => {
    const convId = Number(data && data.conversationId);
    const conv = convId && getConv.get(convId);
    if (!conv || !isMember(convId, userId)) return;
    if (conv.type === 'direct') {
      const otherId = allMemberIds(convId).find((id) => id !== userId);
      if (isBlockedEither(userId, otherId) || conv.status === 'declined') return;
    }
    socket.to(`conv:${convId}`).emit('typing', {
      conversationId: convId,
      username: displayName(getUser.get(userId))
    });
  });

  // ----- Mark a conversation as read -----
  socket.on('mark read', (data) => {
    const convId = Number(data && data.conversationId);
    const conv = convId && getConv.get(convId);
    if (!conv || !isMember(convId, userId)) return;
    // Unaccepted requests aren't marked read (so the sender doesn't see "Seen")
    if (conv.type === 'direct' && conv.status !== 'active' && conv.created_by !== userId) return;

    const upTo = lastMsgId.get(convId).id;
    const me = getUser.get(userId);
    setRead.run(upTo, me.read_receipts ? 1 : 0, upTo, convId, userId);

    if (conv.type === 'direct' && me.read_receipts) {
      const otherId = allMemberIds(convId).find((id) => id !== userId);
      const o = getUser.get(otherId);
      if (o && o.read_receipts && !isBlockedEither(userId, otherId)) {
        io.to(`user:${otherId}`).emit('read', { conversationId: convId, upTo });
      }
    }
  });

  // ----- Edit (own messages only) -----
  socket.on('edit message', (data) => {
    const msg = getRawMessage.get(Number(data && data.id));
    if (!msg || msg.user_id !== userId || msg.deleted || msg.kind !== 'user') return;
    if (!isMember(msg.conversation_id, userId)) return;

    const body = typeof data.text === 'string' ? data.text.trim() : '';
    if (!body || body.length > 2000) return;

    updateMessageText.run(body, msg.id);
    io.to(`conv:${msg.conversation_id}`).emit('message updated', getMessage.get(msg.id));
  });

  // ----- Delete (own messages only) -----
  socket.on('delete message', (data) => {
    const msg = getRawMessage.get(Number(data && data.id));
    if (!msg || msg.user_id !== userId || msg.kind !== 'user') return;
    if (!isMember(msg.conversation_id, userId)) return;

    softDeleteMessage.run(msg.id);
    io.to(`conv:${msg.conversation_id}`).emit('message updated', getMessage.get(msg.id));
  });

  socket.on('disconnect', () => {
    console.log(`${socket.request.session.username} disconnected`);
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