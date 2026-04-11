const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

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

// ==================== ХРАНИЛИЩЕ ДАННЫХ ====================
let users = new Map();       // userId -> объект
let sessions = new Map();    // token -> userId
let messages = new Map();    // convId -> массив сообщений
let groups = new Map();      // groupId -> объект
let channels = new Map();    // channelId -> объект
let bannedUsers = new Set();  // userId (только для суперадмина)

const DATA_FILE = './data.json';

function saveData() {
  const data = {
    users: Array.from(users.entries()),
    sessions: Array.from(sessions.entries()),
    messages: Array.from(messages.entries()),
    groups: Array.from(groups.entries()),
    channels: Array.from(channels.entries()),
    bannedUsers: Array.from(bannedUsers)
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  console.log('Data saved');
}

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE);
      const data = JSON.parse(raw);
      users = new Map(data.users);
      sessions = new Map(data.sessions);
      messages = new Map(data.messages);
      groups = new Map(data.groups);
      channels = new Map(data.channels);
      bannedUsers = new Set(data.bannedUsers || []);
      console.log('Data loaded from file');
    } catch(e) { console.error('Load error', e); }
  } else {
    initDemoData();
    saveData();
  }
}

function generateId() {
  return crypto.randomBytes(16).toString('hex');
}

function getPrivateConversationId(user1, user2) {
  return [user1, user2].sort().join('_');
}

function saveMessage(convId, message) {
  if (!messages.has(convId)) messages.set(convId, []);
  messages.get(convId).push(message);
  saveData();
}

function initDemoData() {
  // Создаём суперадмина DeBardARG
  const superAdminId = generateId();
  users.set(superAdminId, {
    id: superAdminId,
    login: 'DeBardARG',
    password: '01206090',
    displayName: 'SkyAdmin',
    avatar: '',
    status: 'online',
    createdAt: new Date().toISOString(),
    isSuperAdmin: true
  });
  // Демо-пользователи
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

// ==================== API ====================
app.post('/register', (req, res) => {
  const { login, password, displayName } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Login and password required' });
  if ([...users.values()].some(u => u.login === login)) return res.status(400).json({ error: 'User already exists' });
  const id = generateId();
  users.set(id, { id, login, password, displayName: displayName || login, avatar: '', status: 'online', createdAt: new Date().toISOString() });
  saveData();
  res.json({ success: true, userId: id });
});

app.post('/login', (req, res) => {
  const { login, password } = req.body;
  const user = [...users.values()].find(u => u.login === login && u.password === password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (bannedUsers.has(user.id)) return res.status(403).json({ error: 'Your account has been banned' });
  const token = generateId();
  sessions.set(token, user.id);
  saveData();
  res.json({ token, user: { id: user.id, login: user.login, displayName: user.displayName, avatar: user.avatar, status: user.status, isSuperAdmin: !!user.isSuperAdmin } });
});

app.get('/me', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Invalid token' });
  const user = users.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, login: user.login, displayName: user.displayName, avatar: user.avatar, status: user.status, isSuperAdmin: !!user.isSuperAdmin });
});

app.get('/search-users', (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const results = [...users.values()].filter(u => u.login.toLowerCase().includes(q.toLowerCase())).map(u => ({
    id: u.id, login: u.login, displayName: u.displayName, avatar: u.avatar, status: u.status
  }));
  res.json(results);
});

app.get('/search-groups', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { q } = req.query;
  if (!q) return res.json([]);
  const results = [...groups.values()].filter(g => g.name.toLowerCase().includes(q.toLowerCase()));
  const formatted = results.map(g => ({
    id: g.id,
    name: g.name,
    avatar: g.avatar,
    memberCount: g.members.size,
    joined: g.members.has(userId)
  }));
  res.json(formatted);
});

app.get('/search-channels', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const { q } = req.query;
  if (!q) return res.json([]);
  const results = [...channels.values()].filter(c => c.name.toLowerCase().includes(q.toLowerCase()));
  const formatted = results.map(c => ({
    id: c.id,
    name: c.name,
    description: c.description,
    avatar: c.avatar,
    subscriberCount: c.subscribers.size,
    subscribed: c.subscribers.has(userId)
  }));
  res.json(formatted);
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
  saveData();
  const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === userId);
  sockets.forEach(s => s.emit('profile-updated', { userId, displayName: user.displayName, avatar: user.avatar, status: user.status }));
  res.json({ success: true, user: { id: user.id, login: user.login, displayName: user.displayName, avatar: user.avatar, status: user.status } });
});

app.get('/user/:id', (req, res) => {
  const user = users.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ id: user.id, login: user.login, displayName: user.displayName, avatar: user.avatar, status: user.status, createdAt: user.createdAt, lastSeen: user.lastSeen });
});

// ==================== ГРУППЫ ====================
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
  saveData();
  group.members.forEach(mid => {
    const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === mid);
    sockets.forEach(s => s.emit('group-created', group));
  });
  res.json({ success: true, group: { ...group, members: Array.from(group.members), admins: Array.from(group.admins) } });
});

app.get('/group/:id', (req, res) => {
  const group = groups.get(req.params.id);
  if (!group) return res.status(404).json({ error: 'Not found' });
  const members = Array.from(group.members).map(id => users.get(id)).filter(u => u);
  const admins = Array.from(group.admins);
  res.json({ ...group, members, admins });
});

app.post('/group/update', (req, res) => {
  const { token, groupId, name, avatar } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const group = groups.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!group.admins.has(userId) && !users.get(userId).isSuperAdmin) return res.status(403).json({ error: 'Not admin' });
  if (name) group.name = name;
  if (avatar !== undefined) group.avatar = avatar;
  groups.set(groupId, group);
  saveData();
  group.members.forEach(mid => {
    const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === mid);
    sockets.forEach(s => s.emit('group-updated', group));
  });
  res.json({ success: true, group: { ...group, members: Array.from(group.members), admins: Array.from(group.admins) } });
});

app.post('/group/add-member', (req, res) => {
  const { token, groupId, userIdToAdd } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const group = groups.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!group.admins.has(userId) && !users.get(userId).isSuperAdmin) return res.status(403).json({ error: 'Not admin' });
  if (group.members.has(userIdToAdd)) return res.json({ success: true, message: 'Already member' });
  group.members.add(userIdToAdd);
  groups.set(groupId, group);
  saveData();
  group.members.forEach(mid => {
    const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === mid);
    sockets.forEach(s => s.emit('group-updated', group));
  });
  res.json({ success: true });
});

app.post('/group/remove-member', (req, res) => {
  const { token, groupId, userIdToRemove } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const group = groups.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!group.admins.has(userId) && !users.get(userId).isSuperAdmin && userId !== userIdToRemove) return res.status(403).json({ error: 'Not admin' });
  if (!group.members.has(userIdToRemove)) return res.json({ success: true, message: 'Not a member' });
  group.members.delete(userIdToRemove);
  group.admins.delete(userIdToRemove);
  if (group.ownerId === userIdToRemove) {
    const newOwner = group.admins.values().next().value || [...group.members][0];
    if (newOwner) group.ownerId = newOwner;
  }
  groups.set(groupId, group);
  saveData();
  group.members.forEach(mid => {
    const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === mid);
    sockets.forEach(s => s.emit('group-updated', group));
  });
  res.json({ success: true });
});

app.post('/group/leave', (req, res) => {
  const { token, groupId } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const group = groups.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!group.members.has(userId)) return res.json({ success: true, message: 'Already not a member' });
  group.members.delete(userId);
  group.admins.delete(userId);
  if (group.ownerId === userId) {
    const newOwner = group.admins.values().next().value || [...group.members][0];
    if (newOwner) group.ownerId = newOwner;
  }
  groups.set(groupId, group);
  saveData();
  group.members.forEach(mid => {
    const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === mid);
    sockets.forEach(s => s.emit('group-updated', group));
  });
  res.json({ success: true });
});

app.post('/group/delete', (req, res) => {
  const { token, groupId } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const group = groups.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const user = users.get(userId);
  if (!group.admins.has(userId) && !user.isSuperAdmin) return res.status(403).json({ error: 'Not admin' });
  groups.delete(groupId);
  saveData();
  // Уведомляем всех участников, что группа удалена
  group.members.forEach(mid => {
    const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === mid);
    sockets.forEach(s => s.emit('group-deleted', { groupId }));
  });
  res.json({ success: true });
});

app.post('/group/set-admin', (req, res) => {
  const { token, groupId, userIdToSet, isAdmin } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const group = groups.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!group.admins.has(userId) && !users.get(userId).isSuperAdmin) return res.status(403).json({ error: 'Not admin' });
  if (!group.members.has(userIdToSet)) return res.status(400).json({ error: 'Not a member' });
  if (isAdmin) group.admins.add(userIdToSet);
  else group.admins.delete(userIdToSet);
  groups.set(groupId, group);
  saveData();
  group.members.forEach(mid => {
    const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === mid);
    sockets.forEach(s => s.emit('group-updated', group));
  });
  res.json({ success: true });
});

app.post('/group/join', (req, res) => {
  const { token, groupId } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const group = groups.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.members.has(userId)) return res.json({ success: true, message: 'Already member' });
  group.members.add(userId);
  groups.set(groupId, group);
  saveData();
  group.members.forEach(mid => {
    const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === mid);
    sockets.forEach(s => s.emit('group-updated', group));
  });
  res.json({ success: true });
});

// ==================== КАНАЛЫ ====================
app.post('/create-channel', (req, res) => {
  const { token, name, description } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const channelId = generateId();
  const channel = {
    id: channelId, name: name || 'New Channel', description: description || '', avatar: '', ownerId: userId,
    subscribers: new Set([userId]), admins: new Set([userId]), createdAt: new Date().toISOString()
  };
  channels.set(channelId, channel);
  saveData();
  const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === userId);
  sockets.forEach(s => s.emit('channel-created', channel));
  res.json({ success: true, channel: { ...channel, subscribers: Array.from(channel.subscribers) } });
});

app.get('/channel/:id', (req, res) => {
  const channel = channels.get(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Not found' });
  const subscribers = Array.from(channel.subscribers).map(id => users.get(id)).filter(u => u);
  res.json({ ...channel, subscribers });
});

app.post('/channel/subscribe', (req, res) => {
  const { token, channelId } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const channel = channels.get(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  channel.subscribers.add(userId);
  channels.set(channelId, channel);
  saveData();
  channel.subscribers.forEach(sid => {
    const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === sid);
    sockets.forEach(s => s.emit('channel-updated', channel));
  });
  res.json({ success: true });
});

app.post('/channel/unsubscribe', (req, res) => {
  const { token, channelId } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const channel = channels.get(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  channel.subscribers.delete(userId);
  channels.set(channelId, channel);
  saveData();
  channel.subscribers.forEach(sid => {
    const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === sid);
    sockets.forEach(s => s.emit('channel-updated', channel));
  });
  res.json({ success: true });
});

app.post('/channel/update', (req, res) => {
  const { token, channelId, name, description, avatar } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const channel = channels.get(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (channel.ownerId !== userId && !users.get(userId).isSuperAdmin) return res.status(403).json({ error: 'Not owner' });
  if (name) channel.name = name;
  if (description !== undefined) channel.description = description;
  if (avatar !== undefined) channel.avatar = avatar;
  channels.set(channelId, channel);
  saveData();
  channel.subscribers.forEach(sid => {
    const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === sid);
    sockets.forEach(s => s.emit('channel-updated', channel));
  });
  res.json({ success: true });
});

app.get('/my-groups', (req, res) => {
  const { token } = req.query;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const userGroups = [...groups.values()].filter(g => g.members.has(userId));
  res.json(userGroups.map(g => ({ ...g, members: Array.from(g.members), admins: Array.from(g.admins) })));
});

app.get('/my-channels', (req, res) => {
  const { token } = req.query;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const userChannels = [...channels.values()].filter(c => c.subscribers.has(userId));
  res.json(userChannels.map(c => ({ ...c, subscribers: Array.from(c.subscribers) })));
});

// ==================== БАН (только для суперадмина) ====================
app.post('/ban-user', (req, res) => {
  const { token, userIdToBan } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const user = users.get(userId);
  if (!user.isSuperAdmin) return res.status(403).json({ error: 'Only super admin can ban users' });
  bannedUsers.add(userIdToBan);
  saveData();
  // Разорвать все сессии забаненного пользователя
  for (let [sessToken, sessUserId] of sessions.entries()) {
    if (sessUserId === userIdToBan) sessions.delete(sessToken);
  }
  // Уведомить пользователя через сокет, если он онлайн
  const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === userIdToBan);
  sockets.forEach(s => s.emit('banned'));
  res.json({ success: true });
});

app.post('/unban-user', (req, res) => {
  const { token, userIdToUnban } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const user = users.get(userId);
  if (!user.isSuperAdmin) return res.status(403).json({ error: 'Only super admin can unban users' });
  bannedUsers.delete(userIdToUnban);
  saveData();
  res.json({ success: true });
});

app.get('/banned-users', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const user = users.get(userId);
  if (!user.isSuperAdmin) return res.status(403).json({ error: 'Only super admin can view banned users' });
  const bannedList = Array.from(bannedUsers).map(id => users.get(id)).filter(u => u);
  res.json(bannedList);
});

// ==================== SOCKET.IO ====================
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

  // Отправка списка бесед
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
    const { convId, type, content } = data;
    if (!convId || !content) return;
    const message = {
      id: generateId(), senderId: userId, type: type || 'text', content, timestamp: Date.now()
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

  socket.on('disconnect', () => {
    console.log(`User ${userId} disconnected`);
    const user = users.get(userId);
    if (user) {
      user.lastSeen = Date.now();
      if (user.status !== 'offline') user.status = 'offline';
      users.set(userId, user);
      saveData();
    }
  });
});

const PORT = process.env.PORT || 3000;
loadData();
server.listen(PORT, () => console.log(`SkyMessage running on http://localhost:${PORT}`));
