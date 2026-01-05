// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 정적 파일 제공 (index.html이 있는 폴더)
app.use(express.static(path.join(__dirname, 'public')));

// === 게임 상태 데이터 (서버가 원본을 가짐) ===
let gameState = {
    roundIndex: 0, // 0:프리플랍, 1:플랍, 2:턴, 3:리버
    rounds: ["프리플랍", "플랍", "턴", "리버"],
    phase: "bet", // 'bet' or 'draw'
    pot: 0,
    players: [], // { id, name, chips, bet, loan, inDebt, folded }
    readyPlayers: []
};

io.on('connection', (socket) => {
    console.log('새로운 유저 접속:', socket.id);

    // 접속하자마자 현재 게임 상태 전송
    socket.emit('updateState', gameState);

    // 플레이어 추가 부분 수정
    socket.on('addPlayer', ({ name, initialChips, uuid }) => {
        // 이미 해당 uuid를 가진 플레이어가 있는지 확인 (새로고침 대응)
        let player = gameState.players.find(p => p.uuid === uuid);

        if (player) {
            // 기존 플레이어가 있다면 socket.id만 최신화 (권한 복구)
            player.id = socket.id;
        } else {
            // 없다면 새로 추가
            const newPlayer = {
                id: socket.id,
                uuid: uuid, // ⭐ 브라우저가 들고 있는 고유 ID
                name: name,
                chips: initialChips,
                originalChips: initialChips,
                bet: 0,
                callNeed: 0,
                loan: 0,
                inDebt: false,
                folded: false
            };
            gameState.players.push(newPlayer);
        }
        io.emit('updateState', gameState);
    });

    // [수정 예시] 베팅 요청 시 본인 확인 로직 추가
    socket.on('bet', ({ playerId, amount }) => {
        // ⭐ 요청한 socket.id와 대상 playerId가 다르면 무시
        if (socket.id !== playerId) return;

        const p = gameState.players.find(pl => pl.id === playerId);
        if (!p || p.folded || gameState.phase !== 'bet') return;

        if (p.chips >= amount) {
            p.chips -= amount;
            p.bet += amount;
            gameState.pot += amount;
            updateCallAmounts();
            io.emit('updateState', gameState);
        }
    });

    // 2. 베팅 로직
    socket.on('actionBet', ({ playerId, amount }) => {
        if (socket.id !== playerId) return;

        const player = gameState.players.find(p => p.id === playerId);
        if (!player || gameState.phase !== 'bet') return;

        if (player.chips >= amount) {
            player.chips -= amount;
            player.bet += amount;
            gameState.pot += amount;
            updateCallAmounts(); // 콜 비용 계산
            io.emit('updateState', gameState);
        }
    });

    // 3. 올인
    socket.on('actionAllIn', ({ playerId }) => {
        if (socket.id !== playerId) return;

        const player = gameState.players.find(p => p.id === playerId);
        if (!player || gameState.phase !== 'bet') return;

        const amount = player.chips;
        if (amount > 0) {
            player.chips = 0;
            player.bet += amount;
            gameState.pot += amount;
            updateCallAmounts();
            io.emit('updateState', gameState);
        }
    });

    // 4. 다이 (Fold)
    socket.on('actionFold', ({ playerId }) => {
        if (socket.id !== playerId) return;

        const player = gameState.players.find(p => p.id === playerId);
        if (player) {
            player.folded = true;
            updateCallAmounts();
            io.emit('updateState', gameState);
        }
    });

    // 5. 대출
    socket.on('actionLoan', ({ playerId, amount }) => {
        if (socket.id !== playerId) return;

        const player = gameState.players.find(p => p.id === playerId);
        if (player && !player.inDebt && player.chips === 0 && amount <= 500) {
            player.chips = amount;
            player.loan = amount;
            player.inDebt = true;
            io.emit('updateState', gameState);
        }
    });

    // 6. 단계 이동 요청 (투표 방식)
    socket.on('nextPhase', () => {
        // 1. 유효한 플레이어인지 확인
        const player = gameState.players.find(p => p.id === socket.id);
        if (!player) return;

        // 2. 투표 토글
        if (gameState.readyPlayers.includes(socket.id)) {
            gameState.readyPlayers = gameState.readyPlayers.filter(id => id !== socket.id);
        } else {
            gameState.readyPlayers.push(socket.id);
        }

        // 3. 현재 투표해야 하는 인원 계산 (폴드 안 한 사람 기준)
        const activePlayers = gameState.players.filter(p => !p.folded);

        // 4. 전원 동의 체크 (최소 1명 이상일 때)
        if (activePlayers.length > 0 && activePlayers.every(p => gameState.readyPlayers.includes(p.id))) {
            proceedToNextPhase();
        }

        io.emit('updateState', gameState);
    });

    // 7. 승자 결정 (팟 분배)
    socket.on('confirmWin', ({ playerId }) => {
        const player = gameState.players.find(p => p.id === playerId);
        if (!player) return;

        player.chips += gameState.pot;
        gameState.pot = 0;

        // 게임 리셋
        gameState.roundIndex = 0;
        gameState.phase = 'bet';
        gameState.players.forEach(p => {
            p.bet = 0;
            p.folded = false;
        });

        // 빚 상환 로직
        if (player.inDebt) {
            if (player.chips >= player.loan) {
                player.chips -= player.loan;
                player.loan = 0;
                player.inDebt = false;
            } else {
                player.loan -= player.chips;
                player.chips = 0;
            }
        }

        updateCallAmounts();
        gameState.readyPlayers = []; // 준비 상태 초기화
        io.emit('updateState', gameState);
    });

    // 8. 전체 게임 초기화 (Reset)
    socket.on('resetGame', () => {
        // 판 정보 초기화
        gameState.roundIndex = 0;
        gameState.phase = 'bet';
        gameState.pot = 0;

        // 모든 플레이어 상태 초기화
        gameState.players.forEach(p => {
            p.chips = p.originalChips; // 처음 참가할 때 설정한 칩으로 복구
            p.bet = 0;
            p.callNeed = 0;
            p.loan = 0;
            p.inDebt = false;
            p.folded = false;
        });

        console.log('게임이 초기화되었습니다.');
        gameState.readyPlayers = [];
        io.emit('updateState', gameState);
    });

    // 9. 플레이어 삭제 (하나로 통합)
    socket.on('removePlayer', ({ playerId, uuid }) => {
        const playerIndex = gameState.players.findIndex(p => p.id === playerId || p.uuid === uuid);
        if (playerIndex === -1) return;

        // 본인 확인
        const targetPlayer = gameState.players[playerIndex];
        if (targetPlayer.id === socket.id || targetPlayer.uuid === uuid) {
            console.log(`플레이어 제거: ${targetPlayer.name}`);

            // ⭐ 투표 목록에서도 제거 (매우 중요)
            gameState.readyPlayers = gameState.readyPlayers.filter(id => id !== targetPlayer.id);

            gameState.players.splice(playerIndex, 1);
            updateCallAmounts();
            io.emit('updateState', gameState);
        }
    });

    // [추가] 모든 플레이어 삭제 (목록 초기화)
    socket.on('deleteAllPlayers', () => {
        // 1. 플레이어 목록을 빈 배열로 초기화
        gameState.players = [];

        // 2. 게임 판 정보도 초기화
        gameState.roundIndex = 0;
        gameState.phase = 'bet';
        gameState.pot = 0;

        // 3. 모든 클라이언트에 알림
        io.emit('updateState', gameState);
    });
});

// 내부 함수: 최대 베팅액 계산 후 콜 비용 업데이트
function updateCallAmounts() {
    let maxBet = 0;
    gameState.players.forEach(p => {
        if (p.bet > maxBet) maxBet = p.bet;
    });

    gameState.players.forEach(p => {
        if (!p.folded) {
            p.callNeed = Math.max(0, maxBet - p.bet);
        } else {
            p.callNeed = 0;
        }
    });
}

// 내부 함수: 이자 적용 (20%)
function applyInterest() {
    gameState.players.forEach(p => {
        if (p.inDebt) {
            p.loan += Math.ceil(p.loan * 0.2);
        }
    });
}

// 다음 단계로 넘어가는 실제 함수 분리
function proceedToNextPhase() {
    gameState.readyPlayers = []; // 다음 단계를 위해 초기화

    if (gameState.phase === 'bet') {
        gameState.phase = 'draw';
    } else {
        if (gameState.roundIndex >= gameState.rounds.length - 1) {
            applyInterest();
            return;
        }
        applyInterest();
        gameState.phase = 'bet';
        gameState.roundIndex++;
    }
}

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
