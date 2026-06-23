const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server);

app.use(express.static(__dirname));

// قاعدة بيانات حية داخل الذاكرة
let onlineUsers = {}; // socket.id -> user profile
let rooms = {};       // roomCode -> room data
let privateChats = []; // تخزين الرسائل: { fromId, toId, senderName, message, timestamp }

// تنظيف رسائل الشات الخاص تلقائياً كل ساعة (لحذف الرسائل التي مر عليها أكثر من 12 ساعة)
setInterval(() => {
    const twelveHoursAgo = Date.now() - (12 * 60 * 60 * 1000);
    privateChats = privateChats.filter(msg => msg.timestamp > twelveHoursAgo);
}, 60 * 60 * 1000);

io.on('connection', (socket) => {
    console.log(`لاعب متصل جديد: ${socket.id}`);

    // 1. تسجيل الدخول أو إنشاء الحساب لأول مرة
    socket.on('registerUser', (userData) => {
        let isNameTaken = Object.values(onlineUsers).some(
            u => u.name.toLowerCase() === userData.name.toLowerCase() && u.id !== socket.id
        );

        if (isNameTaken) {
            socket.emit('notification', { type: 'error', message: '⚠️ هذا الاسم مستخدم بالفعل! اختر اسماً فريداً.' });
            return;
        }

        onlineUsers[socket.id] = {
            id: socket.id,
            name: userData.name,
            avatar: userData.avatar || '🥷',
            bio: userData.bio || '',
            gold: userData.gold ?? 1000,
            diamonds: userData.diamonds ?? 150, 
            friends: userData.friends || [],
            friendRequests: userData.friendRequests || [], 
            history: userData.history || []
        };

        socket.emit('updateProfile', onlineUsers[socket.id]);
        io.emit('globalUserList', Object.values(onlineUsers));
    });

    // 2. تحديث البروفايل (تغيير الاسم بخصم 100 جوهرة)
    socket.on('updateBioAndAvatar', (data) => {
        let user = onlineUsers[socket.id];
        if (!user) return;

        if (data.name && data.name.toLowerCase() !== user.name.toLowerCase()) {
            let isNameTaken = Object.values(onlineUsers).some(
                u => u.name.toLowerCase() === data.name.toLowerCase() && u.id !== socket.id
            );
            if (isNameTaken) {
                socket.emit('notification', { type: 'error', message: '⚠️ الاسم الجديد مستخدم من قبل لاعب آخر!' });
                return;
            }
            if (user.diamonds < 100) {
                socket.emit('notification', { type: 'error', message: '❌ لا تملك مجوهرات كافية لتغيير الاسم! (تكلفة التغيير 100 جوهرة).' });
                return;
            }
            user.diamonds -= 100;
            user.name = data.name;
        }

        user.avatar = data.avatar;
        user.bio = data.bio;

        socket.emit('updateProfile', user);
        io.emit('globalUserList', Object.values(onlineUsers));
        socket.emit('notification', { type: 'success', message: '✨ تم حفظ وتحديث بيانات بروفايلك بنجاح!' });
    });

    // 3. إرسال طلب صداقة
    socket.on('sendFriendRequest', (targetSocketId) => {
        let sender = onlineUsers[socket.id];
        let receiver = onlineUsers[targetSocketId];

        if (!sender || !receiver || socket.id === targetSocketId) return;

        if (sender.friends.length >= 50) {
            socket.emit('notification', { type: 'error', message: '❌ لا يمكنك إرسال الطلب، لقد وصلت للحد الأقصى للأصدقاء (50 صديق)!' });
            return;
        }
        if (receiver.friends.length >= 50) {
            socket.emit('notification', { type: 'error', message: '❌ هذا اللاعب ممتلئ ولديه 50 صديقاً بالفعل!' });
            return;
        }

        if (!receiver.friendRequests.some(r => r.id === socket.id)) {
            receiver.friendRequests.push({ id: socket.id, name: sender.name, avatar: sender.avatar });
            io.to(targetSocketId).emit('updateProfile', receiver);
            io.to(targetSocketId).emit('notification', { type: 'info', message: `🔔 وصلك طلب صداقة جديد من اللاعب [ ${sender.name} ]` });
        }
    });

    // 4. قبول طلب الصداقة
    socket.on('acceptFriend', (targetSocketId) => {
        let me = onlineUsers[socket.id];
        let friend = onlineUsers[targetSocketId];

        if (!me || !friend) return;

        if (me.friends.length >= 50 || friend.friends.length >= 50) {
            socket.emit('notification', { type: 'error', message: '❌ تعذر القبول لتخطي الحد الأقصى (50 صديق).' });
            return;
        }

        me.friendRequests = me.friendRequests.filter(r => r.id !== targetSocketId);

        if (!me.friends.some(f => f.id === targetSocketId)) {
            me.friends.push({ id: targetSocketId, name: friend.name, avatar: friend.avatar });
        }
        if (!friend.friends.some(f => f.id === socket.id)) {
            friend.friends.push({ id: socket.id, name: me.name, avatar: me.avatar });
        }

        socket.emit('updateProfile', me);
        io.to(targetSocketId).emit('updateProfile', friend);
        io.emit('globalUserList', Object.values(onlineUsers));

        socket.emit('notification', { type: 'success', message: `🎉 تم قبول الطلب وأصبح ${friend.name} صديقك الآن!` });
        io.to(targetSocketId).emit('notification', { type: 'success', message: `🎉 قبل ${me.name} طلب الصداقة الخاص بك!` });
    });

    // 5. رفض طلب الصداقة
    socket.on('rejectFriend', (targetSocketId) => {
        let me = onlineUsers[socket.id];
        if (me) {
            me.friendRequests = me.friendRequests.filter(r => r.id !== targetSocketId);
            socket.emit('updateProfile', me);
        }
    });

    // 6. حذف صديق
    socket.on('removeFriendOnServer', (friendId) => {
        let me = onlineUsers[socket.id];
        let friend = onlineUsers[friendId];

        if (me) {
            me.friends = me.friends.filter(f => f.id !== friendId);
            socket.emit('updateProfile', me);
        }
        if (friend) {
            friend.friends = friend.friends.filter(f => f.id !== socket.id);
            io.to(friendId).emit('updateProfile', friend);
        }
        io.emit('globalUserList', Object.values(onlineUsers));
        socket.emit('notification', { type: 'info', message: '🗑️ تم إزالة الصديق بنجاح من قائمتك.' });
    });

    // 7. جلب شات الأصدقاء المستمر (آخر 12 ساعة)
    socket.on('getPrivateChatHistory', (friendId) => {
        let history = privateChats.filter(msg => 
            (msg.fromId === socket.id && msg.toId === friendId) || 
            (msg.fromId === friendId && msg.toId === socket.id)
        );
        socket.emit('receivePrivateHistory', history);
    });

    socket.on('sendPrivateMessage', (data) => {
        let sender = onlineUsers[socket.id];
        if (!sender) return;

        let msgObj = {
            fromId: socket.id,
            toId: data.toId,
            senderName: sender.name,
            message: data.message,
            timestamp: Date.now()
        };

        privateChats.push(msgObj);
        io.to(data.toId).emit('receivePrivateMessage', msgObj);
        socket.emit('receivePrivateMessage', msgObj);
    });

    // 8. نظام الروم واللعب التنافسي X-O
    socket.on('searchUsers', () => {
        socket.emit('userListUpdate', Object.values(onlineUsers));
    });

    socket.on('inviteFriendToRoom', (data) => {
        let sender = onlineUsers[socket.id];
        if (sender) {
            io.to(data.friendId).emit('roomInviteReceived', { roomCode: data.roomCode, hostName: sender.name });
        }
    });

    socket.on('joinRandom', () => {
        let availableRoom = Object.keys(rooms).find(code => rooms[code].players.length === 1 && !rooms[code].isCustom);
        let roomCode = availableRoom || Math.floor(1000 + Math.random() * 9000).toString();
        handleRoomJoin(socket, roomCode, false);
    });

    socket.on('joinRoom', (roomCode) => {
        handleRoomJoin(socket, roomCode, true);
    });

    function handleRoomJoin(socket, roomCode, isCustom) {
        if (!rooms[roomCode]) {
            rooms[roomCode] = { players: [], board: Array(9).fill(""), turn: 0, timer: null, timeLeft: 120, isCustom: isCustom };
        }

        let room = rooms[roomCode];
        if (room.players.length >= 2) {
            socket.emit('notification', { type: 'error', message: '🚫 هذه الغرفة ممتلئة باللاعبين!' });
            return;
        }

        room.players.push(socket.id);
        socket.join(roomCode);

        if (room.players.length === 1) {
            socket.emit('waiting', `⏳ بانتظار دخول الخصم...`);
        } else if (room.players.length === 2) {
            let p1 = onlineUsers[room.players[0]] || { name: "لاعب 1" };
            let p2 = onlineUsers[room.players[1]] || { name: "لاعب 2" };

            io.to(room.players[0]).emit('gameStart', { room: roomCode, symbol: 'X', opponent: p2 });
            io.to(room.players[1]).emit('gameStart', { room: roomCode, symbol: 'O', opponent: p1 });
            startRoomTimer(roomCode);
        }
    }

    socket.on('makeMove', (data) => {
        let room = rooms[data.room];
        if (!room) return;
        room.board[data.index] = data.symbol;
        let nextSymbol = data.symbol === 'X' ? 'O' : 'X';
        io.to(data.room).emit('moveMade', { index: data.index, symbol: data.symbol, nextTurnSymbol: nextSymbol });
    });

    socket.on('sendChatMessage', (data) => {
        let user = onlineUsers[socket.id];
        if (user) {
            io.to(data.room).emit('receiveChatMessage', { sender: user.name, message: data.message });
        }
    });

    socket.on('gameEndResult', (data) => {
        let room = rooms[data.room];
        if (room) {
            clearInterval(room.timer);
            let user = onlineUsers[socket.id];
            if (user) {
                if (data.result === 'فوز') { user.gold += 100; user.history.push('فوز'); }
                else if (data.result === 'خسارة') { user.history.push('خسارة'); }
                else { user.history.push('تعادل'); }
                socket.emit('updateProfile', user);
            }
        }
    });

    socket.on('restartGame', (roomCode) => {
        let room = rooms[roomCode];
        if (room) {
            room.board = Array(9).fill("");
            clearInterval(room.timer);
            room.timeLeft = 120;
            io.to(roomCode).emit('restart');
            startRoomTimer(roomCode);
        }
    });

    socket.on('leaveRoom', () => { disconnectFromRoom(socket); });
    socket.on('disconnect', () => {
        disconnectFromRoom(socket);
        delete onlineUsers[socket.id];
        io.emit('globalUserList', Object.values(onlineUsers));
    });

    function disconnectFromRoom(socket) {
        Object.keys(rooms).forEach(code => {
            let room = rooms[code];
            if (room.players.includes(socket.id)) {
                clearInterval(room.timer);
                socket.leave(code);
                io.to(code).emit('opponentDisconnected');
                delete rooms[code];
            }
        });
    }

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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 السيرفر المتطور جاهز بالكامل على البورت: ${PORT}`);
});