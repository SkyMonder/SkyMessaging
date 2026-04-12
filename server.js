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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Отключаем кэширование HTML
app.use((req, res, next) => {
  if (req.url.endsWith('.html') || req.url === '/' || req.url === '/index.html') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ========== ПОДКЛЮЧЕНИЕ К ВНЕШНЕМУ ХРАНИЛИЩУ ==========
const STORAGE_URL = 'https://skymessagedb.onrender.com';

async function storageRequest(endpoint, method = 'GET', body = null) {
  const url = `${STORAGE_URL}${endpoint}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Storage error: ${res.status}`);
  return res.json();
}

function generateId() {
  return crypto.randomBytes(16).toString('hex');
}

function getPrivateConversationId(user1, user2) {
  return [user1, user2].sort().join('_');
}

// Health check
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// ==================== API ====================
app.post('/register', async (req, res) => {
  const { login, password, displayName } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Login and password required' });
  try {
    const users = await storageRequest('/api/users');
    const existing = Object.values(users).find(u => u.login === login);
    if (existing) return res.status(400).json({ error: 'User already exists' });
    const id = generateId();
    const newUser = {
      id, login, password, displayName: displayName || login, avatar: '', status: 'online', createdAt: new Date().toISOString()
    };
    await storageRequest('/api/users/' + id, 'PUT', newUser);
    res.json({ success: true, userId: id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.post('/login', async (req, res) => {
  const { login, password } = req.body;
  try {
    const users = await storageRequest('/api/users');
    const user = Object.values(users).find(u => u.login === login && u.password === password);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const token = generateId();
    await storageRequest('/api/sessions/' + token, 'PUT', { token, userId: user.id });
    res.json({ token, user: { id: user.id, login: user.login, displayName: user.displayName, avatar: user.avatar, status: user.status } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.get('/me', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const sessions = await storageRequest('/api/sessions');
    const session = sessions[token];
    if (!session) return res.status(401).json({ error: 'Invalid token' });
    const users = await storageRequest('/api/users');
    const user = users[session.userId];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, login: user.login, displayName: user.displayName, avatar: user.avatar, status: user.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.get('/search-users', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  try {
    const users = await storageRequest('/api/users');
    const results = Object.values(users).filter(u => u.login.toLowerCase().includes(q.toLowerCase())).map(u => ({
      id: u.id, login: u.login, displayName: u.displayName, avatar: u.avatar, status: u.status
    }));
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.get('/search-groups', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const sessions = await storageRequest('/api/sessions');
    const session = sessions[token];
    if (!session) return res.status(401).json({ error: 'Invalid token' });
    const userId = session.userId;
    const groups = await storageRequest('/api/groups');
    const { q } = req.query;
    if (!q) return res.json([]);
    const results = Object.values(groups).filter(g => g.name.toLowerCase().includes(q.toLowerCase()));
    const formatted = results.map(g => ({
      id: g.id,
      name: g.name,
      avatar: g.avatar,
      memberCount: g.members.length,
      joined: g.members.includes(userId)
    }));
    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.get('/search-channels', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const sessions = await storageRequest('/api/sessions');
    const session = sessions[token];
    if (!session) return res.status(401).json({ error: 'Invalid token' });
    const userId = session.userId;
    const channels = await storageRequest('/api/channels');
    const { q } = req.query;
    if (!q) return res.json([]);
    const results = Object.values(channels).filter(c => c.name.toLowerCase().includes(q.toLowerCase()));
    const formatted = results.map(c => ({
      id: c.id,
      name: c.name,
      description: c.description,
      avatar: c.avatar,
      subscriberCount: c.subscribers.length,
      subscribed: c.subscribers.includes(userId)
    }));
    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.post('/update-profile', async (req, res) => {
  const { token, displayName, avatar, status } = req.body;
  try {
    const sessions = await storageRequest('/api/sessions');
    const session = sessions[token];
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    const userId = session.userId;
    const users = await storageRequest('/api/users');
    const user = users[userId];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (displayName) user.displayName = displayName;
    if (avatar !== undefined) user.avatar = avatar;
    if (status) user.status = status;
    await storageRequest('/api/users/' + userId, 'PUT', user);
    const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === userId);
    sockets.forEach(s => s.emit('profile-updated', { userId, displayName: user.displayName, avatar: user.avatar, status: user.status }));
    res.json({ success: true, user: { id: user.id, login: user.login, displayName: user.displayName, avatar: user.avatar, status: user.status } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.get('/user/:id', async (req, res) => {
  try {
    const users = await storageRequest('/api/users');
    const user = users[req.params.id];
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json({ id: user.id, login: user.login, displayName: user.displayName, avatar: user.avatar, status: user.status, createdAt: user.createdAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

// Groups
app.post('/create-group', async (req, res) => {
  const { token, name, memberIds } = req.body;
  try {
    const sessions = await storageRequest('/api/sessions');
    const session = sessions[token];
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    const userId = session.userId;
    const groupId = generateId();
    const group = {
      id: groupId, name: name || 'New Group', avatar: '', ownerId: userId,
      members: [userId, ...(memberIds || [])],
      admins: [userId],
      createdAt: new Date().toISOString()
    };
    await storageRequest('/api/groups/' + groupId, 'PUT', group);
    group.members.forEach(mid => {
      const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === mid);
      sockets.forEach(s => s.emit('group-created', group));
    });
    res.json({ success: true, group });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.get('/group/:id', async (req, res) => {
  try {
    const groups = await storageRequest('/api/groups');
    const group = groups[req.params.id];
    if (!group) return res.status(404).json({ error: 'Not found' });
    const users = await storageRequest('/api/users');
    const members = group.members.map(id => users[id]).filter(u => u);
    res.json({ ...group, members, admins: group.admins });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.post('/group/update', async (req, res) => {
  const { token, groupId, name, avatar } = req.body;
  try {
    const sessions = await storageRequest('/api/sessions');
    const session = sessions[token];
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    const userId = session.userId;
    const groups = await storageRequest('/api/groups');
    const group = groups[groupId];
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.admins.includes(userId)) return res.status(403).json({ error: 'Not admin' });
    if (name) group.name = name;
    if (avatar !== undefined) group.avatar = avatar;
    await storageRequest('/api/groups/' + groupId, 'PUT', group);
    group.members.forEach(mid => {
      const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === mid);
      sockets.forEach(s => s.emit('group-updated', group));
    });
    res.json({ success: true, group });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.post('/group/add-member', async (req, res) => {
  const { token, groupId, userIdToAdd } = req.body;
  try {
    const sessions = await storageRequest('/api/sessions');
    const session = sessions[token];
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    const userId = session.userId;
    const groups = await storageRequest('/api/groups');
    const group = groups[groupId];
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.admins.includes(userId)) return res.status(403).json({ error: 'Not admin' });
    if (group.members.includes(userIdToAdd)) return res.json({ success: true, message: 'Already member' });
    group.members.push(userIdToAdd);
    await storageRequest('/api/groups/' + groupId, 'PUT', group);
    group.members.forEach(mid => {
      const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === mid);
      sockets.forEach(s => s.emit('group-updated', group));
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.post('/group/remove-member', async (req, res) => {
  const { token, groupId, userIdToRemove } = req.body;
  try {
    const sessions = await storageRequest('/api/sessions');
    const session = sessions[token];
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    const userId = session.userId;
    const groups = await storageRequest('/api/groups');
    const group = groups[groupId];
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.admins.includes(userId) && userId !== userIdToRemove) return res.status(403).json({ error: 'Not admin' });
    if (!group.members.includes(userIdToRemove)) return res.json({ success: true, message: 'Not a member' });
    group.members = group.members.filter(id => id !== userIdToRemove);
    group.admins = group.admins.filter(id => id !== userIdToRemove);
    if (group.ownerId === userIdToRemove) {
      const newOwner = group.admins[0] || group.members[0];
      if (newOwner) group.ownerId = newOwner;
    }
    await storageRequest('/api/groups/' + groupId, 'PUT', group);
    group.members.forEach(mid => {
      const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === mid);
      sockets.forEach(s => s.emit('group-updated', group));
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.post('/group/set-admin', async (req, res) => {
  const { token, groupId, userIdToSet, isAdmin } = req.body;
  try {
    const sessions = await storageRequest('/api/sessions');
    const session = sessions[token];
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    const userId = session.userId;
    const groups = await storageRequest('/api/groups');
    const group = groups[groupId];
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.admins.includes(userId)) return res.status(403).json({ error: 'Not admin' });
    if (!group.members.includes(userIdToSet)) return res.status(400).json({ error: 'Not a member' });
    if (isAdmin) {
      if (!group.admins.includes(userIdToSet)) group.admins.push(userIdToSet);
    } else {
      group.admins = group.admins.filter(id => id !== userIdToSet);
    }
    await storageRequest('/api/groups/' + groupId, 'PUT', group);
    group.members.forEach(mid => {
      const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === mid);
      sockets.forEach(s => s.emit('group-updated', group));
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.post('/group/join', async (req, res) => {
  const { token, groupId } = req.body;
  try {
    const sessions = await storageRequest('/api/sessions');
    const session = sessions[token];
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    const userId = session.userId;
    const groups = await storageRequest('/api/groups');
    const group = groups[groupId];
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (group.members.includes(userId)) return res.json({ success: true, message: 'Already member' });
    group.members.push(userId);
    await storageRequest('/api/groups/' + groupId, 'PUT', group);
    group.members.forEach(mid => {
      const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === mid);
      sockets.forEach(s => s.emit('group-updated', group));
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

// Channels
app.post('/create-channel', async (req, res) => {
  const { token, name, description } = req.body;
  try {
    const sessions = await storageRequest('/api/sessions');
    const session = sessions[token];
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    const userId = session.userId;
    const channelId = generateId();
    const channel = {
      id: channelId, name: name || 'New Channel', description: description || '', avatar: '', ownerId: userId,
      subscribers: [userId], admins: [userId], createdAt: new Date().toISOString()
    };
    await storageRequest('/api/channels/' + channelId, 'PUT', channel);
    const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === userId);
    sockets.forEach(s => s.emit('channel-created', channel));
    res.json({ success: true, channel });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.get('/channel/:id', async (req, res) => {
  try {
    const channels = await storageRequest('/api/channels');
    const channel = channels[req.params.id];
    if (!channel) return res.status(404).json({ error: 'Not found' });
    const users = await storageRequest('/api/users');
    const subscribers = channel.subscribers.map(id => users[id]).filter(u => u);
    res.json({ ...channel, subscribers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.post('/channel/subscribe', async (req, res) => {
  const { token, channelId } = req.body;
  try {
    const sessions = await storageRequest('/api/sessions');
    const session = sessions[token];
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    const userId = session.userId;
    const channels = await storageRequest('/api/channels');
    const channel = channels[channelId];
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!channel.subscribers.includes(userId)) {
      channel.subscribers.push(userId);
      await storageRequest('/api/channels/' + channelId, 'PUT', channel);
    }
    channel.subscribers.forEach(sid => {
      const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === sid);
      sockets.forEach(s => s.emit('channel-updated', channel));
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.post('/channel/unsubscribe', async (req, res) => {
  const { token, channelId } = req.body;
  try {
    const sessions = await storageRequest('/api/sessions');
    const session = sessions[token];
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    const userId = session.userId;
    const channels = await storageRequest('/api/channels');
    const channel = channels[channelId];
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    channel.subscribers = channel.subscribers.filter(id => id !== userId);
    await storageRequest('/api/channels/' + channelId, 'PUT', channel);
    channel.subscribers.forEach(sid => {
      const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === sid);
      sockets.forEach(s => s.emit('channel-updated', channel));
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.post('/channel/update', async (req, res) => {
  const { token, channelId, name, description, avatar } = req.body;
  try {
    const sessions = await storageRequest('/api/sessions');
    const session = sessions[token];
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    const userId = session.userId;
    const channels = await storageRequest('/api/channels');
    const channel = channels[channelId];
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (channel.ownerId !== userId) return res.status(403).json({ error: 'Not owner' });
    if (name) channel.name = name;
    if (description !== undefined) channel.description = description;
    if (avatar !== undefined) channel.avatar = avatar;
    await storageRequest('/api/channels/' + channelId, 'PUT', channel);
    channel.subscribers.forEach(sid => {
      const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === sid);
      sockets.forEach(s => s.emit('channel-updated', channel));
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.get('/my-groups', async (req, res) => {
  const { token } = req.query;
  try {
    const sessions = await storageRequest('/api/sessions');
    const session = sessions[token];
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    const userId = session.userId;
    const groups = await storageRequest('/api/groups');
    const userGroups = Object.values(groups).filter(g => g.members.includes(userId));
    res.json(userGroups);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

app.get('/my-channels', async (req, res) => {
  const { token } = req.query;
  try {
    const sessions = await storageRequest('/api/sessions');
    const session = sessions[token];
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    const userId = session.userId;
    const channels = await storageRequest('/api/channels');
    const userChannels = Object.values(channels).filter(c => c.subscribers.includes(userId));
    res.json(userChannels);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Storage error' });
  }
});

// ==================== SOCKET.IO ====================
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const sessions = await storageRequest('/api/sessions');
    const session = sessions[token];
    if (!session) return next(new Error('Invalid token'));
    socket.userId = session.userId;
    next();
  } catch (err) {
    next(new Error('Storage error'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.userId;
  console.log(`User ${userId} connected`);
  socket.join(`user:${userId}`);

  socket.on('get-conversations', async () => {
    try {
      const users = await storageRequest('/api/users');
      const groups = await storageRequest('/api/groups');
      const channels = await storageRequest('/api/channels');
      const messages = await storageRequest('/api/messages');
      
      const userGroups = Object.values(groups).filter(g => g.members.includes(userId));
      const userChannels = Object.values(channels).filter(c => c.subscribers.includes(userId));
      const privateChats = new Set();
      for (let convId in messages) {
        if (convId.includes('_')) {
          const [id1, id2] = convId.split('_');
          if (id1 === userId || id2 === userId) privateChats.add(convId);
        }
      }
      const convsList = {
        private: Array.from(privateChats).map(convId => {
          const otherId = convId.split('_').find(id => id !== userId);
          const otherUser = users[otherId];
          const lastMessage = messages[convId]?.[messages[convId].length - 1] || null;
          return {
            type: 'private', id: convId, name: otherUser?.displayName || otherId,
            avatar: otherUser?.avatar || '', lastMessage
          };
        }),
        groups: userGroups.map(g => ({ type: 'group', id: g.id, name: g.name, avatar: g.avatar })),
        channels: userChannels.map(c => ({ type: 'channel', id: c.id, name: c.name, avatar: c.avatar }))
      };
      socket.emit('conversations', convsList);
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('send-message', async (data) => {
    const { convId, type, content } = data;
    if (!convId || !content) return;
    const messageId = generateId();
    const timestamp = Date.now();
    const message = { id: messageId, senderId: userId, type, content, timestamp };
    try {
      const allMessages = await storageRequest('/api/messages');
      const convMessages = allMessages[convId] || [];
      convMessages.push(message);
      await storageRequest('/api/messages/' + convId, 'PUT', convMessages);
      
      let recipients = new Set();
      if (convId.includes('_')) {
        const [id1, id2] = convId.split('_');
        recipients.add(id1); recipients.add(id2);
      } else {
        const groups = await storageRequest('/api/groups');
        const channels = await storageRequest('/api/channels');
        if (groups[convId]) {
          groups[convId].members.forEach(m => recipients.add(m));
        } else if (channels[convId]) {
          channels[convId].subscribers.forEach(s => recipients.add(s));
        }
      }
      recipients.forEach(uid => {
        io.to(`user:${uid}`).emit('new-message', { convId, message });
      });
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('load-messages', async (convId, callback) => {
    try {
      const allMessages = await storageRequest('/api/messages');
      const msgs = allMessages[convId] || [];
      callback(msgs.slice(-100));
    } catch (err) {
      console.error(err);
      callback([]);
    }
  });

  // WebRTC
  socket.on('call-user', ({ targetUserId, offer, callType }) => {
    io.to(`user:${targetUserId}`).emit('incoming-call', { from: userId, offer, callType });
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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SkyMessage running on http://localhost:${PORT}`));
