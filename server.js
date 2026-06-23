const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(__dirname));

let users = {}; // لتخزين بيانات بروفايلات اللاعبين النشطين { socketId: { profile } }
let waitingPlayers = []; // طابور اللعب العشوائي
let rooms = {}; // الغرف المخصصة بالرموز

io.on('connection', (socket) => {
    console.log('لاعب دخل المنصة:', socket.id);

    // 1. إنشاء أو تحديث حساب لاعب
    socket.on('registerUser', (userData) => {
        users[socket.id] = {
            id: socket.id,
            name: userData.name || "لاعب أسطوري",
            bio: userData.bio || "لا يوجد وصف...",
            avatar: userData.avatar || "👤",
            gold: userData.gold ?? 1000,
            diamonds: userData.diamonds ?? 0,
            nameChanges: userData.nameChanges ?? 0,
            friends: userData.friends || [],
            history: userData.history || []
        };
        // إرسال البيانات المحدثة للاعب نفسه لتأكيد الحفظ
        socket.emit('updateProfile', users[socket.id]);
        // بث القائمة المحدثة للبحث عن اللاعبين
        broadcastUserList();
    });

    // 2. نظام البحث عن اللاعبين وقوائم الأصدقاء
    socket.on('searchUsers', () => {
        broadcastUserList();
    });

    socket.on('sendFriendRequest', (targetId) => {
        if (users[targetId] && targetId !== socket.id) {
            // الحد الأقصى للأصدقاء 50
            if ((users[targetId].friends.length >= 50) || (users[socket.id].friends.length >= 50)) {
                return socket.emit('notification', { type: 'error', message: 'تم الوصول للحد الأقصى للأصدقاء (50)!' });
            }
            // إرسال طلب الصداقة مباشرة للطرف الآخر
            io.to(targetId).emit('receiveFriendRequest', {
                fromId: socket.id,
                fromName: users[socket.id].name
            });
        }
    });

    socket.on('acceptFriend', (fromId) => {
        if (users[socket.id] && users[fromId]) {
            if (users[socket.id].friends.length < 50 && users[fromId].friends.length < 50) {
                if (!users[socket.id].friends.some(f => f.id === fromId)) {
                    users[socket.id].friends.push({ id: fromId, name: users[fromId].name, avatar: users[fromId].avatar });
                }
                if (!users[fromId].friends.some(f => f.id === socket.id)) {
                    users[fromId].friends.push({ id: socket.id, name: users[socket.id].name, avatar: users[socket.id].avatar });
                }
                socket.emit('updateProfile', users[socket.id]);
                io.to(fromId).emit('updateProfile', users[fromId]);
                socket.emit('notification', { type: 'success', message: 'تم قبول طلب الصداقة!' });
                io.to(fromId).emit('notification', { type: 'success', message: `${users[socket.id].name} قبل طلب صداقتك!` });
            }
        }
    });

    // 3. نظام اللعب العشوائي والمؤقت
    socket.on('joinRandom', () => {
        leaveAllRooms(socket);
        if (!users[socket.id]) return;

        if (waitingPlayers.length > 0) {
            let opponent = waitingPlayers.shift();
            let roomId = 'rand_' + Date.now();
            
            socket.join(roomId);
            opponent.join(roomId);
            
            rooms[roomId] = {
                id: roomId,
                players: [opponent, socket],
                board: Array(9).fill(""),
                turn: 0,
                timer: null,
                timeLeft: 120 // دقيقتين للقيم كامل
            };

            opponent.emit('gameStart', { symbol: 'X', room: roomId, opponent: users[socket.id] });
            socket.emit('gameStart', { symbol: 'O', room: roomId, opponent: users[opponent.id] });
            
            startRoomTimer(roomId);
        } else {
            waitingPlayers.push(socket);
            socket.emit('waiting', 'جاري البحث عن محترف مواجه لك...');
        }
    });

    // 4. نظام الغرف برقم مخصص
    socket.on('joinRoom', (roomCode) => {
        leaveAllRooms(socket);
        if (!users[socket.id] || !roomCode.trim()) return;
        let code = roomCode.trim();

        if (!rooms[code]) {
            rooms[code] = {
                id: code,
                players: [socket],
                board: Array(9).fill(""),
                turn: 0,
                timer: null,
                timeLeft: 120
            };
            socket.join(code);
            socket.emit('waiting', `أنت في الروم المخصص. بانتظار دخول صديقك برمز: ${code}`);
        } else if (rooms[code].players.length === 1) {
            let opponent = rooms[code].players[0];
            rooms[code].players.push(socket);
            socket.join(code);

            opponent.emit('gameStart', { symbol: 'X', room: code, opponent: users[socket.id] });
            socket.emit('gameStart', { symbol: 'O', room: code, opponent: users[opponent.id] });
            
            startRoomTimer(code);
        } else {
            socket.emit('notification', { type: 'error', message: 'الروم ممتلئ حالياً!' });
        }
    });

    // 5. معالجة الحركات داخل القيم
    socket.on('makeMove', (data) => {
        let room = rooms[data.room];
        if (!room) return;

        let activePlayer = room.players[room.turn];
        if (socket.id !== activePlayer.id) return;

        if (room.board[data.index] === "") {
            room.board[data.index] = data.symbol;
            room.turn = 1 - room.turn;
            
            io.to(data.room).emit('moveMade', {
                index: data.index,
                symbol: data.symbol,
                nextTurnSymbol: room.turn === 0 ? 'X' : 'O'
            });
        }
    });

    // 6. إنهاء الجيم وتحديث السجلات والمكافآت
    socket.on('gameEndResult', (data) => {
        let room = rooms[data.room];
        if (!room) return;
        clearInterval(room.timer);

        // تحديث الهستوري للاعب الحالي
        if (users[socket.id]) {
            if (users[socket.id].history.length >= 3) users[socket.id].history.shift();
            users[socket.id].history.push(data.result); // "فوز" أو "خسارة" أو "تعادل"
            
            // مكافأة ذهب عند الفوز
            if (data.result === "فوز") users[socket.id].gold += 100;
            socket.emit('updateProfile', users[socket.id]);
        }
    });

    socket.on('restartGame', (roomCode) => {
        let room = rooms[roomCode];
        if (room && room.players.length === 2) {
            room.board = Array(9).fill("");
            room.turn = 0;
            clearInterval(room.timer);
            room.timeLeft = 120;
            io.to(roomCode).emit('restart');
            startRoomTimer(roomCode);
        }
    });

    // 7. نظام الشات المطور
    socket.on('sendChatMessage', (data) => {
        if (data.room && users[socket.id]) {
            socket.to(data.room).emit('receiveChatMessage', {
                sender: users[socket.id].name,
                message: data.message
            });
        }
    });

    // 8. الخروج والمغادرة
    socket.on('leaveRoom', () => {
        leaveAllRooms(socket);
    });

    socket.on('disconnect', () => {
        leaveAllRooms(socket);
        delete users[socket.id];
        broadcastUserList();
    });
});

// دالة إدارة مؤقت الـ دقيقتين (120 ثانية) للقيم
function startRoomTimer(roomCode) {
    let room = rooms[roomCode];
    if (!room) return;
    
    clearInterval(room.timer);
    room.timer = setInterval(() => {
        room.timeLeft--;
        io.to(roomCode).emit('timerUpdate', room.timeLeft);
        
        if (room.timeLeft <= 0) {
            clearInterval(room.timer);
            io.to(roomCode).emit('timeOutEnd');
        }
    }, 1000);
}

function broadcastUserList() {
    let list = Object.values(users).map(u => ({ id: u.id, name: u.name, avatar: u.avatar, bio: u.bio }));
    io.emit('userListUpdate', list);
}

function leaveAllRooms(socket) {
    waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id);
    for (let code in rooms) {
        let room = rooms[code];
        if (room.players.some(p => p.id === socket.id)) {
            clearInterval(room.timer);
            socket.to(code).emit('opponentDisconnected');
            room.players.forEach(p => p.leave(code));
            delete rooms[code];
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`السيرفر المطور شغال بالكامل على بورت: ${PORT}`);
});