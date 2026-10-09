const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve everything in the "public" folder to browsers
app.use(express.static('public'));

// Runs every time a user opens the page and connects
io.on('connection', (socket) => {
  console.log('A user connected');

  // Runs when THIS user sends a message
  socket.on('chat message', (data) => {
    io.emit('chat message', data); // send to EVERYONE
  });

  socket.on('disconnect', () => {
    console.log('A user disconnected');
  });
});

server.listen(3000, () => {
  console.log('Running at http://localhost:3000');
});