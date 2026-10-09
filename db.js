const Database = require('better-sqlite3');

const db = new Database('chat.db');

// ---------- Base tables ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL DEFAULT 'direct',
    name       TEXT,
    direct_key TEXT UNIQUE,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    user_id         INTEGER NOT NULL REFERENCES users(id),
    joined_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    user_id         INTEGER NOT NULL REFERENCES users(id),
    text            TEXT NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    edited_at       DATETIME,
    deleted         INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id),
    blocked_id INTEGER NOT NULL REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (blocker_id, blocked_id)
  );

  -- user_a is always the smaller id. status: 'pending' or 'accepted'
  CREATE TABLE IF NOT EXISTS friendships (
    user_a       INTEGER NOT NULL REFERENCES users(id),
    user_b       INTEGER NOT NULL REFERENCES users(id),
    requested_by INTEGER NOT NULL REFERENCES users(id),
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_a, user_b)
  );
`);

// ---------- Migrations ----------
// Adds a column only if it's missing, so your existing chat.db keeps working
// (no need to delete it any more).
function ensureColumn(table, column, definition, onAdded) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    if (onAdded) onAdded();
  }
}

// users: profile + privacy settings
ensureColumn('users', 'display_name', 'TEXT');
ensureColumn('users', 'avatar', 'TEXT');
ensureColumn('users', 'avatar_v', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'bio', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'note', 'TEXT');
ensureColumn('users', 'note_at', 'DATETIME');
ensureColumn('users', 'read_receipts', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('users', 'pfp_vis', "TEXT NOT NULL DEFAULT 'everyone'");
ensureColumn('users', 'bio_vis', "TEXT NOT NULL DEFAULT 'everyone'");

// conversations: request state + group profile
ensureColumn('conversations', 'status', "TEXT NOT NULL DEFAULT 'active'"); // active | pending | declined
ensureColumn('conversations', 'about', "TEXT NOT NULL DEFAULT ''");
ensureColumn('conversations', 'avatar', 'TEXT');
ensureColumn('conversations', 'avatar_v', 'INTEGER NOT NULL DEFAULT 0');

// members: invite state + read tracking
ensureColumn('conversation_members', 'status', "TEXT NOT NULL DEFAULT 'member'"); // member | invited
ensureColumn('conversation_members', 'invited_by', 'INTEGER');
ensureColumn('conversation_members', 'receipt_read_id', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('conversation_members', 'last_read_id', 'INTEGER NOT NULL DEFAULT 0', () => {
  // First time only: treat all existing messages as already read
  db.exec(`
    UPDATE conversation_members SET last_read_id = COALESCE(
      (SELECT MAX(id) FROM messages WHERE conversation_id = conversation_members.conversation_id), 0)
  `);
});

// messages: 'user' or 'system' (e.g. "alice left")
ensureColumn('messages', 'kind', "TEXT NOT NULL DEFAULT 'user'");

module.exports = db;