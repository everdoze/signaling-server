// signaling-server.js
const WebSocket = require('ws');
const http = require('http');
const express = require('express');

// Создаем Express приложение
const app = express();
const server = http.createServer(app);

// Включаем CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Простая проверка здоровья сервера
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    activeRooms: rooms.size,
    activeConnections: connections.size
  });
});

// Создаем WebSocket сервер
const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false // Отключаем сжатие для лучшей производительности
});

// Хранилище комнат и подключений
const rooms = new Map();
const connections = new Map();

// Функция очистки неактивных комнат
const cleanupRooms = () => {
  for (const [roomId, room] of rooms.entries()) {
    if (room.size === 0) {
      rooms.delete(roomId);
      console.log(`Removed empty room: ${roomId}`);
    }
  }
};

// Запускаем очистку каждые 30 секунд
setInterval(cleanupRooms, 30000);

wss.on('connection', (ws, req) => {
  console.log('New client connected from:', req.socket.remoteAddress);
  
  // Генерируем уникальный ID для клиента
  const clientId = generateId();
  const clientInfo = {
    ws: ws,
    roomId: null,
    connectedAt: new Date(),
    lastPing: new Date()
  };
  
  connections.set(clientId, clientInfo);
  
  // Отправляем клиенту его ID
  sendMessage(ws, {
    type: 'client-id',
    clientId: clientId
  });
  
  // Heartbeat для поддержания соединения
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
      clientInfo.lastPing = new Date();
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);
  
  ws.on('pong', () => {
    clientInfo.lastPing = new Date();
  });
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log(`Received ${data.type} from ${clientId}`);
      
      // Обновляем время последней активности
      clientInfo.lastPing = new Date();
      
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
          sendMessage(ws, { type: 'pong' });
          break;
        
        default:
          console.log('Unknown message type:', data.type);
          sendMessage(ws, {
            type: 'error',
            message: `Unknown message type: ${data.type}`
          });
      }
    } catch (error) {
      console.error('Error processing message from', clientId, ':', error);
      sendMessage(ws, {
        type: 'error',
        message: 'Invalid message format'
      });
    }
  });
  
  ws.on('close', (code, reason) => {
    console.log(`Client ${clientId} disconnected with code ${code}, reason:`, reason.toString());
    clearInterval(pingInterval);
    handleDisconnect(clientId);
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error for client', clientId, ':', error);
    clearInterval(pingInterval);
    handleDisconnect(clientId);
  });
});

function handleJoinRoom(clientId, roomId, ws) {
  if (!roomId) {
    sendMessage(ws, {
      type: 'error',
      message: 'Room ID is required'
    });
    return;
  }
  
  // Нормализуем room ID
  roomId = roomId.toString().trim();
  
  // Проверяем, что клиент не в другой комнате
  const clientInfo = connections.get(clientId);
  if (clientInfo && clientInfo.roomId) {
    handleLeaveRoom(clientId, clientInfo.roomId);
  }
  
  // Получаем или создаем комнату
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
    console.log(`Created new room: ${roomId}`);
  }
  
  const room = rooms.get(roomId);
  
  // Проверяем, что в комнате не более 2 участников
  if (room.size >= 2) {
    sendMessage(ws, {
      type: 'error',
      message: 'Room is full (maximum 2 participants)'
    });
    return;
  }
  
  // Добавляем клиента в комнату
  room.add(clientId);
  
  // Сохраняем информацию о комнате для клиента
  if (clientInfo) {
    clientInfo.roomId = roomId;
  }
  
  console.log(`Client ${clientId} joined room ${roomId} (${room.size}/2 participants)`);
  
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
    
    if (otherClient && otherClient.ws && otherClient.ws.readyState === WebSocket.OPEN) {
      // Уведомляем первого участника о присоединении второго
      sendMessage(otherClient.ws, {
        type: 'user-joined',
        userId: clientId,
        participantCount: room.size
      });
      
      // Уведомляем нового участника о том, что кто-то уже в комнате
      sendMessage(ws, {
        type: 'room-ready',
        participantCount: room.size
      });
    }
  }
}

function handleOffer(clientId, roomId, offer) {
  if (!offer) {
    console.error('Offer is missing');
    return;
  }
  
  const room = rooms.get(roomId);
  if (!room || !room.has(clientId)) {
    console.error('Client not in room or room doesn\'t exist');
    return;
  }
  
  // Находим другого участника в комнате
  const otherClientId = Array.from(room).find(id => id !== clientId);
  if (!otherClientId) {
    console.error('No other participant in room');
    return;
  }
  
  const otherClient = connections.get(otherClientId);
  if (!otherClient || !otherClient.ws || otherClient.ws.readyState !== WebSocket.OPEN) {
    console.error('Other client not available');
    return;
  }
  
  console.log(`Forwarding offer from ${clientId} to ${otherClientId}`);
  
  sendMessage(otherClient.ws, {
    type: 'offer',
    offer: offer,
    fromUserId: clientId
  });
}

function handleAnswer(clientId, roomId, answer) {
  if (!answer) {
    console.error('Answer is missing');
    return;
  }
  
  const room = rooms.get(roomId);
  if (!room || !room.has(clientId)) {
    console.error('Client not in room or room doesn\'t exist');
    return;
  }
  
  // Находим другого участника в комнате
  const otherClientId = Array.from(room).find(id => id !== clientId);
  if (!otherClientId) {
    console.error('No other participant in room');
    return;
  }
  
  const otherClient = connections.get(otherClientId);
  if (!otherClient || !otherClient.ws || otherClient.ws.readyState !== WebSocket.OPEN) {
    console.error('Other client not available');
    return;
  }
  
  console.log(`Forwarding answer from ${clientId} to ${otherClientId}`);
  
  sendMessage(otherClient.ws, {
    type: 'answer',
    answer: answer,
    fromUserId: clientId
  });
}

function handleIceCandidate(clientId, roomId, candidate) {
  if (!candidate) {
    console.error('ICE candidate is missing');
    return;
  }
  
  const room = rooms.get(roomId);
  if (!room || !room.has(clientId)) {
    console.error('Client not in room or room doesn\'t exist');
    return;
  }
  
  // Находим другого участника в комнате
  const otherClientId = Array.from(room).find(id => id !== clientId);
  if (!otherClientId) {
    // Это нормально, если другой участник еще не присоединился
    return;
  }
  
  const otherClient = connections.get(otherClientId);
  if (!otherClient || !otherClient.ws || otherClient.ws.readyState !== WebSocket.OPEN) {
    console.error('Other client not available for ICE candidate');
    return;
  }
  
  console.log(`Forwarding ICE candidate from ${clientId} to ${otherClientId}`);
  
  sendMessage(otherClient.ws, {
    type: 'ice-candidate',
    candidate: candidate,
    fromUserId: clientId
  });
}

function handleLeaveRoom(clientId, roomId) {
  const clientInfo = connections.get(clientId);
  if (!clientInfo) return;
  
  const room = rooms.get(roomId);
  if (!room) return;
  
  // Удаляем клиента из комнаты
  room.delete(clientId);
  clientInfo.roomId = null;
  
  console.log(`Client ${clientId} left room ${roomId}`);
  
  // Если в комнате остался другой участник, уведомляем его
  if (room.size > 0) {
    const remainingClientId = Array.from(room)[0];
    const remainingClient = connections.get(remainingClientId);
    
    if (remainingClient && remainingClient.ws && remainingClient.ws.readyState === WebSocket.OPEN) {
      sendMessage(remainingClient.ws, {
        type: 'user-left',
        userId: clientId,
        participantCount: room.size
      });
    }
  }
  
  // Если комната пустая, удаляем её
  if (room.size === 0) {
    rooms.delete(roomId);
    console.log(`Removed empty room: ${roomId}`);
  }
}

function handleDisconnect(clientId) {
  const clientInfo = connections.get(clientId);
  
  if (clientInfo && clientInfo.roomId) {
    handleLeaveRoom(clientId, clientInfo.roomId);
  }
  
  connections.delete(clientId);
  console.log(`Client ${clientId} fully disconnected`);
}

function sendMessage(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('Error sending message:', error);
    }
  } else {
    console.log('WebSocket not open, cannot send message');
  }
}

function generateId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

// Функция для получения статистики сервера
function getServerStats() {
  return {
    activeConnections: connections.size,
    activeRooms: rooms.size,
    roomDetails: Array.from(rooms.entries()).map(([roomId, participants]) => ({
      roomId,
      participantCount: participants.size
    }))
  };
}

// Логируем статистику каждые 60 секунд
setInterval(() => {
  const stats = getServerStats();
  console.log('Server stats:', stats);
}, 60000);


const termitate = () => {
  // Уведомляем всех клиентов о закрытии сервера
  iterateConnections((clientId, clientInfo) => {
    if (clientInfo.ws.readyState === WebSocket.OPEN) {
      sendMessage(clientInfo.ws, {
        type: 'server-shutdown',
        message: 'Server is shutting down'
      });
      clientInfo.ws.close();
    }
  });
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
};

const iterateConnections = (callback = () => {}) => {
  for (const [clientId, clientInfo] of connections.entries()) {
    callback(clientId, clientInfo)
  }
};

// Обработка graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  termitate();
});

process.on('SIGINT', () => {
  console.log('SIGINT received, closing server...');
  termitate();
});

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`Signaling server running on ${HOST}:${PORT}`);
  console.log(`Health check available at http://${HOST}:${PORT}/health`);
});
