const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const Papa = require('papaparse');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const sheetId = '1kgrMq9o4imKj_BG-uMN1__sPrYot5KqLLQUknFyqFBY';
const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv`;
let questions = [];

let gameState = {
    currentQuestionIndex: 0,
    phase: 'setup', 
    teams: {},
    question: null,
    logs: [],
    combatQueue: [], 
    currentCombatEvent: null,
    punishQueue: [], 
    currentPunishTeam: null,
    punishmentPot: 1, 
    isLastPunish: false,
    timeLeft: 40,
    endGameRanks: []
};

let timerInterval = null;

async function loadQuestions() {
    try {
        const response = await axios.get(csvUrl);
        Papa.parse(response.data, {
            header: true,
            complete: (results) => {
                // 強制只取前 10 題
                questions = results.data.slice(0, 10);
                updateQuestion();
                console.log(`✅ 題庫同步成功！共載入 ${questions.length} 題`);
            }
        });
    } catch (e) { console.error("題庫讀取失敗", e); }
}
loadQuestions();

function updateQuestion() {
    if(questions[gameState.currentQuestionIndex]) {
        gameState.question = questions[gameState.currentQuestionIndex];
    }
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function startTimer() {
    clearInterval(timerInterval);
    gameState.timeLeft = 40; 
    io.emit('state_update', gameState);

    timerInterval = setInterval(() => {
        gameState.timeLeft--;
        let someoneLocked = false;
        
        // 檢查個別部落的 Debuff 提前鎖定
        Object.values(gameState.teams).forEach(t => {
            if (!t.locked && t.timePenalty > 0 && gameState.timeLeft <= t.timePenalty) {
                t.locked = true;
                t.action = 'defend'; 
                t.answer = null;
                t.isCorrect = false; 
                someoneLocked = true;
            }
        });

        if(gameState.timeLeft <= 0) {
            clearInterval(timerInterval);
            forceLockAll();
            io.emit('state_update', gameState);
        } else {
            io.emit('timer_update', gameState.timeLeft);
            if(someoneLocked) io.emit('state_update', gameState);
        }
    }, 1000);
}

function forceLockAll() {
    Object.values(gameState.teams).forEach(t => {
        if(!t.locked) {
            t.locked = true; t.action = 'defend'; t.answer = null; t.isCorrect = false; 
        }
    });
}

io.on('connection', (socket) => {
    socket.emit('state_update', gameState);

    socket.on('reset_game', () => {
        clearInterval(timerInterval);
        gameState.currentQuestionIndex = 0;
        gameState.phase = 'setup';
        gameState.teams = {};
        gameState.logs = [];
        updateQuestion();
        io.emit('state_update', gameState);
    });

    socket.on('teacher_setup', (count) => {
        gameState.phase = 'lobby';
        gameState.teams = {};
        gameState.currentQuestionIndex = 0;
        const names = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
        for(let i=1; i<=count; i++) {
            let id = `team${i}`;
            gameState.teams[id] = { 
                id, name: `${names[i-1] || i}號部落`, hp: 10, 
                connected: false, locked: false, action: null, target: null, 
                answer: null, isCorrect: false, combatAnim: null, magicCard: null, timePenalty: 0 
            };
        }
        io.emit('state_update', gameState);
    });

    socket.on('claim_team', (teamId) => {
        if (gameState.teams[teamId] && !gameState.teams[teamId].connected) {
            gameState.teams[teamId].connected = true;
            socket.emit('claim_success', {teamId, name: gameState.teams[teamId].name});
            io.emit('state_update', gameState);
        }
    });

    socket.on('force_disconnect', (teamId) => {
        if(gameState.teams[teamId]) {
            gameState.teams[teamId].connected = false;
            io.emit('state_update', gameState);
        }
    });

    socket.on('teacher_start', () => {
        gameState.phase = 'answering';
        gameState.logs = [];
        startTimer();
    });

    socket.on('submit_turn', (data) => {
        if(gameState.timeLeft <= 0) return; 
        const team = gameState.teams[data.teamId];
        if(!team) return;
        team.locked = true;
        team.action = data.action;
        team.target = data.target;
        team.answer = data.answer;
        team.isCorrect = (data.answer === gameState.question['正確答案']);
        io.emit('state_update', gameState);
    });

    socket.on('submit_punish_choice', (data) => {
        if(gameState.phase !== 'punish_turn' || gameState.currentPunishTeam !== data.teamId) return;
        
        const team = gameState.teams[data.teamId];
        gameState.currentPunishTeam = 'waiting';

        if(data.choice === 'take') {
            team.hp -= gameState.punishmentPot;
            gameState.logs.push(`💀 ${team.name} 承受天譴，扣除 ${gameState.punishmentPot} 分！`);
        } else if (data.choice === 'pass') {
            gameState.punishmentPot *= 2; 
            const allTeams = Object.values(gameState.teams);
            const randomTeam = allTeams[Math.floor(Math.random()*allTeams.length)];
            const pts = Math.floor(Math.random() * 3) + 1; 
            
            const debuffTypes = [
                () => { team.timePenalty = 5; return "時空扭曲：自己的下一題作答時間提早 5 秒結束！"; },
                () => { randomTeam.hp += pts; return `幸運泉湧：隨機使 ${randomTeam.name} 獲得 ${pts} 分！`; },
                () => { randomTeam.hp -= pts; return `厄運蔓延：隨機使 ${randomTeam.name} 流失 ${pts} 分！`; }
            ];
            const res = debuffTypes[Math.floor(Math.random() * debuffTypes.length)]();
            gameState.logs.push(`☠️ ${team.name} 傳遞天譴！【Debuff：${res}】`);
        }

        io.emit('state_update', gameState);
        setTimeout(() => { nextPunishment(); }, 2500);
    });

    socket.on('combat_step', () => {
        if(gameState.combatQueue.length > 0) {
            gameState.currentCombatEvent = gameState.combatQueue.shift();
            if(gameState.currentCombatEvent.applyFunc) gameState.currentCombatEvent.applyFunc();
            gameState.logs.push(gameState.currentCombatEvent.log);
            io.emit('state_update', gameState);
        }
    });

    socket.on('teacher_control', (action) => {
        gameState.logs = []; 
        Object.values(gameState.teams).forEach(t => t.combatAnim = null);
        gameState.currentCombatEvent = null;

        if(action === 'reveal') {
            clearInterval(timerInterval);
            gameState.phase = 'reveal_answers';
            // 公佈答案時，清除所有的倒數罰秒狀態
            Object.values(gameState.teams).forEach(t => t.timePenalty = 0);
        } 
        else if (action === 'show_actions') {
            gameState.phase = 'show_actions';
            prepareCombatSequence();
        } 
        else if (action === 'resolve_punishments') {
            startPunishments(); 
        } 
        else if (action === 'start_magic') {
            gameState.phase = 'magic_phase';
            prepareMagicSequence();
        }
        else if (action === 'next') {
            nextRound();
        }
        else if (action === 'end_game') {
            gameState.phase = 'end_game';
            gameState.endGameRanks = Object.values(gameState.teams).sort((a,b) => b.hp - a.hp);
        }
        io.emit('state_update', gameState);
    });
});

function prepareCombatSequence() {
    gameState.combatQueue = [];
    const teams = Object.values(gameState.teams);
    let attackCounts = {};
    teams.forEach(t => attackCounts[t.id] = 0);

    teams.forEach(t => {
        if(t.isCorrect && t.action === 'attack' && t.target && !t.specialAction) {
            attackCounts[t.target]++;
        }
    });

    teams.forEach(t => {
        let incoming = attackCounts[t.id] || 0;
        let isDefending = (t.isCorrect && t.action === 'defend' && !t.specialAction);
        let dmg = incoming;
        let logStr = `⚔️ 【${t.name}】`;
        let anim = 'hit';

        if (incoming === 0 && !isDefending) return; 

        if (isDefending) {
            if (dmg > 0) dmg--; 
            logStr += `防禦成功！`;
            anim = dmg > 0 ? 'hit' : 'defend';
        }

        if (incoming > 0) {
            logStr += `遭受 ${incoming} 次攻擊，共扣 ${dmg} 分！`;
        } else if (isDefending) {
            logStr += `安然無恙。`;
        }

        gameState.combatQueue.push({ actor: t.id, anim: anim, log: logStr, applyFunc: () => { t.hp -= dmg; } });
    });
}

function startPunishments() {
    const teams = Object.values(gameState.teams);
    let wrongTeams = teams.filter(t => !t.isCorrect).map(t => t.id);
    gameState.punishQueue = shuffleArray(wrongTeams); 
    gameState.punishmentPot = 1; 

    const active = teams.filter(t => t.answer);
    if(active.length > 0 && active.every(t => t.action === 'defend')) {
        const unlucky = active[Math.floor(Math.random()*active.length)];
        unlucky.hp -= 10;
        gameState.logs.push(`⚡ 【天譴】全場退縮防禦！${unlucky.name} 遭雷劈扣 10 分！`);
    }
    nextPunishment();
}

function nextPunishment() {
    if(gameState.punishQueue.length > 0) {
        gameState.phase = 'punish_turn';
        gameState.currentPunishTeam = gameState.punishQueue.shift(); 
        gameState.isLastPunish = (gameState.punishQueue.length === 0); 
    } else {
        gameState.phase = 'punishments_done';
        gameState.currentPunishTeam = null;
    }
    io.emit('state_update', gameState);
}

function prepareMagicSequence() {
    gameState.combatQueue = [];
    const correctTeams = Object.values(gameState.teams).filter(t => t.isCorrect);
    const allTeams = Object.values(gameState.teams);

    const magicCards = [
        { name: '靈魂枷鎖·命運交錯', desc: '強制與隨機一組互換分數', action: (actor) => {
            const target = allTeams[Math.floor(Math.random()*allTeams.length)];
            gameState.combatQueue.push({ actor: actor.id, target: target.id, anim: 'magic', log: `🔄 【${actor.name}】發動魔法！與 ${target.name} 分數互換！`, applyFunc: () => { let temp = actor.hp; actor.hp = target.hp; target.hp = temp; }});
        }},
        { name: '逆轉乾坤·陰陽無極', desc: '自身分數正負號逆轉', action: (actor) => {
            gameState.combatQueue.push({ actor: actor.id, anim: 'magic', log: `☯️ 【${actor.name}】發動魔法！分數正負逆轉！`, applyFunc: () => { actor.hp = actor.hp * -1; }});
        }},
        { name: '滅世天罰·虛空崩解', desc: '隨機一組扣除 5 分', action: (actor) => {
            const target = allTeams[Math.floor(Math.random()*allTeams.length)];
            gameState.combatQueue.push({ actor: actor.id, target: target.id, anim: 'attack', log: `☄️ 【${actor.name}】發動魔法！${target.name} 慘遭轟擊扣 5 分！`, applyFunc: () => { target.hp -= 5; }});
        }},
        { name: '聖光降臨·神聖洗禮', desc: '隨機一組回復 10 分', action: (actor) => {
            const target = allTeams[Math.floor(Math.random()*allTeams.length)];
            gameState.combatQueue.push({ actor: actor.id, target: target.id, anim: 'defend', log: `✨ 【${actor.name}】發動魔法！${target.name} 受到治癒回復 10 分！`, applyFunc: () => { target.hp += 10; }});
        }},
        { name: '死神歸來·萬物歸零', desc: '自身分數瞬間歸零', action: (actor) => {
            gameState.combatQueue.push({ actor: actor.id, anim: 'hit', log: `💀 【${actor.name}】發動魔法！自身分數瞬間歸零！`, applyFunc: () => { actor.hp = 0; }});
        }}
    ];

    correctTeams.forEach(t => {
        const randomCard = magicCards[Math.floor(Math.random() * magicCards.length)];
        t.magicCard = randomCard; 
        randomCard.action(t);
    });
    
    if(correctTeams.length === 0) gameState.combatQueue.push({ anim: null, log: `🌪️ 無人答對，魔法祭壇毫無反應。`});
}

function nextRound() {
    gameState.currentQuestionIndex++;
    if(gameState.currentQuestionIndex >= 10 || gameState.currentQuestionIndex >= questions.length) {
        gameState.phase = 'end_game';
        gameState.endGameRanks = Object.values(gameState.teams).sort((a,b) => b.hp - a.hp);
        io.emit('state_update', gameState);
        return;
    }
    updateQuestion();
    gameState.phase = 'answering';
    gameState.logs = [];
    gameState.combatQueue = [];
    gameState.currentCombatEvent = null;
    for(let id in gameState.teams) {
        Object.assign(gameState.teams[id], {
            locked: false, action: null, target: null, answer: null, 
            isCorrect: false, combatAnim: null, magicCard: null
        });
    }
    startTimer();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`伺服器已啟動，監聽 Port: ${PORT}`));