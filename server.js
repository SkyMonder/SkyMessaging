const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// In-memory storage
const users = new Map();       // userId -> { id, login, password, displayName, avatar, status, createdAt }
const sessions = new Map();    // token -> userId
const messages = new Map();    // convId -> array of messages
const groups = new Map();      // groupId -> { id, name, avatar, ownerId, members: Set, admins: Set, createdAt }
const channels = new Map();    // channelId -> { id, name, description, avatar, ownerId, subscribers: Set, createdAt }
const userConversations = new Map(); // userId -> Set of convIds (for quick sync)

// Helper: generate unique ID
function generateId() {
  return crypto.randomBytes(16).toString('hex');
}

// Helper: create conversation ID for 1:1 chat (sorted)
function getPrivateConversationId(user1, user2) {
  return [user1, user2].sort().join('_');
}

// Helper: save message
function saveMessage(convId, message) {
  if (!messages.has(convId)) messages.set(convId, []);
  messages.get(convId).push(message);
}

// Initialize some demo data
function initDemoData() {
  // Demo users
  const demoUsers = [
    { login: 'alice', password: '123', displayName: 'Alice', avatar: '', status: 'online' },
    { login: 'bob', password: '123', displayName: 'Bob', avatar: '', status: 'online' },
    { login: 'charlie', password: '123', displayName: 'Charlie', avatar: '', status: 'away' }
  ];
  demoUsers.forEach(user => {
    const id = generateId();
    users.set(id, {
      id,
      login: user.login,
      password: user.password,
      displayName: user.displayName,
      avatar: user.avatar,
      status: user.status,
      createdAt: new Date().toISOString()
    });
  });

  // Demo group
  const groupId = generateId();
  const aliceId = [...users.values()].find(u => u.login === 'alice').id;
  const bobId = [...users.values()].find(u => u.login === 'bob').id;
  const charlieId = [...users.values()].find(u => u.login === 'charlie').id;
  groups.set(groupId, {
    id: groupId,
    name: 'Tech Talk',
    avatar: '',
    ownerId: aliceId,
    members: new Set([aliceId, bobId, charlieId]),
    admins: new Set([aliceId]),
    createdAt: new Date().toISOString()
  });
  // Demo channel
  const channelId = generateId();
  channels.set(channelId, {
    id: channelId,
    name: 'Announcements',
    description: 'Official news',
    avatar: '',
    ownerId: aliceId,
    subscribers: new Set([aliceId, bobId, charlieId]),
    createdAt: new Date().toISOString()
  });
  // Demo messages for private conv
  const convId = getPrivateConversationId(aliceId, bobId);
  saveMessage(convId, { id: generateId(), senderId: aliceId, type: 'text', content: 'Hi Bob!', timestamp: Date.now() });
  saveMessage(convId, { id: generateId(), senderId: bobId, type: 'text', content: 'Hello Alice!', timestamp: Date.now() });
}
initDemoData();

// ------------------- REST API -------------------
// Register
app.post('/register', (req, res) => {
  const { login, password, displayName } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Login and password required' });
  const existing = [...users.values()].find(u => u.login === login);
  if (existing) return res.status(400).json({ error: 'User already exists' });
  const id = generateId();
  const newUser = {
    id,
    login,
    password, // plain for demo
    displayName: displayName || login,
    avatar: '',
    status: 'online',
    createdAt: new Date().toISOString()
  };
  users.set(id, newUser);
  res.json({ success: true, userId: id });
});

// Login
app.post('/login', (req, res) => {
  const { login, password } = req.body;
  const user = [...users.values()].find(u => u.login === login && u.password === password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const token = generateId();
  sessions.set(token, user.id);
  res.json({ token, user: { id: user.id, login: user.login, displayName: user.displayName, avatar: user.avatar, status: user.status } });
});

// Search users by login
app.get('/search-users', (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const results = [...users.values()].filter(u => u.login.toLowerCase().includes(q.toLowerCase())).map(u => ({
    id: u.id,
    login: u.login,
    displayName: u.displayName,
    avatar: u.avatar,
    status: u.status
  }));
  res.json(results);
});

// Update profile (displayName, avatar base64, status)
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
  // Notify all connected sockets about profile update
  const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === userId);
  sockets.forEach(s => s.emit('profile-updated', { userId, displayName: user.displayName, avatar: user.avatar, status: user.status }));
  res.json({ success: true, user: { id: user.id, login: user.login, displayName: user.displayName, avatar: user.avatar, status: user.status } });
});

// Get user profile by id
app.get('/user/:id', (req, res) => {
  const user = users.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ id: user.id, login: user.login, displayName: user.displayName, avatar: user.avatar, status: user.status, createdAt: user.createdAt });
});

// Create group
app.post('/create-group', (req, res) => {
  const { token, name, memberIds } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const groupId = generateId();
  const members = new Set([userId, ...(memberIds || [])]);
  const group = {
    id: groupId,
    name: name || 'New Group',
    avatar: '',
    ownerId: userId,
    members,
    admins: new Set([userId]),
    createdAt: new Date().toISOString()
  };
  groups.set(groupId, group);
  // Notify members
  members.forEach(mid => {
    const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === mid);
    sockets.forEach(s => s.emit('group-created', group));
  });
  res.json({ success: true, group });
});

// Create channel
app.post('/create-channel', (req, res) => {
  const { token, name, description } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const channelId = generateId();
  const channel = {
    id: channelId,
    name: name || 'New Channel',
    description: description || '',
    avatar: '',
    ownerId: userId,
    subscribers: new Set([userId]),
    createdAt: new Date().toISOString()
  };
  channels.set(channelId, channel);
  const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === userId);
  sockets.forEach(s => s.emit('channel-created', channel));
  res.json({ success: true, channel });
});

// Add user to group (admin only)
app.post('/group/add-member', (req, res) => {
  const { token, groupId, userIdToAdd } = req.body;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const group = groups.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!group.admins.has(userId)) return res.status(403).json({ error: 'Not admin' });
  group.members.add(userIdToAdd);
  groups.set(groupId, group);
  // Notify all members
  group.members.forEach(mid => {
    const sockets = [...io.sockets.sockets.values()].filter(s => s.userId === mid);
    sockets.forEach(s => s.emit('group-updated', group));
  });
  res.json({ success: true });
});

// Get groups for user
app.get('/my-groups', (req, res) => {
  const { token } = req.query;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const userGroups = [...groups.values()].filter(g => g.members.has(userId));
  res.json(userGroups);
});

// Get channels for user
app.get('/my-channels', (req, res) => {
  const { token } = req.query;
  const userId = sessions.get(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const userChannels = [...channels.values()].filter(c => c.subscribers.has(userId));
  res.json(userChannels);
});

// Subscribe to channel
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

// ------------------- Socket.IO -------------------
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

  // Join user's personal room
  socket.join(`user:${userId}`);

  // Send initial conversations list
  const userGroups = [...groups.values()].filter(g => g.members.has(userId));
  const userChannels = [...channels.values()].filter(c => c.subscribers.has(userId));
  const privateChats = new Set();
  // find all private conversations this user has messages in
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
        type: 'private',
        id: convId,
        name: otherUser?.displayName || otherId,
        avatar: otherUser?.avatar || '',
        lastMessage: messages.get(convId)?.[messages.get(convId).length-1] || null
      };
    }),
    groups: userGroups.map(g => ({ type: 'group', id: g.id, name: g.name, avatar: g.avatar })),
    channels: userChannels.map(c => ({ type: 'channel', id: c.id, name: c.name, avatar: c.avatar }))
  };
  socket.emit('conversations', convsList);

  // Handle send message
  socket.on('send-message', (data) => {
    const { convId, type, content, replyTo } = data;
    if (!convId || !content) return;
    const message = {
      id: generateId(),
      senderId: userId,
      type: type || 'text',
      content,
      timestamp: Date.now(),
      replyTo
    };
    saveMessage(convId, message);
    // Determine recipients
    let recipients = new Set();
    if (convId.includes('_')) {
      // private
      const [id1, id2] = convId.split('_');
      recipients.add(id1);
      recipients.add(id2);
    } else if (groups.has(convId)) {
      const group = groups.get(convId);
      group.members.forEach(m => recipients.add(m));
    } else if (channels.has(convId)) {
      const channel = channels.get(convId);
      channel.subscribers.forEach(s => recipients.add(s));
    } else return;
    // Emit to recipients
    recipients.forEach(uid => {
      io.to(`user:${uid}`).emit('new-message', { convId, message });
    });
  });

  // Load messages for a conversation
  socket.on('load-messages', (convId, callback) => {
    const msgs = messages.get(convId) || [];
    callback(msgs.slice(-100)); // last 100
  });

  // ------------------- WebRTC Signaling -------------------
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

// Serve frontend
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>SkyMessage</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #1e1e2f; color: #fff; height: 100vh; overflow: hidden; }
    #app { display: flex; height: 100vh; }
    /* Sidebar */
    .sidebar { width: 280px; background: #2c2c3a; border-right: 1px solid #3e3e4e; display: flex; flex-direction: column; }
    .sidebar-header { padding: 16px; border-bottom: 1px solid #3e3e4e; display: flex; justify-content: space-between; align-items: center; }
    .user-info { display: flex; align-items: center; gap: 12px; cursor: pointer; }
    .avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: #555; }
    .sidebar-search { padding: 12px; border-bottom: 1px solid #3e3e4e; }
    .sidebar-search input { width: 100%; padding: 8px; border-radius: 20px; border: none; background: #3e3e4e; color: white; outline: none; }
    .conversations-list { flex: 1; overflow-y: auto; }
    .conv-item { padding: 12px 16px; display: flex; align-items: center; gap: 12px; cursor: pointer; transition: background 0.2s; border-bottom: 1px solid #3e3e4e; }
    .conv-item:hover { background: #3e3e4e; }
    .conv-item.active { background: #4a4a5a; }
    .conv-avatar { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; background: #555; }
    .conv-details { flex: 1; }
    .conv-name { font-weight: bold; }
    .conv-last-msg { font-size: 12px; color: #aaa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* Main chat area */
    .chat-area { flex: 1; display: flex; flex-direction: column; background: #1e1e2f; }
    .chat-header { padding: 16px; background: #2c2c3a; border-bottom: 1px solid #3e3e4e; display: flex; justify-content: space-between; align-items: center; }
    .chat-header-left { display: flex; align-items: center; gap: 12px; }
    .chat-actions button { background: none; border: none; color: white; font-size: 20px; cursor: pointer; margin-left: 12px; }
    .messages-container { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
    .message { max-width: 70%; padding: 8px 12px; border-radius: 18px; background: #2c2c3a; align-self: flex-start; }
    .message.own { align-self: flex-end; background: #4a76a8; }
    .message-sender { font-size: 12px; font-weight: bold; margin-bottom: 4px; }
    .message-text { word-wrap: break-word; }
    .message-time { font-size: 10px; color: #aaa; margin-top: 4px; text-align: right; }
    .input-area { padding: 16px; background: #2c2c3a; display: flex; gap: 8px; align-items: center; }
    .input-area input { flex: 1; padding: 10px; border-radius: 24px; border: none; background: #3e3e4e; color: white; outline: none; }
    .input-area button { background: #4a76a8; border: none; color: white; width: 36px; height: 36px; border-radius: 50%; cursor: pointer; font-size: 18px; }
    .emoji-picker { position: absolute; bottom: 70px; background: #2c2c3a; border-radius: 12px; padding: 8px; display: none; grid-template-columns: repeat(6, 1fr); gap: 8px; max-width: 300px; }
    /* Call modal */
    .call-modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: none; justify-content: center; align-items: center; z-index: 1000; }
    .call-container { background: #2c2c3a; border-radius: 24px; padding: 20px; width: 80%; max-width: 800px; text-align: center; }
    .video-container { display: flex; gap: 16px; justify-content: center; margin: 16px 0; }
    video { width: 45%; background: black; border-radius: 12px; }
    .call-controls { display: flex; justify-content: center; gap: 16px; margin-top: 16px; }
    .call-controls button { padding: 10px 20px; border: none; border-radius: 40px; cursor: pointer; font-size: 16px; }
    .modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); display: none; justify-content: center; align-items: center; z-index: 900; }
    .modal-content { background: #2c2c3a; border-radius: 24px; padding: 24px; width: 90%; max-width: 400px; }
    .modal-content input, .modal-content textarea { width: 100%; padding: 8px; margin: 8px 0; border-radius: 8px; border: none; background: #3e3e4e; color: white; }
    .modal-content button { margin-top: 12px; padding: 8px 16px; background: #4a76a8; border: none; border-radius: 20px; color: white; cursor: pointer; }
    .search-results { margin-top: 12px; max-height: 200px; overflow-y: auto; }
    .search-user-item { padding: 8px; background: #3e3e4e; margin-bottom: 4px; border-radius: 8px; cursor: pointer; }
  </style>
</head>
<body>
<div id="app">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <div class="user-info" id="profileBtn">
        <img class="avatar" id="currentAvatar" src="" alt="avatar">
        <span id="currentDisplayName"></span>
      </div>
      <div>
        <button id="newChatBtn" style="background:none; border:none; color:white; font-size:20px;">➕</button>
        <button id="newGroupBtn" style="background:none; border:none; color:white; font-size:20px;">👥</button>
        <button id="newChannelBtn" style="background:none; border:none; color:white; font-size:20px;">📢</button>
      </div>
    </div>
    <div class="sidebar-search">
      <input type="text" id="searchUsersInput" placeholder="Поиск пользователей...">
      <div id="searchResults" class="search-results" style="display:none;"></div>
    </div>
    <div class="conversations-list" id="conversationsList"></div>
  </div>
  <div class="chat-area" id="chatArea">
    <div class="chat-header" id="chatHeader">
      <div class="chat-header-left">
        <img class="avatar" id="chatAvatar" src="" alt="">
        <span id="chatName"></span>
      </div>
      <div class="chat-actions">
        <button id="callBtn">📞</button>
      </div>
    </div>
    <div class="messages-container" id="messagesContainer"></div>
    <div class="input-area">
      <button id="emojiBtn">😀</button>
      <input type="text" id="messageInput" placeholder="Введите сообщение...">
      <button id="sendBtn">➤</button>
    </div>
    <div id="emojiPicker" class="emoji-picker"></div>
  </div>
</div>

<!-- Modals -->
<div id="profileModal" class="modal">
  <div class="modal-content">
    <h3>Профиль</h3>
    <img id="modalAvatar" width="80" style="border-radius:50%;"><br>
    <input type="text" id="editDisplayName" placeholder="Имя"><br>
    <input type="text" id="editStatus" placeholder="Статус"><br>
    <input type="file" id="avatarUpload" accept="image/*"><br>
    <button id="saveProfileBtn">Сохранить</button>
    <button id="closeProfileBtn">Закрыть</button>
  </div>
</div>

<div id="callModal" class="call-modal">
  <div class="call-container">
    <h3>Видеозвонок</h3>
    <div class="video-container">
      <video id="localVideo" autoplay muted playsinline></video>
      <video id="remoteVideo" autoplay playsinline></video>
    </div>
    <div class="call-controls">
      <button id="toggleMicBtn">🎤 Выкл</button>
      <button id="toggleCamBtn">📷 Выкл</button>
      <button id="hangupBtn">📞 Завершить</button>
    </div>
  </div>
</div>

<div id="newChatModal" class="modal">
  <div class="modal-content">
    <h3>Новый чат</h3>
    <input type="text" id="newChatUser" placeholder="Логин пользователя">
    <button id="startChatBtn">Начать чат</button>
    <button id="closeChatModal">Отмена</button>
  </div>
</div>

<div id="groupModal" class="modal">
  <div class="modal-content">
    <h3>Создать группу</h3>
    <input type="text" id="groupName" placeholder="Название группы">
    <input type="text" id="groupMembers" placeholder="Логины участников (через запятую)">
    <button id="createGroupBtn">Создать</button>
    <button id="closeGroupModal">Отмена</button>
  </div>
</div>

<div id="channelModal" class="modal">
  <div class="modal-content">
    <h3>Создать канал</h3>
    <input type="text" id="channelName" placeholder="Название канала">
    <textarea id="channelDesc" placeholder="Описание"></textarea>
    <button id="createChannelBtn">Создать</button>
    <button id="closeChannelModal">Отмена</button>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
  // Global state
  let currentUser = null;
  let token = localStorage.getItem('token');
  let socket = null;
  let currentConvId = null;
  let currentConvType = null;
  let currentCall = { active: false, peerConnection: null, targetUserId: null, localStream: null };
  const emojis = ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','😍','🥰','😘','😗','😙','😚','🙂','🤗','🤩','🤔','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','👻','💩','🤡','👹','👺','🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾'];

  // Helper functions
  function showModal(modalId) { document.getElementById(modalId).style.display = 'flex'; }
  function hideModal(modalId) { document.getElementById(modalId).style.display = 'none'; }

  function updateProfileUI() {
    if (!currentUser) return;
    document.getElementById('currentDisplayName').innerText = currentUser.displayName;
    document.getElementById('currentAvatar').src = currentUser.avatar || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="gray"%3E%3Cpath d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/%3E%3C/svg%3E';
    document.getElementById('modalAvatar').src = currentUser.avatar || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="gray"%3E%3Cpath d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/%3E%3C/svg%3E';
    document.getElementById('editDisplayName').value = currentUser.displayName;
    document.getElementById('editStatus').value = currentUser.status || '';
  }

  async function loginOrRegister(login, password, isLogin) {
    const url = isLogin ? '/login' : '/register';
    const body = { login, password };
    if (!isLogin) body.displayName = login;
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { alert('Ошибка'); return false; }
    const data = await res.json();
    if (isLogin) {
      token = data.token;
      currentUser = data.user;
      localStorage.setItem('token', token);
      connectSocket();
      updateProfileUI();
      loadConversations();
      return true;
    } else {
      alert('Регистрация успешна, теперь войдите');
      return false;
    }
  }

  function connectSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token } });
    socket.on('connect', () => console.log('Socket connected'));
    socket.on('conversations', (convs) => renderConversations(convs));
    socket.on('new-message', ({ convId, message }) => {
      if (currentConvId === convId) appendMessage(message, message.senderId === currentUser.id);
      // update conversation list later - simplified, just reload
      loadConversations();
    });
    socket.on('profile-updated', (data) => {
      if (data.userId === currentUser.id) { currentUser.displayName = data.displayName; currentUser.avatar = data.avatar; currentUser.status = data.status; updateProfileUI(); }
    });
    socket.on('group-created', (group) => loadConversations());
    socket.on('channel-created', (channel) => loadConversations());
    // WebRTC handlers
    socket.on('incoming-call', async ({ from, offer }) => {
      if (currentCall.active) { socket.emit('call-end', { targetUserId: from }); return; }
      if (confirm('Входящий звонок. Принять?')) {
        startCall(from, true, offer);
      } else {
        socket.emit('call-end', { targetUserId: from });
      }
    });
    socket.on('call-answered', ({ from, answer }) => handleRemoteAnswer(answer));
    socket.on('ice-candidate', ({ from, candidate }) => { if (currentCall.peerConnection) currentCall.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); });
    socket.on('call-ended', () => endCall());
    socket.on('media-toggled', ({ type, enabled }) => { /* handle remote media toggling - optional */ });
  }

  function renderConversations(convs) {
    const container = document.getElementById('conversationsList');
    container.innerHTML = '';
    const all = [...convs.private, ...convs.groups, ...convs.channels];
    all.forEach(conv => {
      const div = document.createElement('div');
      div.className = 'conv-item';
      if (currentConvId === conv.id) div.classList.add('active');
      div.innerHTML = \`
        <img class="conv-avatar" src="\${conv.avatar || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="gray"%3E%3Cpath d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/%3E%3C/svg%3E'}">
        <div class="conv-details">
          <div class="conv-name">\${conv.name}</div>
          <div class="conv-last-msg">\${conv.lastMessage ? conv.lastMessage.content : ''}</div>
        </div>
      \`;
      div.onclick = () => openConversation(conv);
      container.appendChild(div);
    });
  }

  async function openConversation(conv) {
    currentConvId = conv.id;
    currentConvType = conv.type;
    document.getElementById('chatName').innerText = conv.name;
    document.getElementById('chatAvatar').src = conv.avatar || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="gray"%3E%3Cpath d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/%3E%3C/svg%3E';
    const messagesContainer = document.getElementById('messagesContainer');
    messagesContainer.innerHTML = '<div>Загрузка...</div>';
    socket.emit('load-messages', conv.id, (msgs) => {
      messagesContainer.innerHTML = '';
      msgs.forEach(msg => appendMessage(msg, msg.senderId === currentUser.id));
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });
  }

  function appendMessage(msg, isOwn) {
    const div = document.createElement('div');
    div.className = 'message' + (isOwn ? ' own' : '');
    const sender = usersCache[msg.senderId] || { displayName: 'Unknown' };
    div.innerHTML = \`
      <div class="message-sender">\${isOwn ? 'Вы' : sender.displayName}</div>
      <div class="message-text">\${msg.content}</div>
      <div class="message-time">\${new Date(msg.timestamp).toLocaleTimeString()}</div>
    \`;
    document.getElementById('messagesContainer').appendChild(div);
  }

  async function loadConversations() {
    if (!socket) return;
    socket.emit('get-conversations'); // handled on connect, but we need re-fetch? Actually we'll just rely on socket events or manual reload
    // but socket already sends on connect. For new group we emit but we can also request via http
    const groupsRes = await fetch(\`/my-groups?token=\${token}\`);
    const groups = await groupsRes.json();
    const channelsRes = await fetch(\`/my-channels?token=\${token}\`);
    const channels = await channelsRes.json();
    // combine with private? we need full; we'll just call load again but we keep convs list from socket. We'll request manual reload
    socket.emit('get-conversations');
  }

  async function sendMessage() {
    const input = document.getElementById('messageInput');
    const text = input.value.trim();
    if (!text || !currentConvId) return;
    socket.emit('send-message', { convId: currentConvId, type: 'text', content: text });
    input.value = '';
  }

  // WebRTC
  async function startCall(targetUserId, isAnswer = false, offer = null) {
    currentCall.active = true;
    currentCall.targetUserId = targetUserId;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    currentCall.peerConnection = pc;
    pc.onicecandidate = (event) => {
      if (event.candidate) socket.emit('ice-candidate', { targetUserId, candidate: event.candidate });
    };
    pc.ontrack = (event) => {
      document.getElementById('remoteVideo').srcObject = event.streams[0];
    };
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    currentCall.localStream = stream;
    document.getElementById('localVideo').srcObject = stream;
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
    if (!isAnswer) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('call-user', { targetUserId, offer: pc.localDescription });
    } else {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('call-answer', { targetUserId, answer: pc.localDescription });
    }
    showModal('callModal');
  }
  function handleRemoteAnswer(answer) {
    if (currentCall.peerConnection) currentCall.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  }
  function endCall() {
    if (currentCall.peerConnection) currentCall.peerConnection.close();
    if (currentCall.localStream) currentCall.localStream.getTracks().forEach(t => t.stop());
    currentCall.active = false;
    hideModal('callModal');
    if (currentCall.targetUserId) socket.emit('call-end', { targetUserId: currentCall.targetUserId });
    currentCall.targetUserId = null;
  }
  function toggleMedia(type) {
    const stream = currentCall.localStream;
    if (!stream) return;
    const enabled = !stream.getTracks().find(t => t.kind === type).enabled;
    stream.getTracks().forEach(t => { if (t.kind === type) t.enabled = enabled; });
    socket.emit('toggle-media', { targetUserId: currentCall.targetUserId, type, enabled });
    document.getElementById(type === 'audio' ? 'toggleMicBtn' : 'toggleCamBtn').innerText = type === 'audio' ? (enabled ? '🎤 Выкл' : '🎤 Вкл') : (enabled ? '📷 Выкл' : '📷 Вкл');
  }

  // UI Event listeners
  document.getElementById('sendBtn').onclick = sendMessage;
  document.getElementById('messageInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
  document.getElementById('emojiBtn').onclick = () => { const picker = document.getElementById('emojiPicker'); picker.style.display = picker.style.display === 'grid' ? 'none' : 'grid'; };
  emojis.forEach(emoji => { const btn = document.createElement('button'); btn.innerText = emoji; btn.style.fontSize = '24px'; btn.onclick = () => { document.getElementById('messageInput').value += emoji; document.getElementById('emojiPicker').style.display = 'none'; }; document.getElementById('emojiPicker').appendChild(btn); });
  document.getElementById('callBtn').onclick = () => { if (currentConvType === 'private') startCall(currentConvId.split('_').find(id => id !== currentUser.id)); else alert('Звонки только в личных чатах'); };
  document.getElementById('hangupBtn').onclick = endCall;
  document.getElementById('toggleMicBtn').onclick = () => toggleMedia('audio');
  document.getElementById('toggleCamBtn').onclick = () => toggleMedia('video');
  document.getElementById('profileBtn').onclick = () => showModal('profileModal');
  document.getElementById('saveProfileBtn').onclick = async () => {
    const displayName = document.getElementById('editDisplayName').value;
    const status = document.getElementById('editStatus').value;
    let avatar = currentUser.avatar;
    const fileInput = document.getElementById('avatarUpload');
    if (fileInput.files[0]) {
      const reader = new FileReader();
      reader.onload = async (e) => { avatar = e.target.result; await updateProfile(displayName, avatar, status); };
      reader.readAsDataURL(fileInput.files[0]);
    } else await updateProfile(displayName, avatar, status);
  };
  async function updateProfile(displayName, avatar, status) {
    const res = await fetch('/update-profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, displayName, avatar, status }) });
    if (res.ok) { const data = await res.json(); currentUser = data.user; updateProfileUI(); hideModal('profileModal'); }
  }
  document.getElementById('closeProfileBtn').onclick = () => hideModal('profileModal');
  document.getElementById('newChatBtn').onclick = () => showModal('newChatModal');
  document.getElementById('startChatBtn').onclick = async () => {
    const login = document.getElementById('newChatUser').value;
    const searchRes = await fetch(\`/search-users?q=\${login}\`);
    const usersList = await searchRes.json();
    const target = usersList.find(u => u.login === login);
    if (!target) { alert('Пользователь не найден'); return; }
    const convId = [currentUser.id, target.id].sort().join('_');
    openConversation({ id: convId, type: 'private', name: target.displayName, avatar: target.avatar });
    hideModal('newChatModal');
  };
  document.getElementById('closeChatModal').onclick = () => hideModal('newChatModal');
  document.getElementById('newGroupBtn').onclick = () => showModal('groupModal');
  document.getElementById('createGroupBtn').onclick = async () => {
    const name = document.getElementById('groupName').value;
    const membersStr = document.getElementById('groupMembers').value;
    const memberLogins = membersStr.split(',').map(s => s.trim()).filter(l => l);
    const memberIds = [];
    for (let login of memberLogins) {
      const res = await fetch(\`/search-users?q=\${login}`);
      const list = await res.json();
      const u = list.find(u => u.login === login);
      if (u) memberIds.push(u.id);
    }
    await fetch('/create-group', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, name, memberIds }) });
    hideModal('groupModal');
    loadConversations();
  };
  document.getElementById('closeGroupModal').onclick = () => hideModal('groupModal');
  document.getElementById('newChannelBtn').onclick = () => showModal('channelModal');
  document.getElementById('createChannelBtn').onclick = async () => {
    const name = document.getElementById('channelName').value;
    const description = document.getElementById('channelDesc').value;
    await fetch('/create-channel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, name, description }) });
    hideModal('channelModal');
    loadConversations();
  };
  document.getElementById('closeChannelModal').onclick = () => hideModal('channelModal');

  // Search users
  let searchTimeout;
  document.getElementById('searchUsersInput').addEventListener('input', async (e) => {
    clearTimeout(searchTimeout);
    const q = e.target.value;
    if (!q) { document.getElementById('searchResults').style.display = 'none'; return; }
    searchTimeout = setTimeout(async () => {
      const res = await fetch(\`/search-users?q=\${q}\`);
      const usersList = await res.json();
      const container = document.getElementById('searchResults');
      container.innerHTML = '';
      usersList.forEach(u => {
        const div = document.createElement('div');
        div.className = 'search-user-item';
        div.innerText = \`\${u.displayName} (@\${u.login})\`;
        div.onclick = () => {
          const convId = [currentUser.id, u.id].sort().join('_');
          openConversation({ id: convId, type: 'private', name: u.displayName, avatar: u.avatar });
          document.getElementById('searchUsersInput').value = '';
          container.style.display = 'none';
        };
        container.appendChild(div);
      });
      container.style.display = usersList.length ? 'block' : 'none';
    }, 300);
  });

  // Auto-login if token exists
  (async () => {
    if (token) {
      // Validate token by fetching profile? We'll just try to connect socket
      // but need current user data. We'll fetch dummy: we don't have user info stored, we can ask server
      // for simplicity, prompt login if not valid.
      const res = await fetch('/my-groups?token=' + token);
      if (res.status === 401) { localStorage.removeItem('token'); token = null; location.reload(); return; }
      // We need currentUser, we'll fetch from somewhere, maybe we have stored after login? Let's redirect to login prompt
      const login = prompt('Введите логин для восстановления сессии:');
      const pass = prompt('Пароль:');
      if (login && pass) await loginOrRegister(login, pass, true);
    } else {
      const action = confirm('Нет сессии. Нажмите OK для входа, Cancel для регистрации');
      if (action) {
        const login = prompt('Логин:');
        const pass = prompt('Пароль:');
        if (login && pass) await loginOrRegister(login, pass, true);
      } else {
        const login = prompt('Придумайте логин:');
        const pass = prompt('Пароль:');
        if (login && pass) await loginOrRegister(login, pass, false);
      }
    }
  })();

  let usersCache = {};
  function updateUserCache() { /* just simple */ }
</script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SkyMessage running on http://localhost:${PORT}`));
