const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const clientPath = path.join(__dirname, '..', 'client', 'index.html');
    if (fs.existsSync(clientPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(clientPath, 'utf8'));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('서버 실행 중');
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Pinball Soccer WebSocket Server');
});

const wss = new WebSocketServer({ server });
const rooms = new Map();
const MAX_PLAYERS = 8;

const TABLE_W = 360, TABLE_H = 880;
const WALL = 20;
const GOAL_W = 90;
const BALL_RADIUS = 10;
const PLAYER_RADIUS = 18;
const PLAYER_SPEED = 4.5;
const BUMPER_RADIUS = 22;
const ELIMINATION_SCORE = 5;

function generateRoomCode() {
  let code;
  do { code = String(Math.floor(Math.random() * 100)).padStart(2, '0'); }
  while (rooms.has(code));
  return code;
}

const GOAL_POSITIONS = [
  { wall: 'top',    pos: 90 },
  { wall: 'top',    pos: 270 },
  { wall: 'right',  pos: 220 },
  { wall: 'right',  pos: 660 },
  { wall: 'bottom', pos: 270 },
  { wall: 'bottom', pos: 90 },
  { wall: 'left',   pos: 660 },
  { wall: 'left',   pos: 220 },
];

// 플레이어 시작 위치 (필드에 골고루 분포)
const START_POSITIONS = [
  { x: TABLE_W * 0.5,  y: TABLE_H * 0.15 },
  { x: TABLE_W * 0.85, y: TABLE_H * 0.35 },
  { x: TABLE_W * 0.85, y: TABLE_H * 0.65 },
  { x: TABLE_W * 0.5,  y: TABLE_H * 0.85 },
  { x: TABLE_W * 0.15, y: TABLE_H * 0.65 },
  { x: TABLE_W * 0.15, y: TABLE_H * 0.35 },
  { x: TABLE_W * 0.7,  y: TABLE_H * 0.5  },
  { x: TABLE_W * 0.3,  y: TABLE_H * 0.5  },
];

function createInitialGameState(numPlayers) {
  const players = [];
  for (let i = 0; i < numPlayers; i++) {
    const sp = START_POSITIONS[i];
    players.push({
      x: sp.x, y: sp.y,
      radius: PLAYER_RADIUS,
      springActive: false,
      springTimer: 0,
      dashTimer: 0,
      dashCount: 5,
    });
  }
  return {
    numPlayers,
    ball: {
      x: TABLE_W / 2, y: TABLE_H / 2,
      vx: (Math.random() - 0.5) * 5,
      vy: (Math.random() - 0.5) * 5,
      radius: BALL_RADIUS,
      lastTouch: -1,
    },
    players,
    scores: new Array(numPlayers).fill(0),
    eliminated: new Array(numPlayers).fill(false),
    goalPositions: GOAL_POSITIONS.slice(0, numPlayers),
    bumpers: generateBumpers(),
    started: false,
    startTime: 0,
    speedMultiplier: 1.0,
  };
}

function generateBumpers() {
  const bumpers = [];
  const margin = WALL + BUMPER_RADIUS + 5;
  const count = 5;
  for (let i = 0; i < count; i++) {
    let x, y, valid;
    let attempts = 0;
    do {
      x = margin + Math.random() * (TABLE_W - margin * 2);
      y = margin + Math.random() * (TABLE_H - margin * 2);
      valid = true;
      for (const b of bumpers) {
        if (Math.hypot(b.x - x, b.y - y) < BUMPER_RADIUS * 2.5) {
          valid = false;
          break;
        }
      }
      attempts++;
    } while (!valid && attempts < 50);
    bumpers.push({ x, y, radius: BUMPER_RADIUS });
  }
  return bumpers;
}

function updateGameState(state, playerInputs) {
  if (!state.started) return;
  const np = state.numPlayers;
  const ball = state.ball;
  const friction = 0.995;
  const elapsed = (Date.now() - state.startTime) / 1000;
  state.speedMultiplier = Math.min(3.0, 1.0 + elapsed * 0.02);
  const maxSpeed = 14 * state.speedMultiplier;

  // 플레이어 이동
  for (let i = 0; i < np; i++) {
    const p = state.players[i];
    const input = playerInputs.get(i);

    // 대시 트리거
    if (input && input.dash && p.dashTimer <= 0 && (p.dashCount > 0 || state.scores[i] >= 1)) {
      p.dashTimer = 4;
      if (p.dashCount > 0) p.dashCount--;
    }
    if (p.dashTimer > 0) {
      p.dashTimer--;
    }

    if (input && input.tx !== undefined && input.ty !== undefined) {
      const dx = input.tx - p.x;
      const dy = input.ty - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 2) {
        const speed = p.dashTimer > 0 ? PLAYER_SPEED * 5 : PLAYER_SPEED;
        const move = Math.min(speed, dist);
        p.x += (dx / dist) * move;
        p.y += (dy / dist) * move;
      }
    }

    if (input && input.spring && !p.springActive) {
      p.springActive = true;
      p.springTimer = 10;
    }
    if (p.springActive) {
      p.springTimer--;
      if (p.springTimer <= 0) {
        p.springActive = false;
      }
    }
  }

  // 플레이어 간 충돌
  for (let i = 0; i < np; i++) {
    for (let j = i + 1; j < np; j++) {
      const a = state.players[i], b = state.players[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const minDist = a.radius + b.radius;
      if (dist < minDist && dist > 0) {
        const push = (minDist - dist) / 2;
        const nx = dx / dist, ny = dy / dist;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
      }
    }
  }

  // 플레이어 - 공 충돌 (드리블)
  for (let i = 0; i < np; i++) {
    const p = state.players[i];
    const dx = ball.x - p.x, dy = ball.y - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < ball.radius + p.radius && dist > 0) {
      const overlap = ball.radius + p.radius - dist;
      const nx = dx / dist, ny = dy / dist;
      ball.x += nx * overlap;
      ball.y += ny * overlap;

      const dot = ball.vx * nx + ball.vy * ny;
      const pushPower = p.springActive ? 3.0 : 1.2;
      ball.vx -= dot * nx * 0.5;
      ball.vy -= dot * ny * 0.5;
      ball.vx += nx * pushPower;
      ball.vy += ny * pushPower;

      ball.lastTouch = i;
    }
  }

  // 범퍼 충돌
  for (const bumper of state.bumpers) {
    const dx = ball.x - bumper.x, dy = ball.y - bumper.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < ball.radius + bumper.radius && dist > 0) {
      const overlap = ball.radius + bumper.radius - dist;
      const nx = dx / dist, ny = dy / dist;
      ball.x += nx * overlap;
      ball.y += ny * overlap;
      const dot = ball.vx * nx + ball.vy * ny;
      ball.vx -= dot * nx * 1.5;
      ball.vy -= dot * ny * 1.5;
      ball.vx += nx * 4;
      ball.vy += ny * 4;
    }
  }

  // 마찰 + 점진적 속도 증가
  ball.vx *= friction;
  ball.vy *= friction;
  const baseSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
  if (baseSpeed > 0.1) {
    const boost = state.speedMultiplier;
    ball.vx *= 1 + (boost - 1) * 0.008;
    ball.vy *= 1 + (boost - 1) * 0.008;
  }
  ball.x += ball.vx;
  ball.y += ball.vy;

  const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
  if (speed > maxSpeed) {
    ball.vx = (ball.vx / speed) * maxSpeed;
    ball.vy = (ball.vy / speed) * maxSpeed;
  }
  if (speed < 0.3) {
    ball.vx += (Math.random() - 0.5) * 0.4;
    ball.vy += (Math.random() - 0.5) * 0.4;
  }

  // 벽 충돌 + 골대
  const margin = ball.radius + 2;
  let onWall = false, wallSide = '';
  if (ball.x - margin < 0) { onWall = true; wallSide = 'left'; }
  else if (ball.x + margin > TABLE_W) { onWall = true; wallSide = 'right'; }
  if (ball.y - margin < 0) { onWall = true; wallSide = 'top'; }
  else if (ball.y + margin > TABLE_H) { onWall = true; wallSide = 'bottom'; }

  if (onWall) {
    let scored = false;
    const goals = state.goalPositions;
    for (let i = 0; i < np; i++) {
      const g = goals[i];
      if (g.wall !== wallSide) continue;
      let inGoal = false;
      switch (g.wall) {
        case 'top':    inGoal = ball.y - margin < 0 && Math.abs(ball.x - g.pos) < GOAL_W/2; break;
        case 'bottom': inGoal = ball.y + margin > TABLE_H && Math.abs(ball.x - g.pos) < GOAL_W/2; break;
        case 'left':   inGoal = ball.x - margin < 0 && Math.abs(ball.y - g.pos) < GOAL_W/2; break;
        case 'right':  inGoal = ball.x + margin > TABLE_W && Math.abs(ball.y - g.pos) < GOAL_W/2; break;
      }
      if (inGoal) {
        state.scores[i] = (state.scores[i] || 0) + 1;
        state.players[i].dashCount = 5;
        resetBall(state);
        scored = true;
        break;
      }
    }
    if (!scored) {
      if (ball.x - margin < 0) { ball.x = margin; ball.vx = -ball.vx * 0.8; }
      else if (ball.x + margin > TABLE_W) { ball.x = TABLE_W - margin; ball.vx = -ball.vx * 0.8; }
      if (ball.y - margin < 0) { ball.y = margin; ball.vy = -ball.vy * 0.8; }
      else if (ball.y + margin > TABLE_H) { ball.y = TABLE_H - margin; ball.vy = -ball.vy * 0.8; }
    }
  }

  // 플레이어를 테이블 안에 가두기
  const pMargin = PLAYER_RADIUS + 2;
  for (const p of state.players) {
    p.x = Math.max(pMargin, Math.min(TABLE_W - pMargin, p.x));
    p.y = Math.max(pMargin, Math.min(TABLE_H - pMargin, p.y));
  }
}

function resetBall(state) {
  state.ball.x = TABLE_W / 2 + (Math.random() - 0.5) * 80;
  state.ball.y = TABLE_H / 2 + (Math.random() - 0.5) * 80;
  const angle = Math.random() * Math.PI * 2;
  const spd = 3 + Math.random() * 2;
  state.ball.vx = Math.cos(angle) * spd;
  state.ball.vy = Math.sin(angle) * spd;
  state.ball.lastTouch = -1;
}

function getStateForPlayer(state) {
  return {
    numPlayers: state.numPlayers,
    ball: state.ball,
    players: state.players,
    bumpers: state.bumpers,
    scores: state.scores,
    eliminated: state.eliminated,
    tableW: TABLE_W,
    tableH: TABLE_H,
    wallThick: WALL,
    started: state.started,
    goalPositions: state.goalPositions,
    goalWidth: GOAL_W,
  };
}

wss.on('connection', (ws) => {
  ws.playerId = null;
  ws.roomCode = null;
  ws.playerIndex = -1;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'create_room': {
          const code = generateRoomCode();
          ws.playerId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
          ws.roomCode = code;
          ws.playerIndex = 0;
          const room = {
            code,
            players: new Map(),
            state: createInitialGameState(),
            playerInputs: new Map(),
            hostId: ws.playerId,
            gameLoop: null,
          };
          rooms.set(code, room);
          room.players.set(ws.playerId, { ws, index: 0, nickname: msg.nickname || '방장' });
          ws.send(JSON.stringify({ type: 'room_created', code, playerId: ws.playerId, playerIndex: 0 }));
          broadcastPlayerList(room);
          break;
        }

        case 'join_room': {
          const code = msg.code;
          if (!rooms.has(code)) { ws.send(JSON.stringify({ type: 'error', message: '방을 찾을 수 없습니다.' })); return; }
          const room = rooms.get(code);
          if (room.players.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ type: 'error', message: '방이 가득 찼습니다.' })); return; }
          if (room.state.started) { ws.send(JSON.stringify({ type: 'error', message: '이미 게임이 시작되었습니다.' })); return; }
          ws.playerId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
          ws.roomCode = code;
          ws.playerIndex = room.players.size;
          room.players.set(ws.playerId, { ws, index: ws.playerIndex, nickname: msg.nickname || `P${ws.playerIndex + 1}` });
          ws.send(JSON.stringify({ type: 'joined', code, playerId: ws.playerId, playerIndex: ws.playerIndex, players: getPlayerList(room) }));
          broadcastPlayerList(room);
          break;
        }

        case 'start_game': {
          if (!ws.roomCode || !rooms.has(ws.roomCode)) return;
          const room = rooms.get(ws.roomCode);
          if (room.hostId !== ws.playerId) { ws.send(JSON.stringify({ type: 'error', message: '방장만 시작할 수 있습니다.' })); return; }
          if (room.players.size < 1) return;
          room.state = createInitialGameState(room.players.size);
          room.state.started = true;
          room.state.startTime = Date.now();
          room.playerInputs.clear();
          broadcastToRoom(room, { type: 'game_started', state: getStateForPlayer(room.state), playerMap: getPlayerMap(room) });
          if (room.gameLoop) clearInterval(room.gameLoop);
          room.gameLoop = setInterval(() => {
            updateGameState(room.state, room.playerInputs);

            const newEliminations = [];
            for (let i = 0; i < room.state.numPlayers; i++) {
              if (room.state.scores[i] >= ELIMINATION_SCORE && !room.state.eliminated[i]) {
                room.state.eliminated[i] = true;
                newEliminations.push(i);
              }
            }
            for (const ei of newEliminations) {
              broadcastToRoom(room, { type: 'player_eliminated', playerIndex: ei, scores: [...room.state.scores], eliminated: [...room.state.eliminated] });
            }

            const activeCount = room.state.eliminated.filter(e => !e).length;
            if (activeCount <= 1) {
              if (room.gameLoop) clearInterval(room.gameLoop);
              room.gameLoop = null;
              room.state.started = false;
              broadcastToRoom(room, { type: 'game_over', scores: [...room.state.scores], eliminated: [...room.state.eliminated] });
            } else {
              broadcastToRoom(room, { type: 'game_update', state: getStateForPlayer(room.state) });
            }
          }, 1000 / 60);
          break;
        }

        case 'player_input': {
          if (!ws.roomCode || !rooms.has(ws.roomCode)) return;
          rooms.get(ws.roomCode).playerInputs.set(ws.playerIndex, msg.input);
          break;
        }
      }
    } catch (e) { console.error('메시지 오류:', e); }
  });

  ws.on('close', () => {
    if (ws.roomCode && rooms.has(ws.roomCode)) {
      const room = rooms.get(ws.roomCode);
      room.players.delete(ws.playerId);
      room.playerInputs.delete(ws.playerIndex);
      if (room.players.size === 0) {
        if (room.gameLoop) clearInterval(room.gameLoop);
        rooms.delete(ws.roomCode);
      } else {
        if (room.hostId === ws.playerId) {
          const first = room.players.values().next().value;
          if (first) room.hostId = first.ws.playerId;
        }
        broadcastPlayerList(room);
        broadcastToRoom(room, { type: 'player_left', playerIndex: ws.playerIndex });
      }
    }
  });
});

function getPlayerMap(room) {
  const map = {};
  for (const [id, p] of room.players) map[p.index] = { index: p.index, nickname: p.nickname, isHost: id === room.hostId };
  return map;
}
function getPlayerList(room) {
  return Array.from(room.players.values()).map(p => ({ index: p.index, nickname: p.nickname || `P${p.index + 1}`, isHost: p.ws.playerId === room.hostId }));
}
function broadcastPlayerList(room) { broadcastToRoom(room, { type: 'player_list', players: getPlayerList(room) }); }
function broadcastToRoom(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) { if (p.ws.readyState === 1) p.ws.send(data); }
}

server.listen(PORT, () => console.log(`⚽ 핀볼 축구 서버 실행 중 - 포트: ${PORT}`));
