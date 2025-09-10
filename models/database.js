// database.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class UserDatabase {
  constructor(dbPath = './users.db') {
    this.dbPath = dbPath;
    this.db = null;
  }
  
  async initialize() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          reject(err);
        } else {
          console.log('Connected to SQLite database');
          this.createTables().then(resolve).catch(reject);
        }
      });
    });
  }
  
  async createTables() {
    const tables = [
      // Таблица пользователей
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT,
        avatar_url TEXT,
        status TEXT DEFAULT 'offline',
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      
      // Таблица контактов
      `CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        contact_user_id INTEGER NOT NULL,
        nickname TEXT,
        is_blocked INTEGER DEFAULT 0,
        is_favorite INTEGER DEFAULT 0,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id),
        FOREIGN KEY (contact_user_id) REFERENCES users (id),
        UNIQUE(user_id, contact_user_id)
      )`,
      
      // Таблица активных соединений
      `CREATE TABLE IF NOT EXISTS active_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        socket_id TEXT NOT NULL UNIQUE,
        room_id TEXT,
        connection_type TEXT DEFAULT 'chat',
        connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )`,
      
      // Таблица истории звонков
      `CREATE TABLE IF NOT EXISTS call_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        caller_id INTEGER NOT NULL,
        receiver_id INTEGER NOT NULL,
        call_type TEXT NOT NULL,
        duration INTEGER DEFAULT 0,
        status TEXT NOT NULL,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        FOREIGN KEY (caller_id) REFERENCES users (id),
        FOREIGN KEY (receiver_id) REFERENCES users (id)
      )`
    ];
    
    for (const table of tables) {
      await this.run(table);
    }
    
    // Создаем индексы
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)',
      'CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_active_connections_user_id ON active_connections(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_call_history_participants ON call_history(caller_id, receiver_id)'
    ];
    
    for (const index of indexes) {
      await this.run(index);
    }
    
    console.log('All tables created successfully');
  }
  
  // Вспомогательные методы для работы с базой
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) {
          reject(err);
        } else {
          resolve({ lastID: this.lastID, changes: this.changes });
        }
      });
    });
  }
  
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }
  
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }
  
  // ===== МЕТОДЫ ДЛЯ ПОЛЬЗОВАТЕЛЕЙ =====
  
  async createUser(username, displayName = null) {
    try {
      const result = await this.run(
        'INSERT INTO users (username, display_name, status) VALUES (?, ?, ?)',
        [username, displayName || username, 'online']
      );
      
      const user = await this.getUserById(result.lastID);
      console.log(`User created: ${username} (ID: ${result.lastID})`);
      return user;
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error('Username already exists');
      }
      throw error;
    }
  }
  
  async getUserById(id) {
    return await this.get('SELECT * FROM users WHERE id = ?', [id]);
  }
  
  async getUserByUsername(username) {
    return await this.get('SELECT * FROM users WHERE username = ?', [username]);
  }
  
  async updateUserStatus(userId, status) {
    await this.run(
      'UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?',
      [status, userId]
    );
  }
  
  async searchUsers(query, limit = 10) {
    return await this.all(
      `SELECT id, username, display_name, status, last_seen
       FROM users
       WHERE username LIKE ? OR display_name LIKE ?
       ORDER BY username
       LIMIT ?`,
      [`%${query}%`, `%${query}%`, limit]
    );
  }
  
  // ===== МЕТОДЫ ДЛЯ КОНТАКТОВ =====
  
  async addContact(userId, contactUsername, nickname = null) {
    // Находим пользователя по username
    const contactUser = await this.getUserByUsername(contactUsername);
    if (!contactUser) {
      throw new Error('User not found');
    }
    
    if (contactUser.id === userId) {
      throw new Error('Cannot add yourself as contact');
    }
    
    try {
      await this.run(
        'INSERT INTO contacts (user_id, contact_user_id, nickname) VALUES (?, ?, ?)',
        [userId, contactUser.id, nickname]
      );
      
      return await this.getContactDetails(userId, contactUser.id);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error('Contact already exists');
      }
      throw error;
    }
  }
  
  async getContacts(userId) {
    return await this.all(
      `SELECT c.*, u.username, u.display_name, u.status, u.last_seen, u.avatar_url
       FROM contacts c
       JOIN users u ON c.contact_user_id = u.id
       WHERE c.user_id = ? AND c.is_blocked = 0
       ORDER BY c.is_favorite DESC, u.display_name`,
      [userId]
    );
  }
  
  async getContactDetails(userId, contactUserId) {
    return await this.get(
      `SELECT c.*, u.username, u.display_name, u.status, u.last_seen, u.avatar_url
       FROM contacts c
       JOIN users u ON c.contact_user_id = u.id
       WHERE c.user_id = ? AND c.contact_user_id = ?`,
      [userId, contactUserId]
    );
  }
  
  async removeContact(userId, contactUserId) {
    const result = await this.run(
      'DELETE FROM contacts WHERE user_id = ? AND contact_user_id = ?',
      [userId, contactUserId]
    );
    return result.changes > 0;
  }
  
  async blockContact(userId, contactUserId) {
    await this.run(
      'UPDATE contacts SET is_blocked = 1 WHERE user_id = ? AND contact_user_id = ?',
      [userId, contactUserId]
    );
  }
  
  async unblockContact(userId, contactUserId) {
    await this.run(
      'UPDATE contacts SET is_blocked = 0 WHERE user_id = ? AND contact_user_id = ?',
      [userId, contactUserId]
    );
  }
  
  async toggleFavorite(userId, contactUserId) {
    await this.run(
      'UPDATE contacts SET is_favorite = NOT is_favorite WHERE user_id = ? AND contact_user_id = ?',
      [userId, contactUserId]
    );
  }
  
  // ===== МЕТОДЫ ДЛЯ АКТИВНЫХ СОЕДИНЕНИЙ =====
  
  async addConnection(userId, socketId, roomId = null, connectionType = 'chat') {
    // Удаляем старые соединения этого пользователя
    await this.run('DELETE FROM active_connections WHERE user_id = ?', [userId]);
    
    await this.run(
      'INSERT INTO active_connections (user_id, socket_id, room_id, connection_type) VALUES (?, ?, ?, ?)',
      [userId, socketId, roomId, connectionType]
    );
    
    console.log(`Connection added: User ${userId}, Socket ${socketId}`);
  }
  
  async removeConnection(socketId) {
    const result = await this.run(
      'DELETE FROM active_connections WHERE socket_id = ?',
      [socketId]
    );
    
    if (result.changes > 0) {
      console.log(`Connection removed: Socket ${socketId}`);
    }
  }
  
  async getConnectionBySocketId(socketId) {
    return await this.get(
      `SELECT ac.*, u.username, u.display_name
       FROM active_connections ac
       JOIN users u ON ac.user_id = u.id
       WHERE ac.socket_id = ?`,
      [socketId]
    );
  }
  
  async getConnectionByUserId(userId) {
    return await this.get(
      'SELECT * FROM active_connections WHERE user_id = ?',
      [userId]
    );
  }
  
  async updateConnectionRoom(userId, roomId, connectionType = 'call') {
    await this.run(
      'UPDATE active_connections SET room_id = ?, connection_type = ? WHERE user_id = ?',
      [roomId, connectionType, userId]
    );
  }
  
  async getActiveUsers() {
    return await this.all(
      `SELECT u.id, u.username, u.display_name, u.status, ac.socket_id, ac.room_id
       FROM users u
       JOIN active_connections ac ON u.id = ac.user_id`
    );
  }
  
  // ===== МЕТОДЫ ДЛЯ ИСТОРИИ ЗВОНКОВ =====
  
  async startCall(callerId, receiverId, callType = 'video') {
    const result = await this.run(
      'INSERT INTO call_history (caller_id, receiver_id, call_type, status) VALUES (?, ?, ?, ?)',
      [callerId, receiverId, callType, 'ongoing']
    );
    
    const call = await this.getCallById(result.lastID);
    console.log(`Call started: ${callerId} -> ${receiverId} (${callType})`);
    return call;
  }
  
  async endCall(callId, status = 'completed') {
    const call = await this.getCallById(callId);
    if (!call) {
      throw new Error('Call not found');
    }
    
    const endTime = new Date().toISOString();
    const duration = Math.floor((new Date(endTime) - new Date(call.started_at)) / 1000);
    
    await this.run(
      'UPDATE call_history SET status = ?, ended_at = ?, duration = ? WHERE id = ?',
      [status, endTime, duration, callId]
    );
    
    console.log(`Call ended: ID ${callId}, Duration: ${duration}s, Status: ${status}`);
    return await this.getCallById(callId);
  }
  
  async getCallById(callId) {
    return await this.get('SELECT * FROM call_history WHERE id = ?', [callId]);
  }
  
  async getCallHistory(userId, limit = 50) {
    return await this.all(
      `SELECT ch.*,
              caller.username as caller_username, caller.display_name as caller_name,
              receiver.username as receiver_username, receiver.display_name as receiver_name
       FROM call_history ch
       JOIN users caller ON ch.caller_id = caller.id
       JOIN users receiver ON ch.receiver_id = receiver.id
       WHERE ch.caller_id = ? OR ch.receiver_id = ?
       ORDER BY ch.started_at DESC
       LIMIT ?`,
      [userId, userId, limit]
    );
  }
  
  async getCallStats(userId) {
    const stats = await this.get(
      `SELECT
         COUNT(*) as total_calls,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_calls,
         SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END) as missed_calls,
         SUM(duration) as total_duration,
         AVG(duration) as avg_duration
       FROM call_history
       WHERE caller_id = ? OR receiver_id = ?`,
      [userId, userId]
    );
    
    return {
      totalCalls: stats.total_calls || 0,
      completedCalls: stats.completed_calls || 0,
      missedCalls: stats.missed_calls || 0,
      totalDuration: stats.total_duration || 0,
      avgDuration: Math.round(stats.avg_duration || 0)
    };
  }
  
  // ===== ДОПОЛНИТЕЛЬНЫЕ МЕТОДЫ =====
  
  async getUserWithContacts(userId) {
    const user = await this.getUserById(userId);
    if (!user) {
      return null;
    }
    
    const contacts = await this.getContacts(userId);
    const callStats = await this.getCallStats(userId);
    
    return {
      ...user,
      contacts,
      callStats
    };
  }
  
  async isUserOnline(userId) {
    const connection = await this.getConnectionByUserId(userId);
    return !!connection;
  }
  
  async close() {
    return new Promise((resolve) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) {
            console.error('Error closing database:', err);
          } else {
            console.log('Database connection closed');
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = UserDatabase;
