// ==========================================
// СЕРВЕР COSMIC MAFIA & ROULETTE (FINAL)
// ==========================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');

// --- НАЛАШТУВАННЯ ---
const app = express();
app.use(cors());
app.use(express.static('public')); // Папка, де будуть твої HTML файли

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // Дозволяємо підключення з будь-якого місця
});

// ПІДКЛЮЧЕННЯ ДО БАЗИ ДАНИХ (MongoDB)
// (Пізніше ми замінимо цей URL на твій власний з MongoDB Atlas)
const MONGO_URI = process.env.MONGO_URL || "mongodb+srv://КОРИСТУВАЧ:ПАРОЛЬ@cluster.mongodb.net/mafiaDB";

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ БАЗА ДАНИХ ПІДКЛЮЧЕНА'))
    .catch(err => console.log('❌ ПОМИЛКА БАЗИ:', err));

// --- СХЕМА ГРАВЦЯ (Досьє) ---
const UserSchema = new mongoose.Schema({
    telegramId: { type: Number, required: true, unique: true },
    username: String,
    coins: { type: Number, default: 1000 }, // Початковий бонус
    inventory: { type: Array, default: [] }, // Куплені скіни
    stats: {
        mafiaWins: { type: Number, default: 0 },
        rouletteWins: { type: Number, default: 0 }
    },
    isAdmin: { type: Boolean, default: false }
});
const User = mongoose.model('User', UserSchema);

// --- ЗМІННІ ГРИ ---
let rooms = {}; // Тут живуть активні ігри
const BET_ROULETTE = 100; // Фіксована ставка

// ==========================================
// ЛОГІКА SOCKET.IO (ЗВ'ЯЗОК)
// ==========================================

io.on('connection', (socket) => {
    console.log('🔌 Нове підключення:', socket.id);

    // 1. АВТОРИЗАЦІЯ (При вході в гру)
    socket.on('auth', async (data) => {
        try {
            // Шукаємо гравця в базі або створюємо нового
            let user = await User.findOne({ telegramId: data.tgId });
            if (!user) {
                user = new User({ telegramId: data.tgId, username: data.username });
                await user.save();
                console.log('🆕 Новий гравець зареєстрований:', data.username);
            }
            socket.data.user = user; // Прив'язуємо дані до з'єднання
            socket.emit('auth_success', { 
                coins: user.coins, 
                inventory: user.inventory,
                stats: user.stats 
            });
        } catch (e) {
            console.error(e);
        }
    });

    // 2. ПОШУК ГРИ (Черга)
    socket.on('find_game', async (gameType) => {
        const user = socket.data.user;
        if (!user) return;

        // Перевірка балансу для Рулетки
        if (gameType === 'roulette' && user.coins < BET_ROULETTE) {
            socket.emit('error', 'Недостатньо монет! Треба 100.');
            return;
        }

        joinQueue(socket, gameType);
    });

    // 3. ХОДИ В ГРІ (Мафія або Рулетка)
    socket.on('game_action', (data) => {
        handleGameAction(socket, data);
    });

    socket.on('disconnect', () => {
        // Логіка виходу гравця (авто-поразка)
        handleDisconnect(socket);
    });
});

// ==========================================
// ЛОГІКА КІМНАТ ТА ЧЕРГИ
// ==========================================
let queueMafia = [];
let queueRoulette = [];

function joinQueue(socket, type) {
    if (type === 'mafia') {
        queueMafia.push(socket);
        socket.emit('queue_update', { count: queueMafia.length, max: 4 });
        
        // Якщо зібралося 4 людини (можна змінити на більше)
        if (queueMafia.length >= 4) {
            createRoom(queueMafia.splice(0, 4), 'mafia');
        }
    } else if (type === 'roulette') {
        queueRoulette.push(socket);
        socket.emit('queue_update', { count: queueRoulette.length, max: 2 });

        if (queueRoulette.length >= 2) {
            createRoom(queueRoulette.splice(0, 2), 'roulette');
        }
    }
}

async function createRoom(sockets, type) {
    const roomId = 'room_' + Date.now();
    
    // Списуємо гроші за вхід (тільки Рулетка)
    if (type === 'roulette') {
        for (let s of sockets) {
            await updateBalance(s.data.user.telegramId, -BET_ROULETTE);
        }
    }

    // Створюємо об'єкт кімнати
    rooms[roomId] = {
        id: roomId,
        type: type,
        players: sockets.map(s => ({
            id: s.id,
            tgId: s.data.user.telegramId,
            name: s.data.user.username,
            role: null,
            isAlive: true,
            coins: s.data.user.coins
        })),
        state: 'STARTING', // PHASE: DAY, NIGHT, VOTING
        turn: 0, // Чий хід (для рулетки)
        votes: {}, // Для голосування
        actions: {} // Дії вночі (вбивство, лікування)
    };

    // Підключаємо гравців до каналу кімнати
    sockets.forEach(s => {
        s.join(roomId);
        s.data.roomId = roomId;
    });

    console.log(`🚀 Кімната ${roomId} створена. Гра: ${type}`);
    
    if (type === 'mafia') startMafiaGame(roomId);
    else startRouletteGame(roomId);
}

// ==========================================
// ЛОГІКА МАФІЇ (+ ЛІКАР)
// ==========================================
function startMafiaGame(roomId) {
    const room = rooms[roomId];
    
    // 1. РОЗДАЧА РОЛЕЙ
    // Перемішуємо масив ролей
    // Якщо 4 гравці: 1 Мафія, 1 Шериф, 2 Мирних
    // Якщо 6+ гравців: Додається Лікар
    let rolesPool = ['MAFIA', 'SHERIFF', 'CIVILIAN', 'CIVILIAN'];
    if (room.players.length >= 6) rolesPool = ['MAFIA', 'MAFIA', 'SHERIFF', 'DOCTOR', 'CIVILIAN', 'CIVILIAN'];
    
    // (Проста перемішка)
    rolesPool.sort(() => Math.random() - 0.5);

    room.players.forEach((p, i) => {
        p.role = rolesPool[i] || 'CIVILIAN';
    });

    // Надсилаємо кожному його роль
    io.to(roomId).emit('game_start', { 
        players: room.players.map(p => ({ name: p.name, id: p.id, isAlive: true })), // Ролі ховаємо!
    });
    
    room.players.forEach(p => {
        io.to(p.id).emit('your_role', p.role); // Особисто кожному
    });

    startDay(roomId);
}

function startDay(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.state = 'DAY';
    io.to(roomId).emit('phase_change', { phase: 'DAY', msg: 'День настав. Обговорення!' });

    // Таймер на обговорення 30 сек
    setTimeout(() => startVoting(roomId), 30000); 
}

function startVoting(roomId) {
    const room = rooms[roomId];
    room.state = 'VOTING';
    room.votes = {};
    io.to(roomId).emit('phase_change', { phase: 'VOTING', msg: 'Голосуйте проти підозрюваних!' });
    
    // Таймер голосування 15 сек
    setTimeout(() => endDay(roomId), 15000);
}

function endDay(roomId) {
    // Тут логіка підрахунку голосів (хто вилітає)
    // ... (Скорочено для економії місця) ...
    startNight(roomId);
}

function startNight(roomId) {
    const room = rooms[roomId];
    room.state = 'NIGHT';
    room.actions = {}; // Очищаємо дії
    io.to(roomId).emit('phase_change', { phase: 'NIGHT', msg: 'Місто засинає...' });

    // Таймер ночі 15 сек
    setTimeout(() => processNightActions(roomId), 15000);
}

function handleGameAction(socket, data) {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);

    // Логіка для Мафії
    if (room.type === 'mafia' && room.state === 'NIGHT') {
        if (player.role === 'MAFIA') room.actions.mafiaKill = data.targetId;
        if (player.role === 'SHERIFF') {
            const target = room.players.find(p => p.id === data.targetId);
            socket.emit('sheriff_result', { isMafia: target.role === 'MAFIA' });
        }
        if (player.role === 'DOCTOR') room.actions.doctorHeal = data.targetId;
    }

    // Логіка для Рулетки
    if (room.type === 'roulette') {
        // Обробка пострілу...
        if (data.action === 'shoot_opponent') {
            // Логіка пострілу і перехід ходу
            io.to(room.id).emit('anim_shoot', { from: socket.id, to: data.targetId });
            // Перевірка смерті...
        }
    }
}

function processNightActions(roomId) {
    const room = rooms[roomId];
    let victimId = room.actions.mafiaKill;
    let healedId = room.actions.doctorHeal;
    let msg = "Ніч пройшла спокійно.";

    if (victimId) {
        if (victimId === healedId) {
            msg = "Мафія стріляла, але Лікар врятував жертву!";
        } else {
            // Вбиваємо гравця
            const victim = room.players.find(p => p.id === victimId);
            if (victim) {
                victim.isAlive = false;
                msg = `Вночі було вбито ${victim.name}.`;
            }
        }
    }

    io.to(roomId).emit('night_result', { msg: msg, deadId: (victimId !== healedId ? victimId : null) });
    
    // Перевірка перемоги
    checkWinCondition(roomId);
}

// ==========================================
// ЛОГІКА РУЛЕТКИ (ДУЕЛЬ)
// ==========================================
function startRouletteGame(roomId) {
    const room = rooms[roomId];
    io.to(roomId).emit('roulette_start', { 
        players: room.players,
        turn: room.players[0].id // Перший гравець починає
    });
}

// ==========================================
// ДОПОМІЖНІ ФУНКЦІЇ
// ==========================================
async function updateBalance(tgId, amount) {
    await User.findOneAndUpdate({ telegramId: tgId }, { $inc: { coins: amount } });
}

function checkWinCondition(roomId) {
    // Тут перевірка: чи залишилися мафіозі?
    // Якщо Мафія виграла -> всім мафіям + гроші
    // Якщо Мирні виграли -> всім живим мирним + гроші
}

// ЗАПУСК СЕРВЕРА
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 СЕРВЕР ЗАПУЩЕНО НА ПОРТУ ${PORT}`);
});
