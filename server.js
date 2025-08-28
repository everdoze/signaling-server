// signaling-server.js
const WebSocket = require('ws');
const http = require('http');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Хранилище комнат и подключений
const rooms = new Map();
const connections = new Map();

wss.on('connection', (ws) => {
  console.log('New client connected');
  
  // Генерируем уникальный ID для клиента
  const clientId = generateId();
  connections.set(clientId, ws);
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('Received:', data.type, 'from', clientId);
      
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
        
        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('Client disconnected:', clientId);
    handleDisconnect(clientId);
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
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
  
  // Получаем или создаем комнату
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  
  const room = rooms.get(roomId);
  
  // Проверяем, что в комнате не более 2 участников
  if (room.size >= 2) {
    sendMessage(ws, {
      type: 'error',
      message: 'Room is full'
    });
    return;
  }
  
  // Добавляем клиента в комнату
  room.add(clientId);
  
  // Сохраняем информацию о комнате для клиента
  const clientInfo = {
    ws: ws,
    roomId: roomId
  };
  connections.set(clientId, clientInfo);
  
  console.log(`Client ${clientId} joined room ${roomId}`);
  
  // Отправляем подтверждение
  sendMessage(ws, {
    type: 'room-joined',
    roomId: roomId
  });
  
  // Если в комнате уже есть другой участник, уведомляем его
  if (room.size === 2) {
    const otherClientId = Array.from(room).find(id => id !== clientId);
    const otherClient = connections.get(otherClientId);
    
    if (otherClient && otherClient.ws) {
      sendMessage(otherClient.ws, {
        type: 'user-joined',
        userId: clientId
      });
    }
  }
}

function handleOffer(clientId, roomId, offer) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  // Находим другого участника в комнате
  const otherClientId = Array.from(room).find(id => id !== clientId);
  if (!otherClientId) return;
  
  const otherClient = connections.get(otherClientId);
  if (otherClient && otherClient.ws) {
    sendMessage(otherClient.ws, {
      type: 'offer',
      offer: offer,
      fromUserId: clientId
    });
  }
}

function handleAnswer(clientId, roomId, answer) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  // Находим другого участника в комнате
  const otherClientId = Array.from(room).find(id => id !== clientId);
  if (!otherClientId) return;
  
  const otherClient = connections.get(otherClientId);
  if (otherClient && otherClient.ws) {
    sendMessage(otherClient.ws, {
      type: 'answer',
      answer: answer,
      fromUserId: clientId
    });
  }
}

function handleIceCandidate(clientId, roomId, candidate) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  // Находим другого участника в комнате
  const otherClientId = Array.from(room).find(id => id !== clientId);
  if (!otherClientId) return;
  
  const otherClient = connections.get(otherClientId);
  if (otherClient && otherClient.ws) {
    sendMessage(otherClient.ws, {
      type: 'ice-candidate',
      candidate: candidate,
      fromUserId: clientId
    });
  }
}

function handleLeaveRoom(clientId, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  // Удаляем клиента из комнаты
  room.delete(clientId);
  
  // Если комната пустая, удаляем её
  if (room.size === 0) {
    rooms.delete(roomId);
  } else {
    // Уведомляем оставшегося участника
    const otherClientId = Array.from(room)[0];
    const otherClient = connections.get(otherClientId);
    
    if (otherClient && otherClient.ws) {
      sendMessage(otherClient.ws, {
        type: 'user-left',
        userId: clientId
      });
    }
  }
  
  console.log(`Client ${clientId} left room ${roomId}`);
}

function handleDisconnect(clientId) {
  const clientInfo = connections.get(clientId);
  
  if (clientInfo && clientInfo.roomId) {
    handleLeaveRoom(clientId, clientInfo.roomId);
  }
  
  connections.delete(clientId);
}

function sendMessage(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Signaling server running on port ${PORT}`);
});
