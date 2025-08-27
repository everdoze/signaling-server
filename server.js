// server.js - Сигнальный сервер для WebRTC
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Настройка CORS для Socket.IO
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json());

// Хранилище активных соединений
const connectedUsers = new Map();
const activeCalls = new Map();

// Базовый маршрут для проверки сервера
app.get('/', (req, res) => {
  res.send('Сигнальный сервер работает');
});

// API для получения списка онлайн пользователей
app.get('/users', (req, res) => {
  const users = Array.from(connectedUsers.values());
  res.json(users);
});

io.on('connection', (socket) => {
  console.log(`Пользователь подключен: ${socket.id}`);
  
  // Добавляем пользователя в список подключенных
  connectedUsers.set(socket.id, {
    id: socket.id,
    timestamp: Date.now()
  });
  
  // Уведомляем всех о новом пользователе
  socket.broadcast.emit('user-connected', {
    userId: socket.id,
    totalUsers: connectedUsers.size
  });
  
  // Отправляем текущему пользователю список онлайн пользователей
  socket.emit('users-list', Array.from(connectedUsers.values()));
  
  // Обработка запроса на звонок
  socket.on('call-request', (data) => {
    console.log(`Запрос звонка от ${data.from} к ${data.to}`);
    
    // Проверяем, что получатель онлайн
    if (!connectedUsers.has(data.to)) {
      socket.emit('call-error', {
        message: 'Пользователь не в сети',
        code: 'USER_OFFLINE'
      });
      return;
    }
    
    // Проверяем, что получатель не в другом звонке
    let targetInCall = false;
    for (let [callId, call] of activeCalls) {
      if (call.participants.includes(data.to)) {
        targetInCall = true;
        break;
      }
    }
    
    if (targetInCall) {
      socket.emit('call-error', {
        message: 'Пользователь занят',
        code: 'USER_BUSY'
      });
      return;
    }
    
    // Создаем новый звонок
    const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    activeCalls.set(callId, {
      id: callId,
      participants: [data.from, data.to],
      initiator: data.from,
      status: 'ringing',
      timestamp: Date.now()
    });
    
    // Отправляем запрос получателю
    socket.to(data.to).emit('call-request', {
      ...data,
      callId: callId
    });
    
    console.log(`Создан звонок ${callId} между ${data.from} и ${data.to}`);
  });
  
  // Обработка принятия звонка
  socket.on('call-accepted', (data) => {
    console.log(`Звонок принят пользователем ${socket.id}`);
    
    // Находим активный звонок
    let targetCall = null;
    for (let [callId, call] of activeCalls) {
      if (call.participants.includes(socket.id) && call.participants.includes(data.to)) {
        targetCall = call;
        break;
      }
    }
    
    if (targetCall) {
      targetCall.status = 'accepted';
      
      // Уведомляем инициатора звонка
      socket.to(data.to).emit('call-accepted', {
        from: socket.id,
        callId: targetCall.id
      });
    }
  });
  
  // Обработка отклонения звонка
  socket.on('call-rejected', (data) => {
    console.log(`Звонок отклонен пользователем ${socket.id}`);
    
    // Находим и удаляем звонок
    for (let [callId, call] of activeCalls) {
      if (call.participants.includes(socket.id) && call.participants.includes(data.to)) {
        activeCalls.delete(callId);
        break;
      }
    }
    
    // Уведомляем инициатора
    socket.to(data.to).emit('call-rejected', {
      from: socket.id
    });
  });
  
  // Обработка WebRTC offer
  socket.on('offer', (data) => {
    console.log(`Получен offer от ${socket.id} для ${data.to}`);
    socket.to(data.to).emit('offer', {
      offer: data.offer,
      from: socket.id
    });
  });
  
  // Обработка WebRTC answer
  socket.on('answer', (data) => {
    console.log(`Получен answer от ${socket.id} для ${data.to}`);
    socket.to(data.to).emit('answer', {
      answer: data.answer,
      from: socket.id
    });
  });
  
  // Обработка ICE candidates
  socket.on('ice-candidate', (data) => {
    console.log(`ICE candidate от ${socket.id} для ${data.to}`);
    socket.to(data.to).emit('ice-candidate', {
      candidate: data.candidate,
      from: socket.id
    });
  });
  
  // Обработка завершения звонка
  socket.on('call-ended', (data) => {
    console.log(`Звонок завершен пользователем ${socket.id}`);
    
    // Находим и удаляем звонок
    for (let [callId, call] of activeCalls) {
      if (call.participants.includes(socket.id)) {
        activeCalls.delete(callId);
        
        // Уведомляем другого участника
        const otherParticipant = call.participants.find(p => p !== socket.id);
        if (otherParticipant) {
          socket.to(otherParticipant).emit('call-ended', {
            from: socket.id
          });
        }
        break;
      }
    }
  });
  
  // Обработка отключения пользователя
  socket.on('disconnect', () => {
    console.log(`Пользователь отключен: ${socket.id}`);
    
    // Удаляем пользователя из списка подключенных
    connectedUsers.delete(socket.id);
    
    // Завершаем все активные звонки пользователя
    for (let [callId, call] of activeCalls) {
      if (call.participants.includes(socket.id)) {
        // Уведомляем другого участника
        const otherParticipant = call.participants.find(p => p !== socket.id);
        if (otherParticipant) {
          socket.to(otherParticipant).emit('call-ended', {
            from: socket.id,
            reason: 'USER_DISCONNECTED'
          });
        }
        
        // Удаляем звонок
        activeCalls.delete(callId);
      }
    }
    
    // Уведомляем всех об отключении пользователя
    socket.broadcast.emit('user-disconnected', {
      userId: socket.id,
      totalUsers: connectedUsers.size
    });
  });
  
  // Heartbeat для проверки соединения
  socket.on('ping', () => {
    socket.emit('pong');
  });
});

// Очистка неактивных звонков (каждые 5 минут)
setInterval(() => {
  const now = Date.now();
  const CALL_TIMEOUT = 5 * 60 * 1000; // 5 минут
  
  for (let [callId, call] of activeCalls) {
    if (now - call.timestamp > CALL_TIMEOUT && call.status === 'ringing') {
      console.log(`Удаление неактивного звонка: ${callId}`);
      activeCalls.delete(callId);
    }
  }
}, 5 * 60 * 1000);

// Логирование статистики каждые 30 секунд
setInterval(() => {
  console.log(`Статистика - Подключено: ${connectedUsers.size}, Активных звонков: ${activeCalls.size}`);
}, 30 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сигнальный сервер запущен на порту ${PORT}`);
  console.log(`WebSocket доступен по адресу: ws://localhost:${PORT}`);
});

module.exports = app;
