const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5 * 1024 * 1024 // allow chunked file pieces up to 5MB each
});

app.use(express.static(path.join(__dirname, 'index.html')));

// roomId -> Map(socketId -> displayName)
const rooms = new Map();

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentName = null;

  socket.on('join-room', ({ roomId, name }) => {
    if (!roomId || !name) return;
    currentRoom = roomId;
    currentName = name;

    socket.join(roomId);
    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const members = rooms.get(roomId);

    // send the new user the list of people already in the room
    const existing = Array.from(members.entries()).map(([id, n]) => ({ id, name: n }));
    socket.emit('existing-users', existing);

    members.set(socket.id, name);

    // tell everyone else someone joined
    socket.to(roomId).emit('user-joined', { id: socket.id, name });

    io.to(roomId).emit('member-count', members.size);
  });

  // WebRTC signaling relay (mesh: each pair of peers connects directly)
  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // Text chat
  socket.on('chat-message', ({ text }) => {
    if (!currentRoom || !text) return;
    io.to(currentRoom).emit('chat-message', {
      id: socket.id,
      name: currentName,
      text: String(text).slice(0, 2000),
      time: Date.now()
    });
  });

  // File / photo sharing — relayed in chunks through the server
  socket.on('file-start', (meta) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('file-start', { ...meta, from: socket.id, name: currentName });
  });
  socket.on('file-chunk', (chunk) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('file-chunk', chunk);
  });
  socket.on('file-end', (info) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('file-end', info);
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const members = rooms.get(currentRoom);
    if (members) {
      members.delete(socket.id);
      if (members.size === 0) rooms.delete(currentRoom);
      else io.to(currentRoom).emit('member-count', members.size);
    }
    socket.to(currentRoom).emit('user-left', { id: socket.id });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`MeetRoom running on http://localhost:${PORT}`));
