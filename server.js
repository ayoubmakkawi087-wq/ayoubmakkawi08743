const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

let players = {}; // لتخزين اللاعبين المتصلين

io.on('connection', (socket) => {
    console.log('لاعب جديد دخل:', socket.id);

    // تسجيل اللاعب وتحديد دوره (X أو O)
    if (Object.keys(players).length < 2) {
        const symbol = Object.keys(players).length === 0 ? 'X' : 'O';
        players[socket.id] = symbol;
        socket.emit('init', symbol); // إخبار اللاعب برمزه
    } else {
        socket.emit('full', 'اللعبة ممتلئة حالياً، يمكنك المشاهدة فقط.');
    }

    // الاستماع ل حركات اللاعبين وتمريرها للخصم
    socket.on('playerMove', (data) => {
        socket.broadcast.emit('enemyMove', data);
    });

    // إعادة تشغيل اللعبة
    socket.on('restartGame', () => {
        io.emit('restart');
    });

    // عند خروج لاعب
    socket.on('disconnect', () => {
        console.log('لاعب خرج:', socket.id);
        delete players[socket.id];
        io.emit('playerLeft');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`السيرفر الأسطوري جاهز وشغال على البورت: ${PORT}`);
});