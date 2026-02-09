const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const multer = require('multer');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // Разрешаем подключения со всех адресов
});

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// --- ИНИЦИАЛИЗАЦИЯ БАЗЫ ДАННЫХ ---
const db = new sqlite3.Database('./messenger.db');

db.serialize(() => {
    // Таблица пользователей
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT UNIQUE,
        email TEXT UNIQUE,
        password TEXT,
        name TEXT,
        avatar TEXT
    )`);

    // Таблица сообщений
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER,
        receiver_id INTEGER,
        text TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

db.run(`CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    friend_id INTEGER,
    status TEXT DEFAULT 'pending', 
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(friend_id) REFERENCES users(id)
)`);

// --- НАСТРОЙКА ЗАГРУЗКИ ФАЙЛОВ ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// --- API МАРШРУТЫ ---

// 1. Регистрация
app.post('/register', upload.single('avatar'), async (req, res) => {
    try {
        const { phone, email, password, name } = req.body;
        const avatar = req.file ? `/uploads/${req.file.filename}` : null;
        const hashedPassword = await bcrypt.hash(password, 10);

        const sql = `INSERT INTO users (phone, email, password, name, avatar) VALUES (?, ?, ?, ?, ?)`;
        db.run(sql, [phone, email, hashedPassword, name, avatar], function(err) {
            if (err) return res.status(400).json({ error: "Email или телефон уже заняты" });
            res.json({ success: true, user: { id: this.lastID, name, avatar, email, phone } });
        });
    } catch (e) {
        res.status(500).json({ error: "Ошибка сервера" });
    }
});

// 2. Вход
app.post('/login', (req, res) => {
    const { login, password } = req.body;
    const sql = `SELECT * FROM users WHERE email = ? OR phone = ?`;

    db.get(sql, [login, login], async (err, user) => {
        if (err || !user) return res.status(400).json({ error: "Пользователь не найден" });

        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) return res.status(400).json({ error: "Неверный пароль" });

        res.json({ success: true, user: { id: user.id, name: user.name, avatar: user.avatar, email: user.email, phone: user.phone } });
    });
});

// 3. Поиск пользователей
app.get('/search', (req, res) => {
    const query = `%${req.query.q}%`;
    db.all(`SELECT id, name, avatar FROM users WHERE name LIKE ? LIMIT 10`, [query], (err, rows) => {
        res.json(rows || []);
    });
});

// 4. История сообщений
app.get('/messages', (req, res) => {
    const myId = Number(req.query.myId);
    const userId = Number(req.query.userId);

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

// --- REAL-TIME ЧАТ (SOCKET.IO) ---
let onlineUsers = {}; // { userId: socketId }

io.on('connection', (socket) => {
    console.log('Новое подключение:', socket.id);

    socket.on('login', (userId) => {
        onlineUsers[userId] = socket.id;
        console.log(`Пользователь ${userId} теперь онлайн`);
    });

    socket.on('send_message', (data) => {
        const { toUserId, fromUserId, text } = data;

        // Сохраняем в базу
        const sql = `INSERT INTO messages (sender_id, receiver_id, text) VALUES (?, ?, ?)`;
        db.run(sql, [fromUserId, toUserId, text], function(err) {
            if (err) return console.error("Ошибка сохранения сообщения:", err);

            // Отправляем получателю, если он в сети
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
        for (let userId in onlineUsers) {
            if (onlineUsers[userId] === socket.id) {
                delete onlineUsers[userId];
                break;
            }
        }
    });
});

// Отправить запрос в друзья
app.post('/friends/request', (req, res) => {
    const { fromId, toId } = req.body;
    db.run(`INSERT INTO friends (user_id, friend_id) VALUES (?, ?)`, [fromId, toId], (err) => {
        if (err) return res.status(400).json({ error: "Запрос уже отправлен" });
        res.json({ success: true });
    });
});

// Получить список входящих заявок
app.get('/friends/requests', (req, res) => {
    const userId = req.query.userId;
    const sql = `
        SELECT users.id, users.name, users.avatar, friends.id as requestId
        FROM friends 
        JOIN users ON users.id = friends.user_id 
        WHERE friends.friend_id = ? AND friends.status = 'pending'`;
    
    db.all(sql, [userId], (err, rows) => {
        res.json(rows || []);
    });
});

// Принять заявку
app.post('/friends/accept', (req, res) => {
    const { requestId } = req.body;
    db.run(`UPDATE friends SET status = 'accepted' WHERE id = ?`, [requestId], (err) => {
        res.json({ success: true });
    });
});
// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер летит на порту ${PORT}`);
});

