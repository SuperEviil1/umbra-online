const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const compression = require("compression");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });
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

app.use(compression());
// PixiJS vem do npm e é servido pelo próprio servidor (sem depender de CDN)
app.use("/vendor/pixi", express.static(path.join(__dirname, "node_modules", "pixi.js", "dist"), { maxAge: "7d" }));
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
// Spatial hash: collision checks inspect nearby cells instead of all 1,250 decorations.
const OBSTACLE_CELL_SIZE = 64;
const obstacleGrid = new Map();
function obstacleCellKey(cx, cy) { return cx + ":" + cy; }
function addObstacleToGrid(obstacle) {
  const cx = Math.floor(obstacle.x / OBSTACLE_CELL_SIZE);
  const cy = Math.floor(obstacle.y / OBSTACLE_CELL_SIZE);
  const key = obstacleCellKey(cx, cy);
  if (!obstacleGrid.has(key)) obstacleGrid.set(key, []);
  obstacleGrid.get(key).push(obstacle);
}
for (const obstacle of obstacles) addObstacleToGrid(obstacle);
function collides(x, y, radius = 8) {
  const reach = 48 + radius - 8;
  const minX = Math.floor((x - reach) / OBSTACLE_CELL_SIZE);
  const maxX = Math.floor((x + reach) / OBSTACLE_CELL_SIZE);
  const minY = Math.floor((y - reach) / OBSTACLE_CELL_SIZE);
  const maxY = Math.floor((y + reach) / OBSTACLE_CELL_SIZE);
  for (let cx = minX; cx <= maxX; cx++) {
    for (let cy = minY; cy <= maxY; cy++) {
      const nearby = obstacleGrid.get(obstacleCellKey(cx, cy));
      if (!nearby) continue;
      for (const o of nearby) {
        if (Math.abs(x - o.x) > o.r + radius + 8 || Math.abs(y - o.y) > o.r + radius + 8) continue;
        if (Math.hypot(x - o.x, y - o.y) < o.r + radius) return true;
      }
    }
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

const ITEM_CATALOG = {
  "slime-gel": { name: "Gelatina Sombria", icon: "🟣" },
  "old-bone": { name: "Osso Antigo", icon: "🦴" },
  "veil-shard": { name: "Fragmento do Véu", icon: "💎" },
  "minor-potion": { name: "Poção Menor", icon: "🧪", usable: true }
};
async function loadInventory(userId) {
  if (!supabaseAdmin || !userId) return [];
  const { data, error } = await supabaseAdmin.from("character_inventory").select("item_id, quantity, metadata").eq("user_id", userId);
  if (error) { console.error("Erro ao carregar inventário:", error.message); return []; }
  return (data || []).map(row => ({ id: row.item_id, name: ITEM_CATALOG[row.item_id]?.name || row.item_id, icon: ITEM_CATALOG[row.item_id]?.icon || "📦", quantity: row.quantity, metadata: row.metadata || {} }));
}
async function grantRandomLoot(player, socketId) {
  if (!player?.userId) return;
  const roll = Math.random();
  const itemId = roll < .42 ? "slime-gel" : roll < .72 ? "old-bone" : roll < .78 ? "veil-shard" : roll < .9 ? "minor-potion" : null;
  if (!itemId) return;
  if (!Array.isArray(player.inventory)) player.inventory = [];
  let entry = player.inventory.find(i => i.id === itemId);
  if (entry) entry.quantity += 1;
  else {
    entry = { id: itemId, name: ITEM_CATALOG[itemId].name, icon: ITEM_CATALOG[itemId].icon, quantity: 1, metadata: {} };
    player.inventory.push(entry);
  }
  io.to(socketId).emit("inventoryUpdate", player.inventory);
  io.to(socketId).emit("notice", "Item obtido: " + ITEM_CATALOG[itemId].name + "!");
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin.from("character_inventory").upsert(
    { user_id: player.userId, item_id: itemId, quantity: entry.quantity, updated_at: new Date().toISOString() },
    { onConflict: "user_id,item_id" });
  if (error) {
    console.error("Erro ao salvar item:", error.message);
    player.inventory = await loadInventory(player.userId); // ressincroniza com o banco
    io.to(socketId).emit("inventoryUpdate", player.inventory);
  }
}

function rand(min, max) { return min + Math.random() * (max - min); }

// ---- Rede: tick de 10 Hz e payloads compactos ----
const TICK_MS = 100, TICK_DT = TICK_MS / 1000;
const r1 = v => Math.round(v * 10) / 10;
function publicPlayer(p) {
  return { id: p.id, name: p.name, x: r1(p.x), y: r1(p.y), hp: p.hp, maxHp: p.maxHp, level: p.level,
    faceX: p.faceX, faceY: p.faceY, moving: p.moving, afk: p.afk, color: p.color };
}
function publicMonster(m) { return { id: m.id, x: r1(m.x), y: r1(m.y), hp: m.hp, maxHp: m.maxHp, kind: m.kind }; }
const publicPlayers = () => { const out = []; for (const p of players.values()) out.push(publicPlayer(p)); return out; };
const publicMonsters = () => monsters.map(publicMonster);
function selfStats(p) {
  return { x: r1(p.x), y: r1(p.y), hp: p.hp, maxHp: p.maxHp, level: p.level, xp: p.xp, nextXp: p.nextXp,
    gold: p.gold, kills: p.kills, attack: p.attack, faceX: p.faceX, faceY: p.faceY, afk: p.afk };
}
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

  // Mesma conta em duas abas/aparelhos: salva e remove a sessão antiga antes de carregar a nova
  for (const [sid, other] of [...players]) {
    if (other.userId !== socket.data.user.id) continue;
    players.delete(sid);
    await saveCharacter(other.userId, other);
    io.sockets.sockets.get(sid)?.disconnect(true);
    io.emit("playerLeft", sid);
  }

  try {
    savedCharacter = await loadCharacter(socket.data.user);
  } catch (error) {
    console.error("Erro ao carregar personagem:", error.message);
    socket.disconnect(true);
    return;
  }

  const inventory = await loadInventory(socket.data.user.id);
  if (!socket.connected) return; // jogador saiu enquanto carregava

  const p = {
    ...savedCharacter,
    inventory,
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
  socket.emit("worldState", { players: publicPlayers(), monsters: publicMonsters(), weather });
  socket.broadcast.emit("playerJoined", publicPlayer(p));

  socket.on("move", data => {
    const me = players.get(socket.id);
    if (!me || !data) return;
    // balde de fichas: ~1 movimento a cada 32 ms (rajada máx. 3) — o cliente envia nesse ritmo
    const tNow = Date.now();
    me.moveTokens = Math.min(3, (me.moveTokens ?? 3) + (tNow - (me.lastTokenAt || tNow)) / 32);
    me.lastTokenAt = tNow;
    if (me.moveTokens < 1) return;
    me.moveTokens -= 1;
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
    socket.emit("selfUpdate", selfStats(me));
  });

  socket.on("renameCharacter", async requestedName => {
    const me = players.get(socket.id);
    if (!me) return;
    const name = String(requestedName || "").trim();
    if (name.length < 3 || name.length > 18 || !/^[\\p{L}0-9 _-]+$/u.test(name)) {
      socket.emit("renameError", "Nome inválido. Use 3 a 18 letras, números, espaços, _ ou -.");
      return;
    }
    const { error } = await supabaseAdmin.from("characters").update({ name, updated_at: new Date().toISOString() }).eq("user_id", me.userId);
    if (error) {
      console.error("Erro ao alterar nome:", error.message);
      socket.emit("renameError", "Não foi possível salvar o nome. Tente novamente.");
      return;
    }
    me.name = name;
    socket.emit("characterRenamed", { name });
    io.emit("worldState", { players: publicPlayers(), monsters: publicMonsters(), weather });
    void saveCharacter(me.userId, me);
  });

  socket.on("useItem", async itemId => {
    const me = players.get(socket.id);
    if (!me || itemId !== "minor-potion") return;
    const entry = (me.inventory || []).find(i => i.id === itemId);
    if (!entry || entry.quantity < 1) {
      socket.emit("notice", "Você não tem essa poção no inventário.");
      return;
    }
    if (me.hp >= me.maxHp) {
      socket.emit("notice", "Sua vida já está cheia.");
      return;
    }
    entry.quantity -= 1;
    const remaining = entry.quantity;
    if (remaining <= 0) me.inventory = me.inventory.filter(i => i.id !== itemId);
    const healed = Math.min(35, me.maxHp - me.hp);
    me.hp += healed;
    socket.emit("itemUsed", { hp: me.hp, inventory: me.inventory, message: "Poção usada: +" + healed + " de vida." });
    void saveCharacter(me.userId, me);
    if (!supabaseAdmin) return;
    const query = remaining > 0
      ? supabaseAdmin.from("character_inventory").update({ quantity: remaining, updated_at: new Date().toISOString() }).eq("user_id", me.userId).eq("item_id", itemId)
      : supabaseAdmin.from("character_inventory").delete().eq("user_id", me.userId).eq("item_id", itemId);
    const { error } = await query;
    if (error) {
      console.error("Erro ao consumir poção:", error.message);
      me.inventory = await loadInventory(me.userId);
      socket.emit("inventoryUpdate", me.inventory);
      socket.emit("notice", "Não foi possível salvar o uso do item.");
    }
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
      socket.emit("selfUpdate", selfStats(me));
      void grantRandomLoot(me, socket.id);
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
  if (players.size === 0) return; // ninguém online: não gasta CPU
  for (const m of monsters) {
    let nearest = null, best = Infinity;
    for (const p of players.values()) {
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < best) { best = d; nearest = p; }
    }
    if (nearest && best < 260 && best > 28) {
      const speed = 24;
      m.x += (nearest.x - m.x) / best * speed * TICK_DT;
      m.y += (nearest.y - m.y) / best * speed * TICK_DT;
    }
  }
  for (const p of players.values()) {
    const now = Date.now();
    p.moving = now - (p.lastMoveAt || 0) < 180;
    if (!p.afk) continue;

    // AFK farm: find the nearest monster, walk toward it, and attack when close.
    // Find nearest target in one pass; avoid allocating and sorting a temporary array per player/tick.
    let targetMonster = null, targetDistance = Infinity;
    for (const monster of monsters) {
      const dxToMonster = monster.x - p.x, dyToMonster = monster.y - p.y;
      const distanceSquared = dxToMonster * dxToMonster + dyToMonster * dyToMonster;
      if (distanceSquared < targetDistance) {
        targetDistance = distanceSquared;
        targetMonster = monster;
      }
    }
    let target = targetMonster ? { monster: targetMonster, distance: Math.sqrt(targetDistance) } : null;

    if (target && target.distance > 72) {
      const dx = (target.monster.x - p.x) / target.distance;
      const dy = (target.monster.y - p.y) / target.distance;
      const step = 80 * TICK_DT; // 80 unidades por segundo
      const nx = Math.max(12, Math.min(WORLD.width - 12, p.x + dx * step));
      const ny = Math.max(12, Math.min(WORLD.height - 12, p.y + dy * step));
      if (!collides(nx, p.y, 8)) p.x = nx;
      if (!collides(p.x, ny, 8)) p.y = ny;
      p.faceX = dx; p.faceY = dy;
      p.lastMoveAt = now; p.moving = true;
    } else if (!target && now - (p.lastWanderAt || 0) > 2500) {
      // If no monsters exist temporarily, wander a little until they respawn.
      const angle = Math.random() * Math.PI * 2;
      const nx = Math.max(12, Math.min(WORLD.width - 12, p.x + Math.cos(angle) * 70));
      const ny = Math.max(12, Math.min(WORLD.height - 12, p.y + Math.sin(angle) * 70));
      if (!collides(nx, ny, 8)) { p.x = nx; p.y = ny; }
      p.faceX = Math.cos(angle); p.faceY = Math.sin(angle);
      p.lastWanderAt = now; p.lastMoveAt = now; p.moving = true;
    }

    if (now - p.lastAttack < 700) continue;
    // Attack the closest in-range monster without map/filter/sort allocations.
    targetMonster = null;
    targetDistance = 100 * 100;
    for (const monster of monsters) {
      const dxToMonster = monster.x - p.x, dyToMonster = monster.y - p.y;
      const distanceSquared = dxToMonster * dxToMonster + dyToMonster * dyToMonster;
      if (distanceSquared < targetDistance) {
        targetDistance = distanceSquared;
        targetMonster = monster;
      }
    }
    target = targetMonster ? { monster: targetMonster, distance: Math.sqrt(targetDistance) } : null;
    if (target) {
      p.lastAttack = now;
      const m = target.monster;
      m.hp -= p.attack;
      io.emit("monsterHit", { id: m.id, hp: m.hp, maxHp: m.maxHp, x: m.x, y: m.y, damage: p.attack, attacker: p.id });
      if (m.hp <= 0) {
        const idx = monsters.findIndex(item => item.id === m.id);
        if (idx >= 0) monsters.splice(idx, 1);
        p.kills++; p.gold += Math.floor(rand(5,13)); p.xp += 15;
        while (p.xp >= p.nextXp) { p.xp -= p.nextXp; p.level++; p.nextXp = Math.floor(p.nextXp*1.45); p.attack += 3; p.maxHp += 15; p.hp = p.maxHp; }
        io.to(p.id).emit("selfUpdate", selfStats(p));
        void grantRandomLoot(p, p.id);
        saveCharacter(p.userId, p);
        io.emit("monsterDied", { id: m.id, x: m.x, y: m.y, by: p.name, gold: p.gold, level: p.level });
        setTimeout(spawnMonster, 3000);
      }
    }
  }
  io.emit("worldTick", { players: publicPlayers(), monsters: publicMonsters() });
}, TICK_MS);

server.listen(PORT, () => console.log(`UMBRA rodando em http://localhost:${PORT}`));

/* Salvamento automático dos personagens a cada 30 segundos */
setInterval(() => {
  for (const player of players.values()) {
    if (player.userId) {
      saveCharacter(player.userId, player);
    }
  }
}, 30_000);

