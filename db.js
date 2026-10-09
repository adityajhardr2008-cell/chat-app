const Database = require('better-sqlite3');

// Opens chat.db, or creates it if it doesn't exist
const db = new Database('chat.db');

// Create the table if it's not there yet
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

module.exports = db;