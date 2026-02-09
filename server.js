const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const multer = require('multer');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs'); // Для защиты паролей

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// --- БАЗА ДАННЫХ (SQLite) ---
const db = new sqlite3.Database('./messenger.db', (err) => {
    if (err) console.error(err.message);
    else console.log('Подключено к базе данных SQLite.');
});

// Создаем таблицу пользователей, если её нет
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT UNIQUE,
        email TEXT UNIQUE,
        password TEXT,
        name TEXT,
        avatar TEXT
    )`);
});
db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER,
    receiver_id INTEGER,
    text TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Настройка загрузки картинок
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// Храним активные сокеты в памяти (кто сейчас онлайн)
let onlineUsers = {}; // { userId: socketId }

// --- API ---

// 1. РЕГИСТРАЦИЯ
app.post('/register', upload.single('avatar'), async (req, res) => {
    const { phone, email, password, name } = req.body;
    const avatar = req.file ? `/uploads/${req.file.filename}` : null;
    
    // Хешируем пароль (шифруем)
    const hashedPassword = await bcrypt.hash(password, 10);

    const sql = `INSERT INTO users (phone, email, password, name, avatar) VALUES (?, ?, ?, ?, ?)`;
    
    db.run(sql, [phone, email, hashedPassword, name, avatar], function(err) {
        if (err) {
            return res.status(400).json({ error: "Пользователь с таким телефоном или email уже есть" });
        }
        // Возвращаем созданного пользователя (без пароля)
        res.json({ 
            success: true, 
            user: { id: this.lastID, phone, email, name, avatar } 
        });
    });
});

// 2. ВХОД (LOGIN)
app.post('/login', (req, res) => {
    const { login, password } = req.body; // login может быть email или телефон

    const sql = `SELECT * FROM users WHERE email = ? OR phone = ?`;
    db.get(sql, [login, login], async (err, user) => {
        if (err || !user) {
            return res.status(400).json({ error: "Пользователь не найден" });
        }

        // Проверяем пароль
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ error: "Неверный пароль" });
        }

        // Успех
        res.json({ 
            success: true, 
            user: { id: user.id, phone: user.phone, email: user.email, name: user.name, avatar: user.avatar } 
        });
    });
});

// 3. ПОИСК
app.get('/search', (req, res) => {
    const query = `%${req.query.q}%`; // Ищем частичное совпадение
    const sql = `SELECT id, name, avatar FROM users WHERE name LIKE ?`;
    
    db.all(sql, [query], (err, rows) => {
        if (err) return res.json([]);
        res.json(rows);
    });
});

// --- SOCKET.IO ---

io.on('connection', (socket) => {
    // Пользователь зашел
    socket.on('login', (userId) => {
        onlineUsers[userId] = socket.id;
        console.log(`User ${userId} is online`);
    });
    

    // Отправка сообщения
    socket.on('send_message', (data) => {
        const recipientSocketId = onlineUsers[data.toUserId];
        
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('receive_message', {
                from: data.fromUserId,
                text: data.text
            });
        }
    });
    socket.on('send_message', (data) => {
    const { toUserId, fromUserId, text } = data;

    // Сохраняем в БД
    const sql = `INSERT INTO messages (sender_id, receiver_id, text) VALUES (?, ?, ?)`;
    db.run(sql, [fromUserId, toUserId, text], function(err) {
        if (err) return console.error(err.message);

        // Пересылаем получателю, если он онлайн
        const recipientSocketId = onlineUsers[toUserId];
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('receive_message', {
                from: fromUserId,
                text: text
            });
        }
    });
});

    socket.on('disconnect', () => {
        // Удаляем из списка онлайн (можно оптимизировать)
        for (let userId in onlineUsers) {
            if (onlineUsers[userId] === socket.id) {
                delete onlineUsers[userId];
                break;
            }
        }
    });
});

// 1. Добавь создание таблицы (в блок db.serialize)
db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER,
    receiver_id INTEGER,
    text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// 2. Добавь API для загрузки истории сообщений
app.get('/messages', (req, res) => {
    const { myId, userId } = req.query;
    // Выбираем сообщения, где отправитель я И получатель он, ИЛИ наоборот
    const sql = `
        SELECT * FROM messages 
        WHERE (sender_id = ? AND receiver_id = ?) 
           OR (sender_id = ? AND receiver_id = ?)
        ORDER BY created_at ASC`;
    
    db.all(sql, [myId, userId, userId, myId], (err, rows) => {
        if (err) return res.status(500).json([]);
        res.json(rows);
    });
});

// 3. Обнови обработчик socket.on('send_message')
socket.on('send_message', (data) => {
    const { toUserId, fromUserId, text } = data;
    const sql = `INSERT INTO messages (sender_id, receiver_id, text) VALUES (?, ?, ?)`;
    
    db.run(sql, [fromUserId, toUserId, text], function(err) {
        if (err) return;
        
        const recipientSocketId = onlineUsers[toUserId];
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('receive_message', {
                from: fromUserId,
                text: text
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту ${PORT}`);

});


