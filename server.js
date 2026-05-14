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
    currentQuestionIndex: -1, 
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
                questions = results.data.slice(0, 11); 
                updateQuestion();
                console.log(`✅ 題庫同步成功！共載入 ${questions.length} 題 (含測試題)`);
            }
        });
    } catch (e) { console.error("題庫讀取失敗", e); }
}
loadQuestions();

function updateQuestion() {
    if(gameState.currentQuestionIndex >= 0 && questions[gameState.currentQuestionIndex]) {
        gameState.question = questions[gameState.currentQuestionIndex];
    } else {
        gameState.question = null;
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
        
        Object.values(gameState.teams).forEach(t => {
            if (!t.locked && t.timePenalty > 0 && gameState.timeLeft <= t.timePenalty) {
                t.locked = true; t.action = 'defend'; t.answer = null; t.isCorrect = false; 
                someoneLocked = true;
            }
        });

        if(gameState.timeLeft <= 0) {
            gameState.timeLeft = 0; 
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
        gameState.currentQuestionIndex = -1;
        gameState.phase = 'setup';
        gameState.teams = {};
        gameState.logs = [];
        updateQuestion();
        io.emit('state_update', gameState);
    });

    socket.on('teacher_setup', (count) => {
        gameState.phase = 'lobby';
        gameState.teams = {};
        gameState.currentQuestionIndex = -1;
        const names = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
        let parsedCount = parseInt(count) || 10;
        
        for(let i=1; i<=parsedCount; i++) {
            let id = `team${i}`;
            let tName = `${names[i-1] || i}號部落`;
            
            // 【終極彩蛋】如果設定 10 組，強制將第 5 組改名為「天神」
            if (parsedCount === 10 && i === 5) {
                tName = '天神';
            }
            
            gameState.teams[id] = { 
                id, name: tName, hp: 10, 
                connected: false, locked: false, action: null, target: null, 
                answer: null, isCorrect: false, combatAnim: null, magicCard: null, timePenalty: 0, personalLog: "",
                prisonCount: 0
            };
        }
        io.emit('state_update', gameState);
    });

    socket.on('claim_team', (teamId) => {
        if (gameState.teams[teamId]) {
            gameState.teams[teamId].connected = true;
            socket.emit('claim_success', {teamId, name: gameState.teams[teamId].name});
            io.emit('state_update', gameState);
        }
    });

    socket.on('teacher_start', () => {
        gameState.phase = 'round_transition';
        gameState.logs = [];
        io.emit('state_update', gameState);
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

    socket.on('teacher_submit_punish', (choice) => {
        if(gameState.phase !== 'punish_turn' || !gameState.currentPunishTeam) return;
        
        const team = gameState.teams[gameState.currentPunishTeam];
        gameState.currentPunishTeam = 'waiting';

        if(choice === 'take') {
            team.hp -= gameState.punishmentPot;
            gameState.logs.push(`💀 ${team.name} 自行承受天譴，扣除 ${gameState.punishmentPot} 分！`);
            gameState.punishQueue = []; 
        } else if (choice === 'pass') {
            gameState.punishmentPot *= 2; 
            const allTeams = Object.values(gameState.teams);
            const randomTeam = allTeams[Math.floor(Math.random()*allTeams.length)];
            const pts = Math.floor(Math.random() * 3) + 1; 
            
            let roll = Math.floor(Math.random() * 10);
            let res = "";
            if (roll < 3) {
                team.timePenalty = 5; res = "【時空扭曲】自己部落下一題作答時間減少 5 秒！";
            } else if (roll < 6) {
                randomTeam.hp += pts; res = `【幸運泉湧】隨機使 ${randomTeam.name} 獲得 ${pts} 分！`;
            } else if (roll < 9) {
                randomTeam.hp -= pts; res = `【厄運蔓延】隨機使 ${randomTeam.name} 流失 ${pts} 分！`;
            } else {
                if (team.prisonCount < 2) {
                    team.prisonCount++;
                    res = `【間諜家家酒】請 ${team.name} 派一名隊員至講台上協助大祭司，輔佐天神！`;
                } else {
                    randomTeam.hp -= pts; res = `【厄運蔓延】隨機使 ${randomTeam.name} 流失 ${pts} 分！`;
                }
            }
            gameState.logs.push(`☠️ ${team.name} 無情傳遞天譴！觸發：${res}`);
            io.emit('global_debuff', `🚨 突發狀況 🚨\n${res}`);
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
        else if (action === 'end_round') {
            gameState.phase = 'round_transition';
        }
        else if (action === 'next') {
            if (gameState.currentQuestionIndex === 0) {
                Object.values(gameState.teams).forEach(t => t.hp = 10);
            }
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
    let attackersMap = {}; 
    teams.forEach(t => attackersMap[t.id] = []);
    teams.forEach(t => {
        if(t.isCorrect && t.action === 'attack' && t.target) attackersMap[t.target].push(t.name);
    });
    teams.forEach(t => {
        let incomingAttackers = attackersMap[t.id];
        let dmg = incomingAttackers.length;
        let isDefending = (t.isCorrect && t.action === 'defend');
        if (incomingAttackers.length === 0 && !isDefending) {
            t.personalLog = "🛡️ 此回合無人攻擊你，安然無恙。";
            return;
        } 
        if (isDefending) {
            dmg = 0;
            gameState.combatQueue.push({ actor: t.id, anim: 'defend', log: `⚔️ 【${t.name}】完美防禦！擋下了來自 ${incomingAttackers.length > 0 ? incomingAttackers.join('、') : '空氣'} 的攻擊！` });
            t.personalLog = `🛡️ 完美防禦！成功擋下了攻擊！`;
        } else {
            gameState.combatQueue.push({ 
                actor: t.id, anim: 'hit', log: `⚔️ 【${t.name}】遭受 ${incomingAttackers.join('、')} 猛烈攻擊，扣除 ${dmg} 分！`,
                applyFunc: () => { t.hp -= dmg; },
                damage: dmg 
            });
            t.personalLog = `💥 遭到攻擊，扣除 ${dmg} 分！`;
        }
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
        gameState.logs.push(`⚡ 【天譴】所有部落皆選擇防禦！人神共憤！${unlucky.name} 遭雷劈扣 10 分！`);
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
        { id: 'swap', name: '靈魂枷鎖·命運交錯', desc: '強制與隨機一組互換分數', action: (actor) => {
            const target = allTeams[Math.floor(Math.random()*allTeams.length)];
            gameState.combatQueue.push({ actor: actor.id, target: target.id, anim: 'magic', log: `🔄 【${actor.name}】發動魔法！與 ${target.name} 分數互換！`, applyFunc: () => { let temp = actor.hp; actor.hp = target.hp; target.hp = temp; }});
        }},
        { id: 'reverse', name: '逆轉乾坤·陰陽無極', desc: '自身分數正負號逆轉', action: (actor) => {
            gameState.combatQueue.push({ actor: actor.id, anim: 'magic', log: `☯️ 【${actor.name}】發動魔法！分數正負逆轉！`, applyFunc: () => { actor.hp = actor.hp * -1; }});
        }},
        { id: 'gojo', name: '領域展開·無量空處', desc: '隨機一組分數直接砍半', action: (actor) => {
            const target = allTeams[Math.floor(Math.random()*allTeams.length)];
            gameState.combatQueue.push({ actor: actor.id, target: target.id, anim: 'attack', log: `🤞 【${actor.name}】發動《二點五條悟》！${target.name} 分數被強制砍半！`, applyFunc: () => { target.hp = Math.floor(target.hp / 2); }});
        }},
        { id: 'heal', name: '聖光降臨·神聖洗禮', desc: '隨機一組回復 10 分', action: (actor) => {
            const target = allTeams[Math.floor(Math.random()*allTeams.length)];
            gameState.combatQueue.push({ actor: actor.id, target: target.id, anim: 'defend', log: `✨ 【${actor.name}】發動魔法！${target.name} 受到治癒回復 10 分！`, applyFunc: () => { target.hp += 10; }});
        }},
        { id: 'zero', name: '死神歸來·萬物歸零', desc: '自身分數瞬間歸零', action: (actor) => {
            gameState.combatQueue.push({ actor: actor.id, anim: 'hit', log: `💀 【${actor.name}】發動魔法！自身分數瞬間歸零！`, applyFunc: () => { actor.hp = 0; }});
        }}
    ];
    const x10Card = { id: 'x10', name: '神之手·十倍界王拳', desc: '隨機一組尾數加個零(x10)', action: (actor) => {
        const target = allTeams[Math.floor(Math.random()*allTeams.length)];
        gameState.combatQueue.push({ actor: actor.id, target: target.id, anim: 'magic', log: `🔥 【${actor.name}】發動《十倍界王拳》！${target.name} 分數暴增十倍！`, applyFunc: () => { if(target.hp !== 0) target.hp = target.hp * 10; }});
    }};
    if(correctTeams.length === 0) {
        gameState.combatQueue.push({ anim: null, log: `🌪️ 無人答對，魔法祭壇無法啟動...`});
        return;
    }
    if (gameState.currentQuestionIndex === 10) { 
        correctTeams[0].magicCard = x10Card;
        x10Card.action(correctTeams[0]);
        for(let i=1; i<correctTeams.length; i++) {
            let rc = magicCards[Math.floor(Math.random() * magicCards.length)];
            correctTeams[i].magicCard = rc; rc.action(correctTeams[i]);
        }
    } else {
        correctTeams.forEach(t => {
            let rc = magicCards[Math.floor(Math.random() * magicCards.length)];
            t.magicCard = rc; rc.action(t);
        });
    }
}

function nextRound() {
    gameState.currentQuestionIndex++;
    if(gameState.currentQuestionIndex > 10) { 
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
            isCorrect: false, combatAnim: null, magicCard: null, personalLog: ""
        });
    }
    startTimer();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));