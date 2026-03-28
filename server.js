const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage
const users = new Map();       // userId -> { id, login, password, displayName, avatar, status, createdAt }
const sessions = new Map();    // token -> userId
const messages = new Map();    // convId -> array of messages
const groups = new Map();      // groupId -> { id, name, avatar, ownerId, members: Set, admins: Set, createdAt }
const channels = new Map();    // channelId -> { id, name, description, avatar, ownerId, subscribers: Set, createdAt }

function generateId() {
  return crypto.randomBytes(16).toString('hex');
}

function getPrivateConversationId(user1, user2) {
  return [user1, user2].sort().join('_');
}

function saveMessage(convId, message) {
  if (!messages.has(convId)) messages.set(convId, []);
  messages.get(convId).push(message);
}

// Demo data
function initDemoData() {
  const demoUsers = [
    { login: 'alice', password: '123', displayName: 'Alice', avatar: '', status: 'online' },
    { login: 'bob', password: '123', displayName: 'Bob', avatar: '', status: 'online' },
    { login: 'charlie', password: '123', displayName: 'Charlie', avatar: '', status: 'away' }
  ];
  demoUsers.forEach(user => {
    const id = generateId();
    users.set(id, {
      id, login: user.login, password: user.password,
      displayName: user.displayName, avatar: user.avatar,
      status: user.status, createdAt: new Date().toISOString()
    });
  });

  const aliceId = [...users.values()].find(u => u.login === 'alice').id;
  const bobId = [...users.values()].find(u => u.login === 'bob').id;
  const charlieId = [...users.values()].find(u => u.login === 'charlie').id;

  const groupId = generateId();
  groups.set(groupId, {
    id: groupId, name: 'Tech Talk', avatar: '', ownerId: aliceId,
    members: new Set([aliceId, bobId, charlieId]),
    admins: new Set([aliceId]), createdAt: new Date().toISOString()
  });

  const channelId = generateId();
  channels.set(channelId, {
    id: channelId, name: 'Announcements', description: 'Official news', avatar: '', ownerId: aliceId,
    subscribers: new Set([aliceId, bobId, charlieId]), createdAt: new Date().toISOString()
  });

  const convId = getPrivateConversationId(aliceId, bobId);
  saveMessage(convId, { id: generateId(), senderId: aliceId, type: 'text', content: 'Hi Bob!', timestamp: Date.now() });
  saveMessage(convId, { id: generateId(), senderId: bobId, type: 'text', content: 'Hello Alice!', timestamp: Date.now() });
}
initDemoData();

// API endpoints
app.post('/register', (req, res) => {
  const { login, password, displayName } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Login and password required' });
  if ([...users.values()].some(u => u.login === login)) return res.status(400).json({ error: 'User already exists' });
  const id = generateId();
  users.set(id, { id, login, password, displayName: displayName || login, avatar: '', status: 'online', createdAt: new Date().toISOString() });
  res.json({ success: true, userId: id });
});

app.post('/login', (req, res) => {
  const { login, password } = req.body;
  const user = [...users.values()].find(u => u.login === login && u.password === password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const token = generateId();
  sessions.set(token, user.id);
  res.json({ token, user: { id: user.id, login: user.login, displayName: user.displayName, avatar: user.avatar, status: user.status } });
});

app.get('/search-users', (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const results = [...users.values()].filter(u => u.login.toLowerCase().includes(q.toLowerCase())).map(u => ({
    id: u.id, login: u.login, displayName: u.displayName, avatar: u.avatar, status: u.status
  }));
  res.json(results);
});

app.post('/update-profile', (req, res) => {
  const { token, displayName, avatar, status } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const user = users.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (displayName) user.displayName = displayName;
  if (avatar !== undefined) user.avatar = avatar;
  if (status) user.status = status;
  users.set(userId, user);
  const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === userId);
  sockets.forEach(s => s.emit('profile-updated', { userId, displayName: user.displayName, avatar: user.avatar, status: user.status }));
  res.json({ success: true, user: { id: user.id, login: user.login, displayName: user.displayName, avatar: user.avatar, status: user.status } });
});

app.get('/user/:id', (req, res) => {
  const user = users.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ id: user.id, login: user.login, displayName: user.displayName, avatar: user.avatar, status: user.status, createdAt: user.createdAt });
});

app.post('/create-group', (req, res) => {
  const { token, name, memberIds } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const groupId = generateId();
  const group = {
    id: groupId, name: name || 'New Group', avatar: '', ownerId: userId,
    members: new Set([userId, ...(memberIds || [])]), admins: new Set([userId]), createdAt: new Date().toISOString()
  };
  groups.set(groupId, group);
  group.members.forEach(mid => {
    const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === mid);
    sockets.forEach(s => s.emit('group-created', group));
  });
  res.json({ success: true, group });
});

app.post('/create-channel', (req, res) => {
  const { token, name, description } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const channelId = generateId();
  const channel = {
    id: channelId, name: name || 'New Channel', description: description || '', avatar: '', ownerId: userId,
    subscribers: new Set([userId]), createdAt: new Date().toISOString()
  };
  channels.set(channelId, channel);
  const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === userId);
  sockets.forEach(s => s.emit('channel-created', channel));
  res.json({ success: true, channel });
});

app.post('/group/add-member', (req, res) => {
  const { token, groupId, userIdToAdd } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const group = groups.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!group.admins.has(userId)) return res.status(403).json({ error: 'Not admin' });
  group.members.add(userIdToAdd);
  groups.set(groupId, group);
  group.members.forEach(mid => {
    const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === mid);
    sockets.forEach(s => s.emit('group-updated', group));
  });
  res.json({ success: true });
});

app.get('/my-groups', (req, res) => {
  const { token } = req.query;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const userGroups = [...groups.values()].filter(g => g.members.has(userId));
  res.json(userGroups);
});

app.get('/my-channels', (req, res) => {
  const { token } = req.query;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const userChannels = [...channels.values()].filter(c => c.subscribers.has(userId));
  res.json(userChannels);
});

app.post('/channel/subscribe', (req, res) => {
  const { token, channelId } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const channel = channels.get(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  channel.subscribers.add(userId);
  channels.set(channelId, channel);
  res.json({ success: true });
});

// Socket.io
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  const userId = sessions.get(token);
  if (!userId) return next(new Error('Invalid token'));
  socket.userId = userId;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.userId;
  console.log(`User ${userId} connected`);
  socket.join(`user:${userId}`);

  // Send initial conversations
  const userGroups = [...groups.values()].filter(g => g.members.has(userId));
  const userChannels = [...channels.values()].filter(c => c.subscribers.has(userId));
  const privateChats = new Set();
  for (let [convId, msgs] of messages.entries()) {
    if (convId.includes('_')) {
      const [id1, id2] = convId.split('_');
      if (id1 === userId || id2 === userId) privateChats.add(convId);
    }
  }
  const convsList = {
    private: Array.from(privateChats).map(convId => {
      const otherId = convId.split('_').find(id => id !== userId);
      const otherUser = users.get(otherId);
      return {
        type: 'private', id: convId, name: otherUser?.displayName || otherId,
        avatar: otherUser?.avatar || '', lastMessage: messages.get(convId)?.[messages.get(convId).length - 1] || null
      };
    }),
    groups: userGroups.map(g => ({ type: 'group', id: g.id, name: g.name, avatar: g.avatar })),
    channels: userChannels.map(c => ({ type: 'channel', id: c.id, name: c.name, avatar: c.avatar }))
  };
  socket.emit('conversations', convsList);

  socket.on('send-message', (data) => {
    const { convId, type, content, replyTo } = data;
    if (!convId || !content) return;
    const message = {
      id: generateId(), senderId: userId, type: type || 'text', content, timestamp: Date.now(), replyTo
    };
    saveMessage(convId, message);
    let recipients = new Set();
    if (convId.includes('_')) {
      const [id1, id2] = convId.split('_');
      recipients.add(id1); recipients.add(id2);
    } else if (groups.has(convId)) {
      groups.get(convId).members.forEach(m => recipients.add(m));
    } else if (channels.has(convId)) {
      channels.get(convId).subscribers.forEach(s => recipients.add(s));
    } else return;
    recipients.forEach(uid => io.to(`user:${uid}`).emit('new-message', { convId, message }));
  });

  socket.on('load-messages', (convId, callback) => {
    const msgs = messages.get(convId) || [];
    callback(msgs.slice(-100));
  });

  socket.on('call-user', ({ targetUserId, offer }) => {
    io.to(`user:${targetUserId}`).emit('incoming-call', { from: userId, offer });
  });
  socket.on('call-answer', ({ targetUserId, answer }) => {
    io.to(`user:${targetUserId}`).emit('call-answered', { from: userId, answer });
  });
  socket.on('ice-candidate', ({ targetUserId, candidate }) => {
    io.to(`user:${targetUserId}`).emit('ice-candidate', { from: userId, candidate });
  });
  socket.on('call-end', ({ targetUserId }) => {
    io.to(`user:${targetUserId}`).emit('call-ended', { from: userId });
  });
  socket.on('toggle-media', ({ targetUserId, type, enabled }) => {
    io.to(`user:${targetUserId}`).emit('media-toggled', { from: userId, type, enabled });
  });

  socket.on('disconnect', () => {
    console.log(`User ${userId} disconnected`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SkyMessage running on http://localhost:${PORT}`));
