// ИСПРАВЛЕННЫЙ signaling-server.js
const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
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

const wss = new WebSocket.Server({ server });

// Хранилище комнат и подключений
const rooms = new Map();
const connections = new Map();

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
}

wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress;
  const clientId = generateId();
  
  log(`New client connected: ${clientId} from ${clientIP}`);
  
  // ИСПРАВЛЕНО: правильная структура хранения клиента
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
      log(`Received from ${clientId}: ${data.type}`);
      
      switch (data.type) {
        case 'peer-ready':
          handlePeerReady(clientId, data.roomId, ws);
          break;
        
        case 'join-room':
          handleJoinRoom(clientId, data.roomId, ws);
          break;
        
        case 'offer':
          log(`Processing offer from ${clientId} to room ${data.roomId}`);
          handleOffer(clientId, data.roomId, data.offer);
          break;
        
        case 'answer':
          log(`Processing answer from ${clientId} to room ${data.roomId}`);
          handleAnswer(clientId, data.roomId, data.answer);
          break;
        
        case 'ice-candidate':
          handleIceCandidate(clientId, data.roomId, data.candidate);
          break;
        
        case 'leave-room':
          handleLeaveRoom(clientId, data.roomId);
          break;
        
        case 'ping':
          sendMessage(ws, { type: 'pong', timestamp: Date.now() });
          break;
        
        default:
          log(`Unknown message type from ${clientId}: ${data.type}`, 'WARN');
      }
    } catch (error) {
      log(`Error processing message from ${clientId}: ${error.message}`, 'ERROR');
    }
  });
  
  ws.on('close', (code, reason) => {
    log(`Client ${clientId} disconnected: code=${code}, reason=${reason}`);
    handleDisconnect(clientId);
  });
  
  ws.on('error', (error) => {
    log(`WebSocket error for ${clientId}: ${error.message}`, 'ERROR');
  });
});

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

// ИСПРАВЛЕННЫЙ handleOffer
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

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  log(`Signaling server running on ${HOST}:${PORT}`);
  log(`Health check available at http://${HOST}:${PORT}/health`);
});

server.on('error', (error) => {
  log(`Server error: ${error.message}`, 'ERROR');
});
