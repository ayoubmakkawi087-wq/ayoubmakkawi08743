const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(__dirname));

let waitingPlayers = []; // للاعبين في الطابور العشوائي
let rooms = {}; // لغرف اللعب المخصصة برقم

io.on('connection', (socket) => {
    console.log('لاعب جديد اتصل:', socket.id);
    socket.playerName = "لاعب";

    // عند تعيين اسم اللاعب
    socket.on('setPlayerName', (name) => {
        if (name && name.trim().length <= 12) {
            socket.playerName = name.trim();
        }
    });

    // --- نظام اللعب العشوائي ---
    socket.on('joinRandom', () => {
        // إزالة اللاعب من أي غرف سابقة أو طوابير
        leaveAllRooms(socket);

        if (waitingPlayers.length > 0) {
            let opponent = waitingPlayers.shift();
            let roomId = 'rand_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
            
            socket.join(roomId);
            opponent.join(roomId);
            
            rooms[roomId] = {
                players: [opponent, socket],
                board: Array(9).fill(""),
                turn: 0
            };

            opponent.emit('gameStart', { symbol: 'X', room: roomId, opponentName: socket.playerName });
            socket.emit('gameStart', { symbol: 'O', room: roomId, opponentName: opponent.playerName });
        } else {
            waitingPlayers.push(socket);
            socket.emit('waiting', 'بانتظار لاعب آخر...');
        }
    });

    // --- نظام الغرف المخصصة (روم) ---
    socket.on('joinRoom', (roomCode) => {
        leaveAllRooms(socket);
        let code = roomCode.trim();
        if (!code) return;

        if (!rooms[code]) {
            // إنشاء غرفة جديدة كلاعب أول
            rooms[code] = {
                players: [socket],
                board: Array(9).fill(""),
                turn: 0
            };
            socket.join(code);
            socket.emit('waiting', 'أنت في الغرفة، بانتظار الخصم يدخل برقم: ' + code);
        } else if (rooms[code].players.length === 1) {
            // دخول اللاعب الثاني للغرفة
            let opponent = rooms[code].players[0];
            rooms[code].players.push(socket);
            socket.join(code);

            opponent.emit('gameStart', { symbol: 'X', room: code, opponentName: socket.playerName });
            socket.emit('gameStart', { symbol: 'O', room: code, opponentName: opponent.playerName });
        } else {
            socket.emit('roomFull', 'هذه الغرفة ممتلئة!');
        }
    });

    // --- معالجة الحركات (اللعب) ---
    socket.on('makeMove', (data) => {
        let room = rooms[data.room];
        if (!room) return;

        let activePlayer = room.players[room.turn];
        if (socket.id !== activePlayer.id) return; // ليس دوره

        if (room.board[data.index] === "") {
            room.board[data.index] = data.symbol;
            room.turn = 1 - room.turn; // تبديل الدور
            
            io.to(data.room).emit('moveMade', {
                index: data.index,
                symbol: data.symbol,
                nextTurnSymbol: room.players[room.turn].id === room.players[0].id ? 'X' : 'O'
            });
        }
    });

    // --- إعادة اللعب ---
    socket.on('restartGame', (roomCode) => {
        let room = rooms[roomCode];
        if (room) {
            room.board = Array(9).fill("");
            room.turn = 0; // يبدأ X دائماً من جديد
            io.to(roomCode).emit('restart');
        }
    });

    // --- نظام الشات ---
    socket.on('sendChatMessage', (data) => {
        if (data.room) {
            io.to(data.room).emit('receiveChatMessage', {
                sender: socket.playerName,
                message: data.message
            });
        }
    });

    // --- زر الخروج من الروم أو العودة للقائمة ---
    socket.on('leaveRoom', () => {
        leaveAllRooms(socket);
    });

    socket.on('disconnect', () => {
        console.log('لاعب قطع الاتصال:', socket.id);
        leaveAllRooms(socket);
    });
});

function leaveAllRooms(socket) {
    // إزالة من طابور العشوائي
    waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id);
    
    // إزالة من الغرف والتبليغ
    for (let code in rooms) {
        let room = rooms[code];
        let index = room.players.findIndex(p => p.id === socket.id);
        if (index !== -1) {
            room.players.splice(index, 1);
            io.to(code).emit('playerLeft');
            if (room.players.length === 0) {
                delete rooms[code];
            }
            socket.leave(code);
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`السيرفر الأسطوري جاهز وشغال على البورت: ${PORT}`);
});