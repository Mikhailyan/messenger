const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg'); // Библиотека для работы с PostgreSQL
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// --- ПОДКЛЮЧЕНИЕ К SUPABASE ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // Эту переменную мы зададим в Render
    ssl: { rejectUnauthorized: false }
});

// Инициализация таблиц (выполнится один раз)
const initDB = async () => {
    const client = await pool.connect();
    try {
        await client.query(`
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
        console.log("Таблицы в Supabase проверены/созданы");
    } finally {
        client.release();
    }
};
initDB();

// Настройка загрузки аватарок
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// --- API ---

app.post('/register', upload.single('avatar'), async (req, res) => {
    const { phone, email, password, name } = req.body;
    const avatar = req.file ? `/uploads/${req.file.filename}` : null;
    const hashedPassword = await bcrypt.hash(password, 10);

    try {
        const result = await pool.query(
            'INSERT INTO users (phone, email, password, name, avatar) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [phone, email, hashedPassword, name, avatar]
        );
        res.json({ success: true, user: { id: result.rows[0].id, name, avatar, email, phone } });
    } catch (err) {
        res.status(400).json({ error: "Пользователь уже существует" });
    }
});

app.post('/login', async (req, res) => {
    const { login, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1 OR phone = $1', [login]);
        const user = result.rows[0];

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ error: "Неверные данные" });
        }
        res.json({ success: true, user: { id: user.id, name: user.name, avatar: user.avatar } });
    } catch (err) {
        res.status(500).json({ error: "Ошибка сервера" });
    }
});

app.get('/search', async (req, res) => {
    const query = `%${req.query.q}%`;
    const result = await pool.query('SELECT id, name, avatar FROM users WHERE name ILIKE $1 LIMIT 10', [query]);
    res.json(result.rows);
});

app.get('/messages', async (req, res) => {
    const { myId, userId } = req.query;
    const result = await pool.query(
        'SELECT * FROM messages WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1) ORDER BY created_at ASC',
        [myId, userId]
    );
    res.json(result.rows);
});

// --- ДРУЗЬЯ ---
app.post('/friends/request', async (req, res) => {
    try {
        await pool.query('INSERT INTO friends (user_id, friend_id) VALUES ($1, $2)', [req.body.fromId, req.body.toId]);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: "Уже отправлено" }); }
});

app.get('/friends/requests', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT 
                users.id AS "userId", 
                users.name, 
                users.avatar, 
                friends.id AS "requestId" 
             FROM friends 
             JOIN users ON users.id = friends.user_id 
             WHERE friends.friend_id = $1 AND friends.status = 'pending'`,
            [req.query.userId]
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json([]);
    }
});

app.post('/friends/accept', async (req, res) => {
    await pool.query('UPDATE friends SET status = \'accepted\' WHERE id = $1', [req.body.requestId]);
    res.json({ success: true });
});

// --- SOCKETS ---
let onlineUsers = {};

io.on('connection', (socket) => {
    socket.on('login', (userId) => { onlineUsers[userId] = socket.id; });

    socket.on('send_message', async (data) => {
        const { toUserId, fromUserId, text } = data;
        await pool.query('INSERT INTO messages (sender_id, receiver_id, text) VALUES ($1, $2, $3)', [fromUserId, toUserId, text]);
        
        if (onlineUsers[toUserId]) {
            io.to(onlineUsers[toUserId]).emit('receive_message', { from: fromUserId, text });
        }
    });

    socket.on('disconnect', () => {
        for (let id in onlineUsers) if (onlineUsers[id] === socket.id) delete onlineUsers[id];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Мессенджер на Supabase запущен на порту ${PORT}`));

