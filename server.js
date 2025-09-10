// server.js - Сервер с Express API и WebSocket
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const UserDatabase = require('./database');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Инициализация базы данных
const db = new UserDatabase();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Логирование запросов
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Хранилище для WebSocket соединений
const rooms = new Map();
const connections = new Map();

// ===== API ЭНДПОИНТЫ =====

// Проверка здоровья сервера
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    connections: connections.size,
    rooms: rooms.size,
    database: 'connected'
  });
});

// Регистрация нового пользователя
app.post('/api/users/register', async (req, res) => {
  try {
    const { username, displayName } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    
    const user = await db.createUser(username, displayName);
    res.status(201).json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        status: user.status
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(400).json({
      error: error.message
    });
  }
});

// Авторизация пользователя
app.post('/api/users/login', async (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    
    const user = await db.getUserByUsername(username);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Обновляем статус на онлайн
    await db.updateUserStatus(user.id, 'online');
    
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        status: 'online'
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Поиск пользователей
app.get('/api/users/search', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;
    
    if (!q) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    
    const users = await db.searchUsers(q, parseInt(limit));
    res.json({
      success: true,
      users: users.map(user => ({
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        status: user.status
      }))
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Получение профиля пользователя
app.get('/api/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const userWithContacts = await db.getUserWithContacts(parseInt(userId));
    
    if (!userWithContacts) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({
      success: true,
      user: userWithContacts
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Добавление контакта
app.post('/api/users/:userId/contacts', async (req, res) => {
  try {
    const { userId } = req.params;
    const { contactUsername, nickname } = req.body;
    
    if (!contactUsername) {
      return res.status(400).json({ error: 'Contact username is required' });
    }
    
    const contact = await db.addContact(parseInt(userId), contactUsername, nickname);
    res.status(201).json({
      success: true,
      contact
    });
  } catch (error) {
    console.error('Add contact error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Получение контактов пользователя
app.get('/api/users/:userId/contacts', async (req, res) => {
  try {
    const { userId } = req.params;
    const contacts = await db.getContacts(parseInt(userId));
    
    res.json({
      success: true,
      contacts
    });
  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({ error: 'Failed to get contacts' });
  }
});

// Удаление контакта
app.delete('/api/users/:userId/contacts/:contactId', async (req, res) => {
  try {
    const { userId, contactId } = req.params;
    const deleted = await db.removeContact(parseInt(userId), parseInt(contactId));
    
    if (!deleted) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    
    res.json({
      success: true,
      message: 'Contact removed'
    });
  } catch (error) {
    console.error('Remove contact error:', error);
    res.status(500).json({ error: 'Failed to remove contact' });
  }
});

// Блокировка/разблокировка контакта
app.patch('/api/users/:userId/contacts/:contactId/block', async (req, res) => {
  try {
    const { userId, contactId } = req.params;
    const { blocked } = req.body;
    
    if (blocked) {
      await db.blockContact(parseInt(userId), parseInt(contactId));
    } else {
      await db.unblockContact(parseInt(userId), parseInt(contactId));
    }
    
    res.json({
      success: true,
      message: blocked ? 'Contact blocked' : 'Contact unblocked'
    });
  } catch (error) {
    console.error('Block contact error:', error);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// История звонков
app.get('/api/users/:userId/calls', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 50 } = req.query;
    
    const callHistory = await db.getCallHistory(parseInt(userId), parseInt(limit));
    
    res.json({
      success: true,
      calls: callHistory
    });
  } catch (error) {
    console.error('Get call history error:', error);
    res.status(500).json({ error: 'Failed to get call history' });
  }
});

// Статистика звонков
app.get('/api/users/:userId/calls/stats', async (req, res) => {
  try {
    const { userId } = req.params;
    const stats = await db.getCallStats(parseInt(userId));
    
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Get call stats error:', error);
    res.status(500).json({ error: 'Failed to get call stats' });
  }
});

// Получение активных пользователей
app.get('/api/users/active', async (req, res) => {
  try {
    const activeUsers = await db.getActiveUsers();
    res.json({
      success: true,
      users: activeUsers
    });
  } catch (error) {
    console.error('Get active users error:', error);
    res.status(500).json({ error: 'Failed to get active users' });
  }
});

// Обработка несуществующих маршрутов
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// Главная страница
app.get('/', (req, res) => {
  res.send(`
    <h1>WebRTC Signaling Server</h1>
    <p>Server is running</p>
    <h2>API Endpoints:</h2>
    <ul>
      <li>GET /health - Server health check</li>
      <li>POST /api/users/register - Register new user</li>
      <li>POST /api/users/login - User login</li>
      <li>GET /api/users/search?q=username - Search users</li>
      <li>GET /api/users/:userId - Get user profile</li>
      <li>POST /api/users/:userId/contacts - Add contact</li>
      <li>GET /api/users/:userId/contacts - Get contacts</li>
      <li>GET /api/users/:userId/calls - Get call history</li>
      <li>GET /api/users/active - Get active users</li>
    </ul>
  `);
});

// ===== WEBSOCKET ОБРАБОТЧИКИ =====

wss.on('connection', async (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  const clientId = generateId();
  
  console.log(`New WebSocket connection: ${clientId} from ${clientIP}`);
  
  connections.set(clientId, {
    ws: ws,
    roomId: null,
    userId: null,
    connectTime: Date.now(),
    ip: clientIP
  });
  
  ws.send(JSON.stringify({
    type: 'connection-established',
    clientId: clientId,
    timestamp: new Date().toISOString()
  }));
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log(`WebSocket message from ${clientId}:`, data.type);
      
      switch (data.type) {
        case 'peer-ready':
          handlePeerReady(clientId, data.roomId, ws);
          break;
        case 'auth':
          await handleAuth(clientId, data, ws);
          break;
        case 'join-room':
          await handleJoinRoom(clientId, data.roomId, ws);
          break;
        case 'offer':
          handleOffer(clientId, data.roomId, data.offer);
          break;
        case 'answer':
          handleAnswer(clientId, data.roomId, data.answer);
          break;
        case 'ice-candidate':
          handleIceCandidate(clientId, data.roomId, data.candidate);
          break;
        case 'leave-room':
          handleLeaveRoom(clientId, data.roomId);
          break;
        default:
          console.log(`Unknown message type: ${data.type}`);
      }
    } catch (error) {
      console.error(`Error processing WebSocket message from ${clientId}:`, error);
    }
  });
  
  ws.on('close', async () => {
    console.log(`WebSocket disconnected: ${clientId}`);
    await handleDisconnect(clientId);
  });
  
  ws.on('error', (error) => {
    console.error(`WebSocket error for ${clientId}:`, error);
  });
});

// ===== WEBSOCKET HANDLERS =====

async function handleAuth(clientId, data, ws) {
  try {
    const { userId } = data;
    if (!userId) {
      return sendMessage(ws, { type: 'error', message: 'User ID required' });
    }
    
    const user = await db.getUserById(userId);
    if (!user) {
      return sendMessage(ws, { type: 'error', message: 'User not found' });
    }
    
    // Связываем WebSocket с пользователем
    const clientInfo = connections.get(clientId);
    if (clientInfo) {
      clientInfo.userId = userId;
    }
    
    // Добавляем соединение в базу
    await db.addConnection(userId, clientId);
    await db.updateUserStatus(userId, 'online');
    
    sendMessage(ws, {
      type: 'auth-success',
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name
      }
    });
    
    console.log(`User authenticated: ${user.username} (${clientId})`);
  } catch (error) {
    console.error('Auth error:', error);
    sendMessage(ws, { type: 'error', message: 'Authentication failed' });
  }
}

// Остальные WebSocket handlers остаются такими же...
// (handleJoinRoom, handleOffer, handleAnswer, etc.)

async function handleDisconnect(clientId) {
  const clientInfo = connections.get(clientId);
  
  if (clientInfo) {
    if (clientInfo.roomId) {
      handleLeaveRoom(clientId, clientInfo.roomId);
    }
    
    if (clientInfo.userId) {
      await db.removeConnection(clientId);
      await db.updateUserStatus(clientInfo.userId, 'offline');
    }
  }
  
  connections.delete(clientId);
}

function sendMessage(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error('Error sending message:', error);
      return false;
    }
  }
  return false;
}

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

// ===== ЗАПУСК СЕРВЕРА =====

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

async function startServer() {
  try {
    // Инициализируем базу данных
    await db.initialize();
    
    // Запускаем сервер
    server.listen(PORT, HOST, () => {
      console.log(`Server running on http://${HOST}:${PORT}`);
      console.log(`WebSocket server ready`);
      console.log(`API documentation available at http://${HOST}:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully');
  await db.close();
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully');
  await db.close();
  server.close(() => {
    process.exit(0);
  });
});

startServer();
// // ИСПРАВЛЕННЫЙ signaling-server.js
// const WebSocket = require('ws');
// const http = require('http');
// const UserDatabase = require('./models/database');
//
// const db = new UserDatabase();
// await db.initialize();
//
// const server = http.createServer((req, res) => {
//   if (req.method === 'GET' && req.url === '/health') {
//     res.writeHead(200, { 'Content-Type': 'application/json' });
//     res.end(JSON.stringify({
//       status: 'OK',
//       timestamp: new Date().toISOString(),
//       connections: connections.size,
//       rooms: rooms.size
//     }));
//   } else {
//     res.writeHead(404);
//     res.end('WebSocket Signaling Server');
//   }
// });
//
// const wss = new WebSocket.Server({ server });
//
// // Хранилище комнат и подключений
// const rooms = new Map();
// const connections = new Map();

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}
//
// wss.on('connection', (ws, req) => {
//   const clientIP = req.socket.remoteAddress;
//   const clientId = generateId();
//
//   log(`New client connected: ${clientId} from ${clientIP}`);
//
//   // ИСПРАВЛЕНО: правильная структура хранения клиента
//   connections.set(clientId, {
//     ws: ws,
//     roomId: null,
//     connectTime: Date.now(),
//     ip: clientIP
//   });
//
//   // Отправляем приветственное сообщение
//   sendMessage(ws, {
//     type: 'connection-established',
//     clientId: clientId,
//     timestamp: new Date().toISOString()
//   });
//
//   ws.on('message', (message) => {
//     try {
//       const data = JSON.parse(message.toString());
//       log(`Received from ${clientId}: ${data.type}`);
//
//       switch (data.type) {
//         case 'peer-ready':
//           handlePeerReady(clientId, data.roomId, ws);
//           break;
//
//         case 'join-room':
//           handleJoinRoom(clientId, data.roomId, ws);
//           break;
//
//         case 'offer':
//           log(`Processing offer from ${clientId} to room ${data.roomId}`);
//           handleOffer(clientId, data.roomId, data.offer);
//           break;
//
//         case 'answer':
//           log(`Processing answer from ${clientId} to room ${data.roomId}`);
//           handleAnswer(clientId, data.roomId, data.answer);
//           break;
//
//         case 'ice-candidate':
//           handleIceCandidate(clientId, data.roomId, data.candidate);
//           break;
//
//         case 'leave-room':
//           handleLeaveRoom(clientId, data.roomId);
//           break;
//
//         case 'ping':
//           sendMessage(ws, { type: 'pong', timestamp: Date.now() });
//           break;
//
//         default:
//           log(`Unknown message type from ${clientId}: ${data.type}`, 'WARN');
//       }
//     } catch (error) {
//       log(`Error processing message from ${clientId}: ${error.message}`, 'ERROR');
//     }
//   });
//
//   ws.on('close', (code, reason) => {
//     log(`Client ${clientId} disconnected: code=${code}, reason=${reason}`);
//     handleDisconnect(clientId);
//   });
//
//   ws.on('error', (error) => {
//     log(`WebSocket error for ${clientId}: ${error.message}`, 'ERROR');
//   });
// });
//
function handlePeerReady(clientId, ws) {
  const clientInfo = connections.get(clientId);
  if (clientInfo && clientInfo.roomId) {
    const room = rooms.get(clientInfo.roomId);
    const otherClientId = Array.from(room).find(id => id !== clientId);
    const otherClientInfo = connections.get(otherClientId);

    if (!otherClientInfo || !otherClientInfo.ws) {
      return log(`Client ${otherClientId} is unknown in room ${clientInfo.roomId}.`, 'ERROR');
    }

    return sendMessage(otherClientInfo.ws, {
      type: 'user-peer-ready',
      roomId: clientInfo.roomId
    });
  }

  log(`Client ${clientId} called peer-ready without connecting.`, 'ERROR');
}
//
function handleJoinRoom(clientId, roomId, ws) {
  if (!roomId) {
    log(`Client ${clientId} tried to join without room ID`, 'WARN');
    sendMessage(ws, {
      type: 'error',
      message: 'Room ID is required'
    });
    return;
  }

  // Получаем или создаем комнату
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
    log(`Created new room: ${roomId}`);
  }

  const room = rooms.get(roomId);

  // Проверяем лимит участников
  if (room.size >= 2) {
    log(`Client ${clientId} tried to join full room ${roomId}`, 'WARN');
    sendMessage(ws, {
      type: 'error',
      message: 'Room is full (max 2 participants)'
    });
    return;
  }

  // Удаляем клиента из предыдущей комнаты если он был в другой
  const clientInfo = connections.get(clientId);
  if (clientInfo && clientInfo.roomId) {
    handleLeaveRoom(clientId, clientInfo.roomId);
  }

  // Добавляем клиента в комнату
  room.add(clientId);

  // ИСПРАВЛЕНО: обновляем информацию о клиенте
  if (clientInfo) {
    clientInfo.roomId = roomId;
  }

  log(`Client ${clientId} joined room ${roomId} (${room.size}/2 participants)`);

  // Отправляем подтверждение
  sendMessage(ws, {
    type: 'room-joined',
    roomId: roomId,
    participantCount: room.size
  });

  // Если в комнате уже есть другой участник, уведомляем ОБОИХ
  if (room.size === 2) {
    const otherClientId = Array.from(room).find(id => id !== clientId);
    const otherClient = connections.get(otherClientId);

    if (otherClient && otherClient.ws) {
      // Уведомляем первого клиента о втором
      sendMessage(otherClient.ws, {
        type: 'user-joined',
        userId: clientId,
        participantCount: room.size
      });

      log(`Notified ${otherClientId} about ${clientId} joining room ${roomId}`);
    }
  }
}
//
// // ИСПРАВЛЕННЫЙ handleOffer
function handleOffer(clientId, roomId, offer) {
  log(`Handling offer from ${clientId} in room ${roomId}`);

  const room = rooms.get(roomId);
  if (!room) {
    log(`Offer from ${clientId}: room ${roomId} not found`, 'WARN');
    return;
  }

  // Находим другого участника в комнате
  const otherClientId = Array.from(room).find(id => id !== clientId);
  if (!otherClientId) {
    log(`Offer from ${clientId}: no other participant in room ${roomId}`, 'WARN');
    return;
  }

  const otherClient = connections.get(otherClientId);
  if (otherClient && otherClient.ws && otherClient.ws.readyState === WebSocket.OPEN) {
    // ИСПРАВЛЕНО: отправляем offer без лишних полей
    sendMessage(otherClient.ws, {
      type: 'offer',
      offer: offer,
      roomId: roomId,
      fromUserId: clientId
    });
    log(`✅ Forwarded offer from ${clientId} to ${otherClientId}`);
  } else {
    log(`❌ Offer from ${clientId}: target client ${otherClientId} not available`, 'WARN');
  }
}

// ИСПРАВЛЕННЫЙ handleAnswer
function handleAnswer(clientId, roomId, answer) {
  log(`Handling answer from ${clientId} in room ${roomId}`);

  const room = rooms.get(roomId);
  if (!room) {
    log(`Answer from ${clientId}: room ${roomId} not found`, 'WARN');
    return;
  }

  const otherClientId = Array.from(room).find(id => id !== clientId);
  if (!otherClientId) {
    log(`Answer from ${clientId}: no other participant in room ${roomId}`, 'WARN');
    return;
  }

  const otherClient = connections.get(otherClientId);
  if (otherClient && otherClient.ws && otherClient.ws.readyState === WebSocket.OPEN) {
    // ИСПРАВЛЕНО: отправляем answer без лишних полей
    sendMessage(otherClient.ws, {
      type: 'answer',
      answer: answer,
      roomId: roomId,
      fromUserId: clientId
    });
    log(`✅ Forwarded answer from ${clientId} to ${otherClientId}`);
  } else {
    log(`❌ Answer from ${clientId}: target client ${otherClientId} not available`, 'WARN');
  }
}

function handleIceCandidate(clientId, roomId, candidate) {
  const room = rooms.get(roomId);
  if (!room) return;

  const otherClientId = Array.from(room).find(id => id !== clientId);
  if (!otherClientId) return;

  const otherClient = connections.get(otherClientId);
  if (otherClient && otherClient.ws && otherClient.ws.readyState === WebSocket.OPEN) {
    sendMessage(otherClient.ws, {
      type: 'ice-candidate',
      candidate: candidate,
      roomId: roomId,
      fromUserId: clientId
    });
  }
}

function handleLeaveRoom(clientId, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.delete(clientId);

  log(`Client ${clientId} left room ${roomId} (${room.size} participants remaining)`);

  if (room.size === 0) {
    rooms.delete(roomId);
    log(`Removed empty room ${roomId}`);
  } else {
    const otherClientId = Array.from(room)[0];
    const otherClient = connections.get(otherClientId);

    if (otherClient && otherClient.ws) {
      sendMessage(otherClient.ws, {
        type: 'user-left',
        userId: clientId,
        participantCount: room.size
      });
    }
  }

  // Обновляем информацию о клиенте
  const clientInfo = connections.get(clientId);
  if (clientInfo) {
    clientInfo.roomId = null;
  }
}

function handleDisconnect(clientId) {
  const clientInfo = connections.get(clientId);

  if (clientInfo && clientInfo.roomId) {
    handleLeaveRoom(clientId, clientInfo.roomId);
  }

  connections.delete(clientId);
  log(`Cleaned up connection for ${clientId}`);
}

function sendMessage(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      log(`Error sending message: ${error.message}`, 'ERROR');
      return false;
    }
  } else {
    log(`Cannot send message: WebSocket not open (state: ${ws.readyState})`, 'WARN');
    return false;
  }
}
//
function generateId() {
  return Math.random().toString(36).substr(2, 9);
}
//
// const PORT = process.env.PORT || 8080;
// const HOST = process.env.HOST || '0.0.0.0';
//
// server.listen(PORT, HOST, () => {
//   log(`Signaling server running on ${HOST}:${PORT}`);
//   log(`Health check available at http://${HOST}:${PORT}/health`);
// });
//
// server.on('error', (error) => {
//   log(`Server error: ${error.message}`, 'ERROR');
// });
