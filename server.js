const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" },
    transports: ['websocket', 'polling'] 
});

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// --- ПОДКЛЮЧЕНИЕ К SUPABASE ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Инициализация таблиц
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                phone TEXT UNIQUE,
                email TEXT UNIQUE,
                password TEXT,
                name TEXT,
                avatar TEXT
            );
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender_id INTEGER REFERENCES users(id),
                receiver_id INTEGER REFERENCES users(id),
                text TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS friends (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                friend_id INTEGER REFERENCES users(id),
                status TEXT DEFAULT 'pending',
                UNIQUE(user_id, friend_id)
            );
        `);
        console.log("✅ Все таблицы в Supabase готовы к работе");
    } catch (err) {
        console.error("❌ Ошибка инициализации таблиц:", err.message);
    }
};
initDB();

// Настройка загрузки файлов
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// --- API МАРШРУТЫ ---

// Регистрация
app.post('/register', upload.single('avatar'), async (req, res) => {
    const { phone, email, password, name } = req.body;
    const avatar = req.file ? `/uploads/${req.file.filename}` : null;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (phone, email, password, name, avatar) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [phone, email, hashedPassword, name, avatar]
        );
        res.json({ success: true, user: { id: result.rows[0].id, name, avatar } });
    } catch (err) {
        console.error("Ошибка регистрации:", err.message);
        res.status(400).json({ error: "Email или телефон уже заняты" });
    }
});

// Вход
app.post('/login', async (req, res) => {
    const { login, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1 OR phone = $1', [login]);
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ error: "Неверный логин или пароль" });
        }
        res.json({ success: true, user: { id: user.id, name: user.name, avatar: user.avatar } });
    } catch (err) {
        res.status(500).json({ error: "Ошибка сервера" });
    }
});

// Поиск
app.get('/search', async (req, res) => {
    try {
        const query = `%${req.query.q}%`;
        const result = await pool.query('SELECT id, name, avatar FROM users WHERE name ILIKE $1 LIMIT 10', [query]);
        res.json(result.rows);
    } catch (e) { res.json([]); }
});

// История сообщений
app.get('/messages', async (req, res) => {
    try {
        const myId = Number(req.query.myId);
        const userId = Number(req.query.userId);
        const result = await pool.query(
            'SELECT * FROM messages WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1) ORDER BY created_at ASC',
            [myId, userId]
        );
        res.json(result.rows);
    } catch (e) { res.json([]); }
});

// --- ДРУЗЬЯ ---
app.post('/friends/request', async (req, res) => {
    try {
        const fromId = Number(req.body.fromId);
        const toId = Number(req.body.toId);
        await pool.query('INSERT INTO friends (user_id, friend_id) VALUES ($1, $2)', [fromId, toId]);
        res.json({ success: true });
    } catch (e) { 
        res.status(400).json({ error: "Запрос уже существует" }); 
    }
});

app.get('/friends/requests', async (req, res) => {
    try {
        const userId = Number(req.query.userId);
        const result = await pool.query(
            `SELECT u.id AS "userId", u.name, u.avatar, f.id AS "requestId" 
             FROM friends f JOIN users u ON u.id = f.user_id 
             WHERE f.friend_id = $1 AND f.status = 'pending'`,
            [userId]
        );
        res.json(result.rows);
    } catch (e) { res.json([]); }
});

app.post('/friends/accept', async (req, res) => {
    try {
        const requestId = Number(req.body.requestId);
        await pool.query('UPDATE friends SET status = \'accepted\' WHERE id = $1', [requestId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Ошибка" }); }
});

// --- SOCKET.IO ---
let onlineUsers = {};

io.on('connection', (socket) => {
    socket.on('login', (userId) => {
        if (!userId) return;
        const uid = Number(userId);
        onlineUsers[uid] = socket.id;
        console.log(`📡 Пользователь ${uid} привязал сокет ${socket.id}`);
    });

    socket.on('send_message', async (data) => {
        const { toUserId, fromUserId, text } = data;
        const to = Number(toUserId);
        const from = Number(fromUserId);

        try {
            // Сохраняем в БД
            await pool.query('INSERT INTO messages (sender_id, receiver_id, text) VALUES ($1, $2, $3)', [from, to, text]);
            
            // Пересылаем
            const recipientSocketId = onlineUsers[to];
            if (recipientSocketId) {
                io.to(recipientSocketId).emit('receive_message', { from, text });
                console.log(`📩 Сообщение от ${from} для ${to} переслано`);
            }
        } catch (err) {
            console.error("Ошибка сокетов:", err.message);
        }
    });

    socket.on('disconnect', () => {
        for (let id in onlineUsers) {
            if (onlineUsers[id] === socket.id) {
                delete onlineUsers[id];
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
