const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// تخزين الغرف واللاعبين داخلها
// الشكل سيكون: { 'room123': { players: { 'socketId': 'X' } } }
let rooms = {}; 

io.on('connection', (socket) => {
    console.log('لاعب جديد متصل:', socket.id);

    // الاستماع لحدث الانضمام لغرفة
    socket.on('joinRoom', (roomName) => {
        // إذا الغرفة مش موجودة، بننشئها
        if (!rooms[roomName]) {
            rooms[roomName] = { players: {} };
        }

        const currentPlayers = Object.keys(rooms[roomName].players);

        // التحقق لو الغرفة مليانة
        if (currentPlayers.length < 2) {
            socket.join(roomName); // إدخال اللاعب للغرفة في Socket.io
            socket.roomName = roomName; // حفظ اسم الغرفة في السوكت الخاص باللاعب

            // تحديد الرمز (X للأول و O للثاني)
            const symbol = currentPlayers.length === 0 ? 'X' : 'O';
            rooms[roomName].players[socket.id] = symbol;

            // إرسال الرمز للاعب
            socket.emit('init', symbol);
            console.log(`اللاعب ${socket.id} دخل الغرفة: ${roomName} كـ ${symbol}`);
        } else {
            socket.emit('full', 'هذه الغرفة ممتلئة حالياً!');
        }
    });

    // تمرير الحركات داخل نفس الغرفة فقط باستخدام to(roomName)
    socket.on('playerMove', (data) => {
        if (socket.roomName) {
            socket.to(socket.roomName).emit('enemyMove', data);
        }
    });

    socket.on('restartGame', () => {
        if (socket.roomName) {
            io.to(socket.roomName).emit('restart');
        }
    });

    // عند المغادرة
    socket.on('disconnect', () => {
        const roomName = socket.roomName;
        if (roomName && rooms[roomName]) {
            console.log('لاعب خرج من الغرفة:', roomName);
            delete rooms[roomName].players[socket.id];
            io.to(roomName).emit('playerLeft');
            
            // لو الغرفة فضيت تماماً احذفها من الذاكرة
            if (Object.keys(rooms[roomName].players).length === 0) {
                delete rooms[roomName];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`السيرفر شغال وجاهز على البورت: ${PORT}`);
});