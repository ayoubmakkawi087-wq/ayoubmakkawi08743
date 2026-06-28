const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

const topics = {
    "سيارات": ["تويوتا", "مرسيدس", "بي إم دبليو", "فورد", "فراري", "لكزس", "نيسان", "هيونداي", "كيا", "أودي", "بوش", "شيفورليه", "تسلا", "دوج", "جيب", "هوندا", "مازدا", "رينو"],
    "ملابس": ["قميص", "فستان", "معطف", "بذلة", "حذاء", "وشاح", "بنطال", "تنورة", "قبعة", "سترة", "عباءة", "قماش", "جورب", "قفازات", "ربطة عنق"],
    "أكل": ["بيتزا", "برجر", "كبسة", "شاورما", "باستا", "سوشي", "فلافل", "منسف", "كباب", "سمك", "دجاج", "ملوخية", "محشي", "أرز", "تاكو", "ستيك"],
    "حيوانات": ["أسد", "فيل", "نمر", "غزال", "صقر", "حصان", "كلب", "قطة", "ثعلب", "ذئب", "دب", "زرافة", "قرد", "سنجاب", "أرنب", "تمساح", "ثعبان"],
    "دول": ["الأردن", "السعودية", "مصر", "الإمارات", "الكويت", "قطر", "البحرين", "عمان", "العراق", "المغرب", "تونس", "فلسطين", "لبنان", "سوريا", "الأميركا"],
    "فواكه": ["تفاح", "موز", "برتقال", "فراولة", "مانجو", "بطيخ", "عنب", "كيوي", "أناناس", "خوخ", "مشمش", "كرز", "رمان", "تين", "ليمون"]
};

let rooms = {};

io.on('connection', (socket) => {
    socket.emit('availableRooms', getPublicRooms());

    socket.on('createRoom', ({ username, roomName, password, maxPlayers, spiesCount, topic, gameDuration }) => {
        let maxP = Math.min(Math.max(parseInt(maxPlayers) || 3, 3), 20);
        let spies = Math.min(Math.max(parseInt(spiesCount) || 1, 1), 3);
        let duration = parseInt(gameDuration) || 30; // القيمة الافتراضية 30 ثانية لتطابق طلبك

        const roomId = 'room_' + Math.random().toString(36).substr(2, 9);
        rooms[roomId] = {
            id: roomId, name: roomName, password: password || null,
            maxPlayers: maxP, spiesCount: spies, topic: topic, hostId: socket.id,
            players: [{ id: socket.id, name: username, isAlive: true, role: '', word: '', votedFor: null, hasSpoken: false }],
            gameStarted: false, currentTurnIndex: 0, timer: duration, baseDuration: duration, phase: 'setup', correctWord: ''
        };

        socket.join(roomId);
        socket.emit('roomJoined', rooms[roomId]);
        io.emit('availableRooms', getPublicRooms());
    });

    socket.on('joinRoom', ({ username, roomId, password }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMsg', 'الغرفة غير موجودة');
        if (room.gameStarted) return socket.emit('errorMsg', 'اللعبة بدأت بالفعل');
        if (room.players.length >= room.maxPlayers) return socket.emit('errorMsg', 'الروم ممتلئ');
        if (room.password && room.password !== password) return socket.emit('errorMsg', 'كلمة السر خطأ');

        room.players.push({ id: socket.id, name: username, isAlive: true, role: '', word: '', votedFor: null, hasSpoken: false });
        socket.join(roomId);
        
        socket.emit('roomJoined', room);
        io.to(roomId).emit('roomUpdated', room);
        io.emit('availableRooms', getPublicRooms());
    });

    socket.on('startRoomGame', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id || room.players.length < 3) return;

        room.gameStarted = true;
        room.phase = 'talking';
        const wordList = topics[room.topic];
        const randomWord = wordList[Math.floor(Math.random() * wordList.length)];
        room.correctWord = randomWord; // حفظ الكلمة الصحيحة للتحقق لاحقاً

        let indices = [...Array(room.players.length).keys()];
        let spyIndices = [];
        for (let i = 0; i < room.spiesCount; i++) {
            if (indices.length === 0) break;
            spyIndices.push(indices.splice(Math.floor(Math.random() * indices.length), 1)[0]);
        }

        room.players.forEach((p, idx) => {
            p.isAlive = true;
            p.votedFor = null;
            p.hasSpoken = false;
            p.role = spyIndices.includes(idx) ? 'spy' : 'player';
            p.word = p.role === 'spy' ? 'أنت برا السالفة! حاول تكتشف الكلمة' : randomWord;
        });

        io.to(roomId).emit('gameStarted', room);
        room.currentTurnIndex = 0;
        startNextTurn(roomId);
    });

    socket.on('nextTurn', (roomId) => {
        const room = rooms[roomId];
        if (!room || !room.gameStarted || room.phase !== 'talking') return;
        
        if (room.players[room.currentTurnIndex].id === socket.id) {
            room.players[room.currentTurnIndex].hasSpoken = true;
            moveToNextPlayer(roomId);
        }
    });

    socket.on('sendChatMessage', ({ roomId, message }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        io.to(roomId).emit('newChatMessage', { sender: player ? player.name : 'مشاهد', text: message });
    });

    socket.on('castVote', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || room.phase !== 'voting') return;

        const voter = room.players.find(p => p.id === socket.id);
        if (!voter || !voter.isAlive || voter.id === targetId) return; // منع التصويت على النفس قطعياً

        voter.votedFor = targetId;
        io.to(roomId).emit('voteUpdated', room.players);

        const alivePlayers = room.players.filter(p => p.isAlive);
        const totalVotesCast = alivePlayers.filter(p => p.votedFor !== null).length;

        if (totalVotesCast === alivePlayers.length) {
            processVotingResult(roomId);
        }
    });

    // معالجة تخمين برا السالفة (الـ 10 خيارات)
    socket.on('submitSpyGuess', ({ roomId, guess }) => {
        const room = rooms[roomId];
        if (!room || room.phase !== 'spy_guessing') return;

        if (guess === room.correctWord) {
            io.to(roomId).emit('gameOver', { winner: 'spies', message: `🔥 عبقري! "برا السالفة" حزر الكلمة الصحيحة وهي [ ${room.correctWord} ] وفاز بالجيم بالكامل وكبّس على الطاولة! 😈` });
        } else {
            io.to(roomId).emit('gameOver', { winner: 'players', message: `🎉 كفو! "برا السالفة" خمن غلط واختار [ ${guess} ] بينما الكلمة الصح كانت [ ${room.correctWord} ]! الطاولة هي الفائزة والانتصار ساحق!` });
        }
        terminateRoom(roomId);
    });

    socket.on('leaveRoom', (roomId) => { handleLeave(socket, roomId); });
    socket.on('disconnect', () => {
        for (const rId in rooms) {
            if (rooms[rId].players.some(p => p.id === socket.id)) { handleLeave(socket, rId); break; }
        }
    });
});

function startNextTurn(roomId) {
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;

    if (room.interval) { clearInterval(room.interval); room.interval = null; } // تصفير الموقت القديم تماماً لمنع العجقة

    // ضبط الوقت حسب الطور الحالي: إذا كان تصويت يكون 30 ثانية، وإذا كلام يلتزم باختيار الغرفة
    room.timer = (room.phase === 'voting') ? 30 : room.baseDuration;
    
    io.to(roomId).emit('turnUpdate', { currentTurnIndex: room.currentTurnIndex, activePlayerId: room.players[room.currentTurnIndex].id, phase: room.phase });
    io.to(roomId).emit('timerTick', room.timer);

    room.interval = setInterval(() => {
        if (!rooms[roomId] || !rooms[roomId].gameStarted) { clearInterval(room.interval); return; }
        rooms[roomId].timer--;
        io.to(roomId).emit('timerTick', rooms[roomId].timer);

        if (rooms[roomId].timer <= 0) {
            clearInterval(room.interval);
            if (rooms[roomId].phase === 'talking') {
                rooms[roomId].players[rooms[roomId].currentTurnIndex].hasSpoken = true;
                moveToNextPlayer(roomId);
            } else if (rooms[roomId].phase === 'voting') {
                processVotingResult(roomId);
            }
        }
    }, 1000);
}

function moveToNextPlayer(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    let found = false;
    for (let i = 0; i < room.players.length; i++) {
        let idx = (room.currentTurnIndex + 1 + i) % room.players.length;
        if (room.players[idx].isAlive && !room.players[idx].hasSpoken) {
            room.currentTurnIndex = idx;
            found = true;
            break;
        }
    }

    if (found) {
        startNextTurn(roomId);
    } else {
        room.phase = 'voting';
        startNextTurn(roomId);
        io.to(roomId).emit('phaseChanged', { phase: 'voting' });
    }
}

function processVotingResult(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    if (room.interval) clearInterval(room.interval);

    let voteCounts = {};
    room.players.forEach(p => { if(p.isAlive) voteCounts[p.id] = 0; });
    room.players.forEach(p => {
        if (p.isAlive && p.votedFor && voteCounts[p.votedFor] !== undefined) {
            voteCounts[p.votedFor]++;
        }
    });

    let maxVotes = -1, eliminatedId = null, tie = false;
    for (const pId in voteCounts) {
        if (voteCounts[pId] > maxVotes) {
            maxVotes = voteCounts[pId]; eliminatedId = pId; tie = false;
        } else if (voteCounts[pId] === maxVotes) {
            tie = true;
        }
    }

    let eliminatedPlayer = room.players.find(p => p.id === eliminatedId);
    
    if (eliminatedPlayer && !tie && maxVotes > 0) {
        eliminatedPlayer.isAlive = false;
        io.to(roomId).emit('playerEliminated', { id: eliminatedPlayer.id, name: eliminatedPlayer.name, role: eliminatedPlayer.role });

        // القاعدة الذهبية الجديدة: إذا تم إقصاء "برا السالفة" نفتح له الـ 10 خيارات للتخمين فوراً واحتساب فوزه أو خسارته
        if (eliminatedPlayer.role === 'spy') {
            room.phase = 'spy_guessing';
            
            // توليد 10 خيارات عشوائية ممتازة ومضمونة تشمل الكلمة الصحيحة
            let pool = [...topics[room.topic]];
            pool = pool.filter(w => w !== room.correctWord);
            // خلط عشوائي وأخذ 9 كلمات
            pool.sort(() => 0.5 - Math.random());
            let options = pool.slice(0, 9);
            options.push(room.correctWord);
            // إعادة خلط الـ 10 خيارات لكي لا تكون الكلمة الصحيحة في النهاية دائماً
            options.sort(() => 0.5 - Math.random());

            io.to(roomId).emit('spyMustGuess', {
                spyId: eliminatedPlayer.id,
                spyName: eliminatedPlayer.name,
                options: options
            });
            return; // إيقاف الانتقال للجولة التالية لأن اللعبة تنتظر التخمين الآن
        }
    } else {
        io.to(roomId).emit('playerEliminated', { id: null, name: 'لا أحد (تعادل بالأصوات أو انتهى الوقت بدون تصويت كامل)', role: '' });
    }

    // التحقق من استمرار الجيم في حال تم طرد لاعب عادي
    const aliveSpies = room.players.filter(p => p.isAlive && p.role === 'spy').length;
    const alivePlayers = room.players.filter(p => p.isAlive && p.role === 'player').length;

    if (aliveSpies === 0) {
        io.to(roomId).emit('gameOver', { winner: 'players', message: 'كفو! تم طرد جميع من هم برا السالفة بنجاح! 🎉' });
        terminateRoom(roomId);
    } else if (alivePlayers <= aliveSpies) {
        io.to(roomId).emit('gameOver', { winner: 'spies', message: 'خسارة! نجح من هم برا السالفة في خداعكم والسيطرة والمساواة! 😈' });
        terminateRoom(roomId);
    } else {
        // العودة لطور الكلام وجولة جديدة
        room.phase = 'talking';
        room.players.forEach(p => { p.votedFor = null; p.hasSpoken = false; });
        room.currentTurnIndex = room.players.findIndex(p => p.isAlive);
        startNextTurn(roomId);
    }
}

function terminateRoom(roomId) {
    if (rooms[roomId]) {
        if (rooms[roomId].interval) clearInterval(rooms[roomId].interval);
        delete rooms[roomId];
        io.emit('availableRooms', getPublicRooms());
    }
}

function getPublicRooms() {
    return Object.values(rooms).map(r => ({ id: r.id, name: r.name, hasPassword: !!r.password, currentPlayers: r.players.length, maxPlayers: r.maxPlayers, gameStarted: r.gameStarted, topic: r.topic }));
}

function handleLeave(socket, roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(roomId);
    
    if (room.players.length === 0 || room.hostId === socket.id) {
        if (room.interval) clearInterval(room.interval);
        io.to(roomId).emit('kickToLobby');
        delete rooms[roomId];
    } else {
        io.to(roomId).emit('roomUpdated', room);
    }
    io.emit('availableRooms', getPublicRooms());
}

app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send("User-agent: *\nAllow: /");
});

// التعديل الجديد للتوافق مع سيرفرات Render
const PORT = process.env.PORT || 3000;

http.listen(PORT, () => {
    console.log(`السيرفر جاهز تماماً ويعمل على بورت: ${PORT}`);
});