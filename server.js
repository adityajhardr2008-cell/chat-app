const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Prepared statements: SQL we write once and reuse
const insertMessage = db.prepare('INSERT INTO messages (name, text) VALUES (?, ?)');
const getMessage = db.prepare('SELECT * FROM messages WHERE id = ?');
const getRecentMessages = db.prepare(
  'SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 50) ORDER BY id ASC'
);

io.on('connection', (socket) => {
  console.log('A user connected');

  // 1. Send the last 50 saved messages to the user who just connected
  socket.emit('history', getRecentMessages.all());

  // 2. When a message arrives: save it, then broadcast it
  socket.on('chat message', (data) => {
    const result = insertMessage.run(data.name, data.text);
    const saved = getMessage.get(result.lastInsertRowid);
    io.emit('chat message', saved);
  });

  socket.on('disconnect', () => {
    console.log('A user disconnected');
  });
});

server.listen(3000, () => {
  console.log('Running at http://localhost:3000');
});