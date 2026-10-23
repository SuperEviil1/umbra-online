const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

const supabaseAdmin = supabaseUrl && supabaseSecretKey
  ? createClient(supabaseUrl, supabaseSecretKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : null;

app.use(express.static(path.join(__dirname, "public")));

const WORLD = { width: 2400, height: 1800 };
const players = new Map();
const monsters = [];
// Decorative obstacles use the same seeded sequence as the browser's forest,
// so collision locations match what players see on screen.
const obstacles = [];
let decorSeed = 98231;
function decorRand() { decorSeed = (decorSeed * 16807) % 2147483647; return (decorSeed - 1) / 2147483646; }
for (let i = 0; i < 1250; i++) {
  const x = decorRand() * WORLD.width, y = decorRand() * WORLD.height;
  const type = decorRand(), size = 5 + decorRand() * 25;
  decorRand(); decorRand(); // hue and animation phase, shared with the client sequence
  if (type < 0.19) obstacles.push({ x, y: y + size * 0.12, r: Math.max(9, size * 0.27 + 3), kind: "tree" });
  else if (type < 0.31) obstacles.push({ x, y, r: Math.max(7, size * 0.25 + 2), kind: "rock" });
  else if (type < 0.42) obstacles.push({ x, y, r: Math.max(5, size * 0.16 + 2), kind: "crystal" });
}
function collides(x, y, radius = 8) {
  // Broad phase: only inspect obstacles near the candidate position.
  for (const o of obstacles) {
    if (Math.abs(x - o.x) > o.r + radius + 8 || Math.abs(y - o.y) > o.r + radius + 8) continue;
    if (Math.hypot(x - o.x, y - o.y) < o.r + radius) return true;
  }
  return false;
}
let monsterId = 1;
const weatherTypes = ["clear", "sunny", "rain", "storm", "snow", "fog"];
let weather = { type: "clear", since: Date.now(), until: Date.now() + 90000 };
function changeWeather() {
  const weights = ["clear", "sunny", "rain", "storm", "snow", "fog"];
  let next = weights[Math.floor(Math.random() * weights.length)];
  // Snow is rarer in this first version; the world is meant to feel temperate and uncanny.
  if (next === "snow" && Math.random() < 0.55) next = "fog";
  weather = { type: next, since: Date.now(), until: Date.now() + (60000 + Math.floor(Math.random() * 60000)) };
  io.emit("weatherChanged", weather);
}
setInterval(() => {
  if (Date.now() >= weather.until) changeWeather();
}, 5000);

function rand(min, max) { return min + Math.random() * (max - min); }
function spawnMonster() {
  const angle = Math.random() * Math.PI * 2;
  const distance = rand(180, 700);
  const x = Math.max(40, Math.min(WORLD.width - 40, WORLD.width / 2 + Math.cos(angle) * distance));
  const y = Math.max(40, Math.min(WORLD.height - 40, WORLD.height / 2 + Math.sin(angle) * distance));
  monsters.push({
    id: monsterId++, x, y, hp: 35, maxHp: 35,
    kind: Math.random() > 0.5 ? "wraith" : "husk",
    lastHit: 0
  });
}
for (let i = 0; i < 30; i++) spawnMonster();

function spawnPosition() {
  for (let i = 0; i < 80; i++) {
    const x = rand(1100, 1300), y = rand(800, 1000);
    if (!collides(x, y, 14)) return { x, y };
  }
  return { x: WORLD.width / 2, y: WORLD.height / 2 };
}

async function loadCharacter(user) {
  const { data, error } = await supabaseAdmin
    .from("characters")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) throw error;

  if (data) {
    return {
      name: data.name,
      x: data.x,
      y: data.y,
      hp: data.hp,
      maxHp: data.max_hp,
      level: data.level,
      xp: data.xp,
      nextXp: data.next_xp,
      gold: data.gold,
      kills: data.kills,
      attack: data.attack
    };
  }

  const spawn = spawnPosition();

  const character = {
    name: "Exilado-" + user.id.slice(0, 4),
    x: spawn.x,
    y: spawn.y,
    hp: 100,
    maxHp: 100,
    level: 1,
    xp: 0,
    nextXp: 50,
    gold: 0,
    kills: 0,
    attack: 12
  };

  const { error: insertError } = await supabaseAdmin
    .from("characters")
    .insert({
      user_id: user.id,
      name: character.name,
      x: character.x,
      y: character.y
    });

  if (insertError) throw insertError;

  return character;
}

async function saveCharacter(userId, player) {
  if (!supabaseAdmin || !userId || !player) return;

  const { error } = await supabaseAdmin
    .from("characters")
    .update({
      name: player.name,
      x: player.x,
      y: player.y,
      hp: player.hp,
      max_hp: player.maxHp,
      level: player.level,
      xp: player.xp,
      next_xp: player.nextXp,
      gold: player.gold,
      kills: player.kills,
      attack: player.attack,
      updated_at: new Date().toISOString()
    })
    .eq("user_id", userId);

  if (error) console.error("Erro ao salvar personagem:", error.message);
}

io.use(async (socket, next) => {
  try {
    if (!supabaseAdmin) {
      return next(new Error("Autenticação indisponível no servidor."));
    }

    const token = socket.handshake.auth?.token;

    if (!token) {
      return next(new Error("Faça login para entrar no jogo."));
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data.user) {
      return next(new Error("Sessão inválida. Entre novamente."));
    }

    socket.data.user = data.user;
    next();
  } catch (error) {
    console.error("Erro na autenticação:", error.message);
    next(new Error("Não foi possível autenticar sua conta."));
  }
});


io.on("connection", async socket => {
  let savedCharacter;

  try {
    savedCharacter = await loadCharacter(socket.data.user);
  } catch (error) {
    console.error("Erro ao carregar personagem:", error.message);
    socket.disconnect(true);
    return;
  }

  const p = {
    ...savedCharacter,
    id: socket.id,
    userId: socket.data.user.id,
    afk: false,
    lastAttack: 0,
    faceX: 0,
    faceY: -1,
    moving: false,
    lastMoveAt: 0,
    color: ["#b7a0ff", "#83d6c5", "#f1bd78", "#e58ba7"][
      Math.floor(Math.random() * 4)
    ]
  };

  players.set(socket.id, p);

  socket.emit("welcome", { selfId: socket.id, world: WORLD, player: p, weather });
  socket.emit("worldState", { players: [...players.values()], monsters, weather });
  socket.broadcast.emit("playerJoined", p);

  socket.on("move", data => {
    const me = players.get(socket.id);
    if (!me || !data) return;
    const dx = Math.max(-1, Math.min(1, Number(data.dx) || 0));
    const dy = Math.max(-1, Math.min(1, Number(data.dy) || 0));
    const length = Math.hypot(dx, dy) || 1;
    const speed = 220;
    const step = speed * 0.032;
    const nx = Math.max(12, Math.min(WORLD.width - 12, me.x + dx / length * step));
    const ny = Math.max(12, Math.min(WORLD.height - 12, me.y + dy / length * step));
    // Smaller substeps prevent snagging on corners; each axis can slide independently.
    const midX = me.x + (nx - me.x) * 0.5;
    const midY = me.y + (ny - me.y) * 0.5;
    if (!collides(midX, me.y) && !collides(nx, me.y)) me.x = nx;
    else if (!collides(midX, me.y)) me.x = midX;
    if (!collides(me.x, midY) && !collides(me.x, ny)) me.y = ny;
    else if (!collides(me.x, midY)) me.y = midY;
    me.faceX = dx; me.faceY = dy;
    me.moving = true; me.lastMoveAt = Date.now();
    socket.emit("selfUpdate", me);
  });

  socket.on("toggleAfk", value => {
    const me = players.get(socket.id);
    if (!me) return;
    me.afk = Boolean(value);
    socket.emit("notice", me.afk ? "Farm automático ativado." : "Farm automático desativado.");
  });

  socket.on("attack", monsterIdArg => {
    const me = players.get(socket.id);
    const now = Date.now();
    if (!me || now - me.lastAttack < 350) return;
    me.lastAttack = now;
    let target = monsters.find(m => m.id === Number(monsterIdArg));
    if (!target) {
      target = monsters.filter(m => Math.hypot(m.x - me.x, m.y - me.y) < 75)
        .sort((a,b) => Math.hypot(a.x-me.x,a.y-me.y) - Math.hypot(b.x-me.x,b.y-me.y))[0];
    }
    if (!target || Math.hypot(target.x - me.x, target.y - me.y) > 110) {
      socket.emit("notice", "Nenhuma criatura ao alcance.");
      return;
    }
    target.hp -= me.attack;
    io.emit("monsterHit", { id: target.id, hp: target.hp, maxHp: target.maxHp, x: target.x, y: target.y, damage: me.attack, attacker: me.id });
    if (target.hp <= 0) {
      const idx = monsters.findIndex(m => m.id === target.id);
      if (idx >= 0) monsters.splice(idx, 1);
      me.kills++;
      me.gold += Math.floor(rand(5, 13));
      me.xp += 15;
      while (me.xp >= me.nextXp) {
        me.xp -= me.nextXp; me.level++; me.nextXp = Math.floor(me.nextXp * 1.45);
        me.attack += 3; me.maxHp += 15; me.hp = me.maxHp;
      }
      socket.emit("selfUpdate", me);
      saveCharacter(me.userId, me);
      io.emit("monsterDied", { id: target.id, x: target.x, y: target.y, by: me.name, gold: me.gold, level: me.level });
      setTimeout(spawnMonster, 3000);
    }
  });

  
socket.on("disconnect", async () => {
  const me = players.get(socket.id);

  if (me) {
    await saveCharacter(me.userId, me);
    players.delete(socket.id);
  }

  io.emit("playerLeft", socket.id);
});

});

// Authoritative simple monster AI and AFK combat.
setInterval(() => {
  for (const m of monsters) {
    let nearest = null, best = Infinity;
    for (const p of players.values()) {
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < best) { best = d; nearest = p; }
    }
    if (nearest && best < 260 && best > 28) {
      const speed = 24;
      m.x += (nearest.x - m.x) / best * speed * 0.25;
      m.y += (nearest.y - m.y) / best * speed * 0.25;
    }
  }
  for (const p of players.values()) {
    p.moving = Date.now() - (p.lastMoveAt || 0) < 180;
    if (!p.afk || Date.now() - p.lastAttack < 700) continue;
    const target = monsters.filter(m => Math.hypot(m.x-p.x,m.y-p.y) < 100)
      .sort((a,b) => Math.hypot(a.x-p.x,a.y-p.y) - Math.hypot(b.x-p.x,b.y-p.y))[0];
    if (target) {
      p.lastAttack = Date.now();
      target.hp -= p.attack;
      io.emit("monsterHit", { id: target.id, hp: target.hp, maxHp: target.maxHp, x: target.x, y: target.y, damage: p.attack, attacker: p.id });
      if (target.hp <= 0) {
        const idx = monsters.findIndex(m => m.id === target.id);
        if (idx >= 0) monsters.splice(idx, 1);
        p.kills++; p.gold += Math.floor(rand(5,13)); p.xp += 15;
        while (p.xp >= p.nextXp) { p.xp -= p.nextXp; p.level++; p.nextXp = Math.floor(p.nextXp*1.45); p.attack += 3; p.maxHp += 15; p.hp = p.maxHp; }
        io.to(p.id).emit("selfUpdate", p);
        io.emit("monsterDied", { id: target.id, x: target.x, y: target.y, by: p.name, gold: p.gold, level: p.level });
        setTimeout(spawnMonster, 3000);
      }
    }
  }
  io.emit("worldTick", { players: [...players.values()], monsters, weather });
}, 250);

server.listen(PORT, () => console.log(`UMBRA rodando em http://localhost:${PORT}`));
