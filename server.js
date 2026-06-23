const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server);

app.use(express.static(__dirname));

let onlineUsers = {}; // socket.id -> userData
let rooms = {};       // roomCode -> roomData
let privateChats = {}; 

function calculateRank(score) {
    if (score <= 0) return "بدون رتبة";
    let title = ""; let min = 0, max = 100;
    if (score >= 1 && score <= 100) { title = "برونز"; min = 1; max = 100; }
    else if (score <= 300) { title = "فضة"; min = 101; max = 300; }
    else if (score <= 500) { title = "ذهب"; min = 301; max = 500; }
    else if (score <= 700) { title = "بلاتين"; min = 501; max = 700; }
    else if (score <= 1000) { title = "ألماس"; min = 701; max = 1000; }
    else if (score <= 1500) { title = "هيرو"; min = 1001; max = 1500; }
    else if (score <= 3000) { title = "قراند ماستر"; min = 1501; max = 3000; }
    else { return "🏆 الأسطورة"; }
    let range = (max - min + 1) / 3;
    let currentOffset = score - min;
    let subRank = 3 - Math.floor(currentOffset / range);
    return `${title} ${Math.max(1, Math.min(3, subRank))}`;
}

setInterval(() => { privateChats = {}; }, 12 * 60 * 60 * 1000);

io.on('connection', (socket) => {

    socket.on('registerUser', (userData) => {
        let userId = userData.userId || Math.floor(10000000 + Math.random() * 90000000).toString();
        onlineUsers[socket.id] = {
            id: socket.id, userId: userId, name: userData.name || "لاعب مجهول",
            avatar: userData.avatar || '🥷', bio: userData.bio || 'جاهز للتحدي!',
            gold: userData.gold ?? 1000, diamonds: userData.diamonds ?? 150,
            score: userData.score ?? 10, friends: userData.friends || [],
            friendRequests: userData.friendRequests || [], history: userData.history || [],
            inventory: userData.inventory || [] // قائمة المشتريات بالخزنة
        };
        onlineUsers[socket.id].rank = calculateRank(onlineUsers[socket.id].score);
        socket.emit('updateProfile', onlineUsers[socket.id]);
        sendGlobalUpdates();
    });

    function sendGlobalUpdates() {
        let usersArray = Object.values(onlineUsers);
        io.emit('globalUserList', usersArray);
        let top100 = [...usersArray].sort((a, b) => b.score - a.score).slice(0, 100);
        io.emit('leaderboardUpdate', top100);
    }

    socket.on('searchUsers', () => { sendGlobalUpdates(); });

    // شراء باقات الألماس بواسطة الذهب
    socket.on('buyDiamonds', (packType) => {
        let user = onlineUsers[socket.id]; if (!user) return;
        let cost = 0; let reward = 0;
        if (packType === 100) { cost = 1500; reward = 100; }
        else if (packType === 500) { cost = 8000; reward = 500; }
        else if (packType === 1000) { cost = 17000; reward = 1000; }

        if (user.gold >= cost) {
            user.gold -= cost; user.diamonds += reward;
            socket.emit('updateProfile', user);
            socket.emit('notification', { type: 'success', message: `🎉 تم شراء ${reward} ألماس بنجاح!` });
            sendGlobalUpdates();
        } else {
            socket.emit('notification', { type: 'error', message: '⚠️ الذهب غير كافٍ لإتمام عملية الشراء!' });
        }
    });

    // شراء عناصر المتجر (المظاهر والألوان) بواسطة الألماس
    socket.on('buyShopItem', (item) => {
        let user = onlineUsers[socket.id]; if (!user) return;
        if (user.inventory.includes(item.id)) {
            return socket.emit('notification', { type: 'error', message: '🚫 أنت تمتلك هذا العنصر بالفعل!' });
        }
        if (user.diamonds >= item.cost) {
            user.diamonds -= item.cost;
            user.inventory.push(item.id); // إضافة المعرف إلى الخزنة
            socket.emit('updateProfile', user);
            socket.emit('notification', { type: 'success', message: `🛍️ تم شراء [${item.name}] بنجاح ونقله إلى خزنتك!` });
            sendGlobalUpdates();
        } else {
            socket.emit('notification', { type: 'error', message: '⚠️ الألماس لديك غير كافٍ لشراء هذا المظهر!' });
        }
    });

    socket.on('joinCustomRoomDirect', (roomCode) => {
        if (!rooms[roomCode]) {
            rooms[roomCode] = { players: [], board: Array(9).fill(""), turn: 0, timer: null, timeLeft: 120, isCustom: true, customStyles: {} };
        }
        let room = rooms[roomCode];
        if (room.players.length < 2 && !room.players.includes(socket.id)) {
            room.players.push(socket.id); socket.join(roomCode);
        }
        if (room.players.length === 2) { startRoomTimer(roomCode); } 
        else { socket.emit('waiting', `⏳ دخلت الروم المخصصة [${roomCode}]. بانتظار الخصم يدخل بنفس الكود...`); }
    });

    socket.on('inviteFriendToRoom', (data) => {
        let sender = onlineUsers[socket.id]; if (!sender) return;
        let targetSocketId = Object.keys(onlineUsers).find(sid => onlineUsers[sid].userId === data.friendUserId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('roomInviteReceived', { roomCode: data.roomCode, hostName: sender.name, hostSocketId: socket.id });
            socket.emit('notification', { type: 'success', message: '🚀 تم إرسال إشعار الدعوة لصديقك بنجاح!' });
        }
    });

    socket.on('rejectRoomInvite', (data) => {
        let hostSocket = io.sockets.sockets.get(data.hostSocketId);
        if (hostSocket) hostSocket.emit('notification', { type: 'info', message: '❌ رفض صديقك طلب دعوة الانضمام للغرفة.' });
    });

    socket.on('acceptRoomInviteAndStart', (data) => {
        let guestSocket = socket; let hostSocket = io.sockets.sockets.get(data.hostSocketId); let roomCode = data.roomCode;
        if (!rooms[roomCode]) rooms[roomCode] = { players: [], board: Array(9).fill(""), turn: 0, timer: null, timeLeft: 120, isCustom: true, customStyles: {} };
        if (!rooms[roomCode].players.includes(data.hostSocketId) && hostSocket) { rooms[roomCode].players.push(data.hostSocketId); hostSocket.join(roomCode); }
        if (!rooms[roomCode].players.includes(guestSocket.id)) { rooms[roomCode].players.push(guestSocket.id); guestSocket.join(roomCode); }
        startRoomTimer(roomCode);
    });

    socket.on('joinRandom', () => {
        let availableRoom = Object.keys(rooms).find(code => rooms[code].players.length === 1 && !rooms[code].isCustom);
        let roomCode = availableRoom || Math.floor(1000 + Math.random() * 9000).toString();
        if (!rooms[roomCode]) rooms[roomCode] = { players: [], board: Array(9).fill(""), turn: 0, timer: null, timeLeft: 120, isCustom: false, customStyles: {} };
        let room = rooms[roomCode]; room.players.push(socket.id); socket.join(roomCode);
        if (room.players.length === 1) socket.emit('waiting', `⏳ بانتظار دخول الخصم في النمط التنافسي...`);
        else if (room.players.length === 2) startRoomTimer(roomCode);
    });

    socket.on('cancelMatchmaking', () => {
        Object.keys(rooms).forEach(roomCode => {
            let room = rooms[roomCode];
            if (!room.isCustom && room.players.includes(socket.id)) {
                room.players = room.players.filter(id => id !== socket.id); socket.leave(roomCode);
                if (room.players.length === 0) delete rooms[roomCode];
            }
        });
    });

    function startRoomTimer(roomCode) {
        let room = rooms[roomCode]; if (!room) return;
        clearInterval(room.timer); room.timeLeft = 120;
        let p1 = onlineUsers[room.players[0]] || { name: "لاعب 1" }; let p2 = onlineUsers[room.players[1]] || { name: "لاعب 2" };
        io.to(room.players[0]).emit('gameStart', { room: roomCode, symbol: 'X', opponent: p2, isCustom: room.isCustom });
        io.to(room.players[1]).emit('gameStart', { room: roomCode, symbol: 'O', opponent: p1, isCustom: room.isCustom });

        room.timer = setInterval(() => {
            room.timeLeft--; io.to(roomCode).emit('timerUpdate', room.timeLeft);
            if (room.timeLeft <= 0) { clearInterval(room.timer); io.to(roomCode).emit('gameNotification', '⏱️ انتهى وقت المباراة!'); }
        }, 1000);
    }

    socket.on('makeMove', (data) => {
        let room = rooms[data.room]; if (!room) return;
        room.board[data.index] = data.symbol;
        let nextSymbol = data.symbol === 'X' ? 'O' : 'X';
        // تمرير الـ activeStyles الخاص باللاعب الذي لعب لتحديث الشكل والمظهر عند الخصم فوراً
        io.to(data.room).emit('moveMade', { index: data.index, symbol: data.symbol, nextTurnSymbol: nextSymbol, styles: data.styles });
    });

    socket.on('syncBackgroundStyle', (data) => {
        // لمزامنة مظهر الخلفية مع الخصم داخل الجيم
        socket.to(data.room).emit('opponentBackgroundSynced', { bgStyle: data.bgStyle });
    });

    socket.on('playerResigned', (data) => {
        let room = rooms[data.room]; if (!room) return;
        clearInterval(room.timer);
        let loserId = socket.id; let winnerId = room.players.find(id => id !== loserId);
        let loserUser = onlineUsers[loserId]; let winnerUser = onlineUsers[winnerId];

        if (!room.isCustom) {
            if (loserUser) {
                loserUser.score = Math.max(0, loserUser.score - (loserUser.score <= 300 ? 5 : 15));
                loserUser.gold = Math.max(0, loserUser.gold - 5); loserUser.rank = calculateRank(loserUser.score);
                loserUser.history.unshift("خسارة"); if(loserUser.history.length > 5) loserUser.history.pop();
                io.to(loserId).emit('updateProfile', loserUser);
            }
            if (winnerUser) {
                winnerUser.score += (winnerUser.score <= 300 ? 25 : 10); winnerUser.gold += 50; winnerUser.rank = calculateRank(winnerUser.score);
                winnerUser.history.unshift("فوز"); if(winnerUser.history.length > 5) winnerUser.history.pop();
                io.to(winnerId).emit('updateProfile', winnerUser);
            }
        }
        if (winnerId) io.to(winnerId).emit('opponentResignedResult', { message: "🎉 فزت بالمباراة بسبب انسحاب الخصم!" });
        delete rooms[data.room]; sendGlobalUpdates();
    });

    socket.on('gameEndResult', (data) => {
        let room = rooms[data.room]; let user = onlineUsers[socket.id]; if (!room || !user) return;
        clearInterval(room.timer);
        user.history.unshift(data.result); if (user.history.length > 5) user.history.pop();
        if (!room.isCustom) {
            if (data.result === 'فوز') { user.gold += 50; if (user.score <= 300) user.score += 25; else user.score += 10; }
            else if (data.result === 'خسارة') { user.gold = Math.max(0, user.gold - 5); if (user.score <= 300) user.score = Math.max(0, user.score - 5); else user.score = Math.max(0, user.score - 15); }
            user.rank = calculateRank(user.score);
        }
        socket.emit('updateProfile', user); sendGlobalUpdates();
    });

    socket.on('sendFriendRequest', (targetUserId) => {
        let sender = onlineUsers[socket.id]; let targetSocketId = Object.keys(onlineUsers).find(sid => onlineUsers[sid].userId === targetUserId);
        if (!sender || !targetSocketId) return; let receiver = onlineUsers[targetSocketId];
        if ((receiver.friends || []).length >= 50) return socket.emit('notification', { type: 'error', message: '🚫 عذراً! هذا اللاعب وصل للحد الأقصى من الأصدقاء (50).' });
        if (!receiver.friendRequests.some(r => r.userId === sender.userId)) {
            receiver.friendRequests.push({ userId: sender.userId, name: sender.name, avatar: sender.avatar });
            io.to(targetSocketId).emit('updateProfile', receiver); socket.emit('notification', { type: 'success', message: '🚀 تم إرسال طلب الصداقة بنجاح!' });
        }
    });

    socket.on('rejectFriendRequest', (targetUserId) => {
        let me = onlineUsers[socket.id]; if (!me) return;
        me.friendRequests = me.friendRequests.filter(r => r.userId !== targetUserId); socket.emit('updateProfile', me);
        let targetSocketId = Object.keys(onlineUsers).find(sid => onlineUsers[sid].userId === targetUserId);
        if (targetSocketId) io.to(targetSocketId).emit('friendRequestRejectedNotification', { myUserId: me.userId });
    });

    socket.on('acceptFriend', (targetUserId) => {
        let me = onlineUsers[socket.id]; let targetSocketId = Object.keys(onlineUsers).find(sid => onlineUsers[sid].userId === targetUserId);
        if (!me || !targetSocketId) return; let friend = onlineUsers[targetSocketId];
        if ((me.friends || []).length >= 50) return socket.emit('notification', { type: 'error', message: '🚫 لديك 50 صديقاً بالفعل!' });
        me.friendRequests = me.friendRequests.filter(r => r.userId !== targetUserId);
        if (!me.friends.some(f => f.userId === targetUserId)) me.friends.push({ userId: targetUserId, name: friend.name, avatar: friend.avatar });
        if (!friend.friends.some(f => f.userId === me.userId) && (friend.friends || []).length < 50) friend.friends.push({ userId: me.userId, name: me.name, avatar: me.avatar });
        socket.emit('updateProfile', me); io.to(targetSocketId).emit('updateProfile', friend);
    });

    socket.on('removeFriend', (targetUserId) => {
        let me = onlineUsers[socket.id]; let targetSocketId = Object.keys(onlineUsers).find(sid => onlineUsers[sid].userId === targetUserId);
        if (me) { me.friends = me.friends.filter(f => f.userId !== targetUserId); socket.emit('updateProfile', me); }
        if (targetSocketId) { let friend = onlineUsers[targetSocketId]; friend.friends = friend.friends.filter(f => f.userId !== me.userId); io.to(targetSocketId).emit('updateProfile', friend); }
    });

    socket.on('sendChatMessage', (data) => { let user = onlineUsers[socket.id]; if (user) io.to(data.room).emit('receiveChatMessage', { sender: user.name, message: data.message }); });
    socket.on('getPrivateMessages', (data) => { let chatKey = [data.myId, data.friendId].sort().join('_'); socket.emit('privateMessagesList', privateChats[chatKey] || []); });
    socket.on('sendPrivateMessage', (data) => {
        let chatKey = [data.myId, data.friendId].sort().join('_'); if (!privateChats[chatKey]) privateChats[chatKey] = [];
        let msgObj = { senderName: data.senderName, message: data.message, time: new Date().toLocaleTimeString('ar-EG', {hour: '2-digit', minute:'2-digit'}) };
        privateChats[chatKey].push(msgObj);
        let targetSocketId = Object.keys(onlineUsers).find(sid => onlineUsers[sid].userId === data.friendId);
        socket.emit('privateMessagesList', privateChats[chatKey]); if (targetSocketId) io.to(targetSocketId).emit('privateMessagesList', privateChats[chatKey]);
    });

    socket.on('disconnect', () => { 
        Object.keys(rooms).forEach(roomCode => {
            if (rooms[roomCode].players.includes(socket.id)) {
                rooms[roomCode].players = rooms[roomCode].players.filter(id => id !== socket.id);
                if (rooms[roomCode].players.length === 0) delete rooms[roomCode];
            }
        });
        delete onlineUsers[socket.id]; sendGlobalUpdates(); 
    });
});

server.listen(3000, () => console.log(`🚀 السيرفر يعمل على بورت 3000`));