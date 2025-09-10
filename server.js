// signaling-server.js с расширенной отладкой
const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  // Добавляем простой HTTP endpoint для тестирования доступности
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'OK',
      timestamp: new Date().toISOString(),
      connections: connections.size,
      rooms: rooms.size
    }));
  } else {
    res.writeHead(404);
    res.end('WebSocket Signaling Server');
  }
});

const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false // Отключаем компрессию для отладки
});

// Хранилище комнат и подключений
const rooms = new Map();
const connections = new Map();

// Функция логирования с временными метками
function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}

// Статистика сервера
function logStats() {
  log(`Server stats - Connections: ${connections.size}, Rooms: ${rooms.size}, Active rooms: ${Array.from(rooms.values()).filter(room => room.size > 0).length}`);
}

wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  const clientId = generateId();
  
  log(`New client connected: ${clientId} from ${clientIP}`);
  
  connections.set(clientId, {
    ws: ws,
    roomId: null,
    connectTime: Date.now(),
    ip: clientIP
  });
  
  // Отправляем приветственное сообщение
  sendMessage(ws, {
    type: 'connection-established',
    clientId: clientId,
    timestamp: new Date().toISOString()
  });
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      log(`Received from ${clientId}: ${data.type}`, 'DEBUG');
      
      switch (data.type) {
        case 'join-room':
          handleJoinRoom(clientId, data.roomId, ws);
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
        
        case 'ping':
          // Ответ на ping для проверки соединения
          sendMessage(ws, { type: 'pong', timestamp: Date.now() });
          break;
        
        default:
          log(`Unknown message type from ${clientId}: ${data.type}`, 'WARN');
          sendMessage(ws, {
            type: 'error',
            message: `Unknown message type: ${data.type}`
          });
      }
    } catch (error) {
      log(`Error processing message from ${clientId}: ${error.message}`, 'ERROR');
      sendMessage(ws, {
        type: 'error',
        message: 'Invalid message format'
      });
    }
  });
  
  ws.on('close', (code, reason) => {
    log(`Client ${clientId} disconnected: code=${code}, reason=${reason}`, 'INFO');
    handleDisconnect(clientId);
  });
  
  ws.on('error', (error) => {
    log(`WebSocket error for ${clientId}: ${error.message}`, 'ERROR');
  });
  
  // Пинг каждые 30 секунд для поддержания соединения
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);
  
  ws.on('pong', () => {
    log(`Pong received from ${clientId}`, 'DEBUG');
  });
});

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
  
  // Проверяем, что в комнате не более 2 участников
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
  
  // Обновляем информацию о клиенте
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
  
  // Если в комнате уже есть другой участник, уведомляем обоих
  if (room.size === 2) {
    const otherClientId = Array.from(room).find(id => id !== clientId);
    const otherClient = connections.get(otherClientId);
    
    if (otherClient && otherClient.ws) {
      sendMessage(otherClient.ws, {
        type: 'user-joined',
        userId: clientId,
        participantCount: room.size
      });
      
      log(`Notified ${otherClientId} about ${clientId} joining room ${roomId}`);
    }
  }
  
  logStats();
}

function handleOffer(clientId, roomId, offer) {
  log(`Handling offer from ${clientId} in room ${roomId}`, 'DEBUG');
  
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
  if (otherClient && otherClient.ws) {
    sendMessage(otherClient.ws, {
      type: 'offer',
      offer: offer,
      fromUserId: clientId
    });
    log(`Forwarded offer from ${clientId} to ${otherClientId}`);
  } else {
    log(`Offer from ${clientId}: target client ${otherClientId} not available`, 'WARN');
  }
}

function handleAnswer(clientId, roomId, answer) {
  log(`Handling answer from ${clientId} in room ${roomId}`, 'DEBUG');
  
  const room = rooms.get(roomId);
  if (!room) return;
  
  const otherClientId = Array.from(room).find(id => id !== clientId);
  if (!otherClientId) return;
  
  const otherClient = connections.get(otherClientId);
  if (otherClient && otherClient.ws) {
    sendMessage(otherClient.ws, {
      type: 'answer',
      answer: answer,
      fromUserId: clientId
    });
    log(`Forwarded answer from ${clientId} to ${otherClientId}`);
  }
}

function handleIceCandidate(clientId, roomId, candidate) {
  log(`Handling ICE candidate from ${clientId} in room ${roomId}`, 'DEBUG');
  
  const room = rooms.get(roomId);
  if (!room) return;
  
  const otherClientId = Array.from(room).find(id => id !== clientId);
  if (!otherClientId) return;
  
  const otherClient = connections.get(otherClientId);
  if (otherClient && otherClient.ws) {
    sendMessage(otherClient.ws, {
      type: 'ice-candidate',
      candidate: candidate,
      fromUserId: clientId
    });
    log(`Forwarded ICE candidate from ${clientId} to ${otherClientId}`);
  }
}

function handleLeaveRoom(clientId, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  // Удаляем клиента из комнаты
  room.delete(clientId);
  
  log(`Client ${clientId} left room ${roomId} (${room.size} participants remaining)`);
  
  // Если комната пустая, удаляем её
  if (room.size === 0) {
    rooms.delete(roomId);
    log(`Removed empty room ${roomId}`);
  } else {
    // Уведомляем оставшегося участника
    const otherClientId = Array.from(room)[0];
    const otherClient = connections.get(otherClientId);
    
    if (otherClient && otherClient.ws) {
      sendMessage(otherClient.ws, {
        type: 'user-left',
        userId: clientId,
        participantCount: room.size
      });
      log(`Notified ${otherClientId} about ${clientId} leaving room ${roomId}`);
    }
  }
  
  // Обновляем информацию о клиенте
  const clientInfo = connections.get(clientId);
  if (clientInfo) {
    clientInfo.roomId = null;
  }
  
  logStats();
}

function handleDisconnect(clientId) {
  const clientInfo = connections.get(clientId);
  
  if (clientInfo && clientInfo.roomId) {
    handleLeaveRoom(clientId, clientInfo.roomId);
  }
  
  connections.delete(clientId);
  log(`Cleaned up connection for ${clientId}`);
  logStats();
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

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

// Обработка сигналов для graceful shutdown
process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down gracefully');
  wss.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log('Received SIGINT, shutting down gracefully');
  wss.close(() => {
    process.exit(0);
  });
});

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  log(`Signaling server running on ${HOST}:${PORT}`);
  log(`Health check available at http://${HOST}:${PORT}/health`);
  
  // Периодическая статистика каждые 5 минут
  setInterval(logStats, 5 * 60 * 1000);
});

server.on('error', (error) => {
  log(`Server error: ${error.message}`, 'ERROR');
});
