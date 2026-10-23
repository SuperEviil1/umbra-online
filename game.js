'use strict';
/* =====================================================================
   UMBRA Online — cliente PixiJS (WebGL)
   Estrutura: 1) setup  2) texturas  3) mundo  4) luz/clima/partículas
              5) entidades  6) loop  7) rede/UI/entrada
   ===================================================================== */
const SUPABASE_URL = 'https://ysyamsrhfhfmscjgjfzc.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_B_V6f4RfWEgCeZ6lwL2XqQ__x6ZBx6X';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

(() => {
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;
const hexNum = c => typeof c === 'number' ? c : parseInt(String(c || '#b7a0ff').replace('#', ''), 16);
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const mkRng = s0 => { let s = s0; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; };

if (!window.PIXI) {
  $('authMessage').textContent = 'Não foi possível carregar o motor gráfico (PixiJS). Recarregue a página.';
  return;
}
const BM = PIXI.BLEND_MODES;

/* ---------- 1) Setup ---------- */
const canvas = $('game');
let world = { width: 2400, height: 1800 };

// Mesma sequência pseudoaleatória do servidor: as colisões batem com o que se vê.
const decor = [];
{ const rand = mkRng(98231);
  for (let i = 0; i < 1250; i++) decor.push({ x: rand() * 2400, y: rand() * 1800, type: rand(), s: 5 + rand() * 25, h: rand() * 360, phase: rand() * TAU }); }

// Qualidade adaptativa: começa alta (média em celular) e cai sozinha se o FPS ficar baixo.
const DPR = window.devicePixelRatio || 1;
const LEVELS = [
  { res: Math.min(DPR, 2),   light: .5,  weather: 1,   fancy: true  },
  { res: Math.min(DPR, 1.5), light: .4,  weather: .6,  fancy: true  },
  { res: 1,                  light: .3,  weather: .35, fancy: false }
];
let qLevel = matchMedia('(pointer:coarse)').matches ? 1 : 0;
let Q = LEVELS[qLevel];

const app = new PIXI.Application({
  view: canvas, width: 900, height: 600, resolution: Q.res, autoDensity: false,
  antialias: true, backgroundColor: 0x0a0f0d, powerPreference: 'high-performance'
});
app.ticker.maxFPS = 60;

/* ---------- 2) Texturas procedurais ---------- */
function bake(w, h, fn) { const c = mk(w, h); fn(c.getContext('2d'), c); return PIXI.Texture.from(c); }
function radial(size, stops) {
  return bake(size, size, g => {
    const r = size / 2, gr = g.createRadialGradient(r, r, 0, r, r, r);
    for (const [o, col] of stops) gr.addColorStop(o, col);
    g.fillStyle = gr; g.fillRect(0, 0, size, size);
  });
}
// objeto com origem (ox,oy) e escala k: o sprite fica nítido mesmo em telas HiDPI
function bakeObj(w, h, ox, oy, k, fn) {
  const c = mk(w, h), g = c.getContext('2d');
  g.translate(ox, oy); g.scale(k, k); fn(g);
  return { tex: PIXI.Texture.from(c), ax: ox / w, ay: oy / h, k };
}
const T = {};
T.glow   = radial(128, [[0, 'rgba(255,255,255,1)'], [.25, 'rgba(255,255,255,.55)'], [.6, 'rgba(255,255,255,.14)'], [1, 'rgba(255,255,255,0)']]);
T.soft   = radial(64,  [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]);
T.dot    = radial(16,  [[0, '#fff'], [.5, 'rgba(255,255,255,.8)'], [1, 'rgba(255,255,255,0)']]);
T.shadow = radial(64,  [[0, 'rgba(0,0,0,.6)'], [.65, 'rgba(0,0,0,.28)'], [1, 'rgba(0,0,0,0)']]);
T.streak = bake(4, 32, g => { const gr = g.createLinearGradient(0, 0, 0, 32); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(255,255,255,.9)'); g.fillStyle = gr; g.fillRect(1, 0, 2, 32); });
T.ray    = bake(64, 256, g => {
  const h = g.createLinearGradient(0, 0, 64, 0); h.addColorStop(0, 'rgba(255,255,255,0)'); h.addColorStop(.5, 'rgba(255,255,255,.9)'); h.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = h; g.fillRect(0, 0, 64, 256);
  g.globalCompositeOperation = 'destination-in';
  const v = g.createLinearGradient(0, 0, 0, 256); v.addColorStop(0, 'rgba(0,0,0,1)'); v.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = v; g.fillRect(0, 0, 64, 256);
});
T.vignette = bake(256, 256, g => {
  const gr = g.createRadialGradient(128, 128, 60, 128, 128, 182);
  gr.addColorStop(0, 'rgba(4,6,12,0)'); gr.addColorStop(.6, 'rgba(4,6,12,.28)'); gr.addColorStop(1, 'rgba(2,3,8,.82)');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
});

const TREE_PAL = [
  ['#10302b', '#1d4a3c', '#2f6a4f', '#5a9468'],   // floresta
  ['#10303a', '#1b4c58', '#2b6f78', '#52a0a6'],   // azulada
  ['#221f3f', '#352f63', '#4b4585', '#7a72bd'],   // violeta (Umbra)
  ['#1f2f1c', '#33481f', '#4c6a2e', '#86a350']    // oliva
];
function paintTree(g, s, pal, rng) {
  g.save(); g.translate(0, s * .47); g.scale(1, .34);
  let sh = g.createRadialGradient(0, 0, 0, 0, 0, s * .85); sh.addColorStop(0, 'rgba(0,0,0,.5)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = sh; g.beginPath(); g.arc(0, 0, s * .85, 0, TAU); g.fill(); g.restore();
  // tronco com raízes
  const tg = g.createLinearGradient(-s * .3, 0, s * .3, 0); tg.addColorStop(0, '#12161a'); tg.addColorStop(.6, '#2a2723'); tg.addColorStop(1, '#171a1d');
  g.fillStyle = tg; g.beginPath(); g.moveTo(-s * .14, s * .12); g.quadraticCurveTo(-s * .23, s * .4, -s * .34, s * .57); g.lineTo(-s * .1, s * .48); g.lineTo(0, s * .28); g.lineTo(s * .12, s * .52); g.lineTo(s * .3, s * .57); g.lineTo(s * .18, s * .25); g.lineTo(s * .14, -s * .42); g.closePath(); g.fill();
  g.strokeStyle = '#7a644f'; g.lineWidth = Math.max(1, s * .04); g.beginPath(); g.moveTo(-s * .04, s * .25); g.quadraticCurveTo(s * .02, 0, -s * .01, -s * .43); g.moveTo(s * .07, s * .07); g.lineTo(s * .25, -s * .15); g.stroke();
  // copa em camadas com sombreamento
  const blobs = [[-.35, -.45, .55], [-.05, -.72, .65], [.34, -.48, .58], [-.1, -.28, .68], [.36, -.2, .42], [-.42, -.16, .42]];
  blobs.forEach(([x, y, r], i) => {
    const cx = x * s, cy = y * s, rx = s * r, ry = s * r * .74;
    const gr = g.createRadialGradient(cx - rx * .3, cy - ry * .4, rx * .1, cx, cy, rx * 1.05);
    gr.addColorStop(0, pal[2 + (i % 2)]); gr.addColorStop(.55, pal[1]); gr.addColorStop(1, pal[0]);
    g.fillStyle = gr; g.beginPath(); g.ellipse(cx, cy, rx, ry, (i % 3 - .8) * .2, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(190,235,170,.22)'; g.lineWidth = Math.max(1, s * .022); g.beginPath(); g.arc(cx - rx * .12, cy - ry * .12, rx * .72, 3.5, 5.1); g.stroke();
  });
  // folhas claras e sombra inferior
  for (let i = 0; i < 26; i++) {
    const a = rng() * TAU, d = Math.sqrt(rng()) * s * .7;
    g.fillStyle = `rgba(${170 + rng() * 60 | 0},${210 + rng() * 40 | 0},${150 + rng() * 40 | 0},${.1 + rng() * .16})`;
    g.beginPath(); g.ellipse(Math.cos(a) * d * 1.1, -s * .45 + Math.sin(a) * d * .75, s * .045, s * .022, rng() * 3, 0, TAU); g.fill();
  }
  const dk = g.createLinearGradient(0, -s * .1, 0, s * .2); dk.addColorStop(0, 'rgba(3,8,10,0)'); dk.addColorStop(1, 'rgba(3,8,10,.4)');
  g.fillStyle = dk; g.beginPath(); g.ellipse(0, -s * .12, s * .82, s * .42, 0, 0, TAU); g.fill();
}
function paintRock(g, s, rng) {
  g.save(); g.translate(0, s * .3); g.scale(1, .32);
  const sh = g.createRadialGradient(0, 0, 0, 0, 0, s * .9); sh.addColorStop(0, 'rgba(0,0,0,.5)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = sh; g.beginPath(); g.arc(0, 0, s * .9, 0, TAU); g.fill(); g.restore();
  const gr = g.createLinearGradient(-s * .6, -s * .7, s * .6, s * .3); gr.addColorStop(0, '#79837c'); gr.addColorStop(1, '#353d3b');
  g.fillStyle = gr; g.beginPath(); g.moveTo(-s * .6, s * .3); g.lineTo(-s * .3, -s * .5); g.lineTo(s * .35, -s * .7); g.lineTo(s * .7, s * .2); g.closePath(); g.fill();
  g.fillStyle = 'rgba(210,225,205,.16)'; g.beginPath(); g.moveTo(-s * .3, -s * .5); g.lineTo(s * .35, -s * .7); g.lineTo(s * .22, -s * .2); g.lineTo(-s * .2, -s * .12); g.closePath(); g.fill();
  g.strokeStyle = '#1b211f'; g.lineWidth = Math.max(1, s * .035); g.beginPath(); g.moveTo(-s * .2, 0); g.lineTo(s * .05, -s * .3); g.lineTo(s * .02, -s * .05); g.stroke();
  g.fillStyle = '#6ea36a'; g.beginPath(); g.ellipse(-s * .08, -s * .5, s * .22, s * .08, -.3, 0, TAU); g.fill();
  g.fillStyle = '#9bd08e'; g.beginPath(); g.ellipse(-s * .14, -s * .53, s * .1, s * .04, -.3, 0, TAU); g.fill();
}
function paintCrystal(g, s, cols) {
  g.save(); g.translate(0, s * .42); g.scale(1, .3);
  const sh = g.createRadialGradient(0, 0, 0, 0, 0, s * .6); sh.addColorStop(0, 'rgba(0,0,0,.5)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = sh; g.beginPath(); g.arc(0, 0, s * .6, 0, TAU); g.fill(); g.restore();
  const shard = (ox, sc) => {
    g.save(); g.translate(ox * s, 0); g.scale(sc, sc);
    const gr = g.createLinearGradient(-s * .3, -s, s * .35, s * .4); gr.addColorStop(0, cols[0]); gr.addColorStop(.5, cols[1]); gr.addColorStop(1, cols[2]);
    g.fillStyle = gr; g.beginPath(); g.moveTo(0, -s * 1.1); g.lineTo(s * .38, -s * .25); g.lineTo(s * .22, s * .45); g.lineTo(-s * .16, s * .38); g.lineTo(-s * .32, -s * .25); g.closePath(); g.fill();
    g.fillStyle = 'rgba(235,255,250,.7)'; g.beginPath(); g.moveTo(0, -s); g.lineTo(s * .08, -s * .15); g.lineTo(-s * .12, s * .25); g.lineTo(-s * .18, -s * .23); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(215,255,245,.65)'; g.lineWidth = 1.2; g.stroke(); g.restore();
  };
  shard(-.32, .55); shard(.3, .42); shard(0, 1);
}
function paintMushroom(g, s, cap, cap2) {
  g.save(); g.translate(0, s * .08); g.scale(1, .3);
  const sh = g.createRadialGradient(0, 0, 0, 0, 0, s * .7); sh.addColorStop(0, 'rgba(0,0,0,.5)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = sh; g.beginPath(); g.arc(0, 0, s * .7, 0, TAU); g.fill(); g.restore();
  g.fillStyle = '#d9c8a6'; g.beginPath(); g.moveTo(-s * .18, 0); g.quadraticCurveTo(-s * .12, -s * .45, -s * .06, -s * .58); g.lineTo(s * .12, -s * .58); g.quadraticCurveTo(s * .2, -s * .3, s * .22, 0); g.closePath(); g.fill();
  const gr = g.createLinearGradient(0, -s * .9, 0, -s * .3); gr.addColorStop(0, cap2); gr.addColorStop(1, cap);
  g.fillStyle = gr; g.beginPath(); g.moveTo(-s * .62, -s * .43); g.quadraticCurveTo(-s * .55, -s * .92, 0, -s * .88); g.quadraticCurveTo(s * .55, -s * .85, s * .65, -s * .42); g.quadraticCurveTo(0, -s * .22, -s * .62, -s * .43); g.fill();
  g.fillStyle = '#f7d8ff'; for (let i = 0; i < 3; i++) { g.beginPath(); g.arc((i - 1) * s * .23, -s * (.58 + (i % 2) * .12), Math.max(1, s * .055), 0, TAU); g.fill(); }
}

// Variações pré-renderizadas (K=2: nítidas até em telas 2x)
const TEX = { tree: [], rock: [], crystal: [], mush: [] };
{ const rng = mkRng(5151);
  TREE_PAL.forEach(p => TEX.tree.push(bakeObj(250, 270, 125, 168, 2, g => paintTree(g, 64, p, rng))));
  for (let i = 0; i < 3; i++) TEX.rock.push(bakeObj(136, 112, 68, 68, 2, g => paintRock(g, 40, rng)));
  TEX.crystal.push(bakeObj(112, 168, 56, 112, 2, g => paintCrystal(g, 48, ['#8ff3e2', '#2b9a90', '#14504e'])));
  TEX.crystal.push(bakeObj(112, 168, 56, 112, 2, g => paintCrystal(g, 48, ['#d2bcff', '#7a52b0', '#392864'])));
  TEX.mush.push(bakeObj(104, 84, 52, 64, 2, g => paintMushroom(g, 32, '#2f7d75', '#5fd0bf')));
  TEX.mush.push(bakeObj(104, 84, 52, 64, 2, g => paintMushroom(g, 32, '#7c3f9c', '#c07be0'))); }

/* ---------- 3) Mundo: chão pré-renderizado + decoração em sprites ---------- */
function buildGround() {
  const W = 2400, H = 1800, c = mk(W, H), g = c.getContext('2d'), R = mkRng(73471);
  const base = g.createLinearGradient(0, 0, W, H); base.addColorStop(0, '#1b362d'); base.addColorStop(.5, '#22443a'); base.addColorStop(1, '#182f29');
  g.fillStyle = base; g.fillRect(0, 0, W, H);
  const drifts = [['rgba(52,96,70,.20)', 260], ['rgba(24,60,66,.22)', 300], ['rgba(62,52,104,.14)', 320], ['rgba(10,20,22,.26)', 260], ['rgba(88,110,60,.10)', 200]];
  for (let i = 0; i < 260; i++) {
    const [col, r0] = drifts[i % drifts.length], x = R() * W, y = R() * H, rr = r0 * (.4 + R() * .7);
    const gr = g.createRadialGradient(x, y, 0, x, y, rr); gr.addColorStop(0, col); gr.addColorStop(1, col.replace(/[\d.]+\)$/, '0)'));
    g.fillStyle = gr; g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  for (let i = 0; i < 5200; i++) {   // capim e sombras de grama
    const x = R() * W, y = R() * H, l = 3 + R() * 6, a = -Math.PI / 2 + (R() - .5) * 1.1;
    g.strokeStyle = R() > .35 ? `rgba(${90 + R() * 60 | 0},${150 + R() * 60 | 0},${100 + R() * 40 | 0},${.14 + R() * .2})` : `rgba(6,16,14,${.18 + R() * .2})`;
    g.lineWidth = 1 + R() * .8; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  // antiga trilha de pedra (fixa no mapa; antes ela acompanhava o jogador)
  for (let t = 0; t <= 1.0001; t += .011) {
    const px = 260 + t * 1880, py = 1090 + Math.sin(t * 5.2) * 85 + Math.sin(t * 13) * 14;
    for (let k = 0; k < 3; k++) {
      const ox = (R() - .5) * 34, oy = (R() - .5) * 30, rx = 9 + R() * 8, ry = 6 + R() * 6;
      g.fillStyle = ['#5d6d62', '#6c7c6c', '#53625a', '#76856f'][(R() * 4) | 0];
      g.beginPath(); g.ellipse(px + ox, py + oy, rx, ry, R() * 3, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(10,18,16,.45)'; g.lineWidth = 1; g.stroke();
      g.fillStyle = 'rgba(190,215,170,.12)'; g.beginPath(); g.ellipse(px + ox - 2, py + oy - 2, rx * .55, ry * .45, 0, 0, TAU); g.fill();
    }
  }
  for (const d of decor) {            // decoração rasteira vai direto no chão
    if (d.type < .56) continue;
    const x = d.x, y = d.y, s = d.s;
    if (d.type < .65) {
      g.strokeStyle = '#3d6650'; g.lineWidth = 2; g.beginPath(); g.moveTo(x - s * .5, y + s * .5); g.quadraticCurveTo(x, y - s * .5, x + s * .6, y + s * .4); g.stroke();
      g.fillStyle = '#62a375'; g.beginPath(); g.ellipse(x + 2, y - 3, 4, 2, -.4, 0, TAU); g.fill();
    } else if (d.type < .8) {
      g.fillStyle = '#2f6249'; g.beginPath(); g.ellipse(x, y, s * .48, s * .25, 0, 0, TAU); g.fill();
      g.fillStyle = '#3c7a58'; g.beginPath(); g.ellipse(x - 1, y - 2, s * .34, s * .17, 0, 0, TAU); g.fill();
      const fc = d.h < 180 ? '#d6ee9f' : '#dcaaf2';
      for (let i = 0; i < 3; i++) { g.fillStyle = fc; g.beginPath(); g.arc(x + (i - 1) * s * .18, y - 2 + (i % 2) * 2, 1.7, 0, TAU); g.fill(); }
    } else {
      g.fillStyle = 'rgba(120,145,120,.6)'; g.beginPath(); g.ellipse(x, y, s * .45, s * .2, d.phase, 0, TAU); g.fill();
      g.fillStyle = 'rgba(190,210,180,.25)'; g.beginPath(); g.ellipse(x - 1, y - 1, s * .25, s * .1, d.phase, 0, TAU); g.fill();
    }
  }
  return PIXI.Texture.from(c);
}

// camadas (de baixo para cima)
const worldC = new PIXI.Container();
const ground = new PIXI.Sprite(buildGround());
const decorLow = new PIXI.Container();     // cogumelos (sem ordenação)
const glowLayer = new PIXI.Container();    // brilhos aditivos dos cristais/cogumelos
const ySort = new PIXI.Container(); ySort.sortableChildren = true;   // árvores, pedras, cristais e personagens
const fxWorld = new PIXI.Container();      // faíscas e números de dano
worldC.addChild(ground, decorLow, glowLayer, ySort, fxWorld);

const decorObjs = [];
for (const d of decor) {
  if (d.type >= .56) continue;  // rasteiros já estão no chão
  let kind, variant, unit, tex, z, sp;
  if (d.type < .19) { kind = 'tree'; variant = Math.min(3, (d.h / 90) | 0); unit = d.s * 1.45 * 1.6 / 128; tex = TEX.tree[variant]; z = d.y + d.s * 1.45 * 1.6 * .42; }
  else if (d.type < .31) { kind = 'rock'; variant = (d.h / 120) | 0; unit = d.s / 80; tex = TEX.rock[Math.min(2, variant)]; z = d.y + d.s * .3; }
  else if (d.type < .42) { kind = 'crystal'; variant = d.h < 180 ? 0 : 1; unit = d.s * 1.25 / 96; tex = TEX.crystal[variant]; z = d.y + d.s * .5; }
  else { kind = 'mush'; variant = d.h < 180 ? 0 : 1; unit = d.s * 1.1 / 64; tex = TEX.mush[variant]; z = 0; }
  sp = new PIXI.Sprite(tex.tex); sp.anchor.set(tex.ax, tex.ay); sp.scale.set(unit); sp.position.set(d.x, d.y);
  const o = { x: d.x, y: d.y, kind, sp, phase: d.phase, s: d.s, v: false, glow: null, tint: variant === 0 ? 0x5ff0da : 0xa982ff };
  sp.visible = false;
  if (kind === 'mush') decorLow.addChild(sp); else { sp.zIndex = z; ySort.addChild(sp); }
  if (kind === 'crystal' || kind === 'mush') {
    const gl = new PIXI.Sprite(T.glow); gl.anchor.set(.5); gl.blendMode = BM.ADD; gl.tint = o.tint; gl.visible = false;
    const sc = kind === 'crystal' ? d.s * 3.4 / 128 : d.s * 2.2 / 128; gl.scale.set(sc);
    gl.position.set(d.x, d.y - (kind === 'crystal' ? d.s * .45 : d.s * .3)); o.glow = gl; o.glowBase = kind === 'crystal' ? .55 : .28; o.glowSc = sc;
    glowLayer.addChild(gl);
  }
  decorObjs.push(o);
}

/* ---------- 4) Estado, luz, clima e partículas ---------- */
let selfId = null;
let me = { x: 1200, y: 900, hp: 100, maxHp: 100, level: 1, xp: 0, nextXp: 50, gold: 0, kills: 0, attack: 12, afk: false, inventory: [] };
const players = new Map();   // id -> dados públicos vindos do servidor
const mData = new Map();     // id -> dados do monstro (servidor)
let VW = 900, VH = 600;
const cam = { x: 0, y: 0, init: false };

const lightRT = PIXI.RenderTexture.create({ width: 256, height: 256 });
const lightC = new PIXI.Container();
const lightBg = new PIXI.Sprite(PIXI.Texture.WHITE); lightC.addChild(lightBg);
const lightSprite = new PIXI.Sprite(lightRT); lightSprite.blendMode = BM.MULTIPLY;
const lightPool = [], lightQ = [];
const addLight = (wx, wy, r, tint, a) => lightQ.push(wx, wy, r, tint, a);
function flushLights() {
  let n = 0;
  for (let i = 0; i < lightQ.length; i += 5) {
    let s = lightPool[n];
    if (!s) { s = new PIXI.Sprite(T.glow); s.anchor.set(.5); s.blendMode = BM.ADD; lightC.addChild(s); lightPool[n] = s; }
    s.visible = true;
    s.position.set((lightQ[i] - cam.x) * Q.light, (lightQ[i + 1] - cam.y) * Q.light);
    s.scale.set(lightQ[i + 2] * 2 * Q.light / 128);
    s.tint = lightQ[i + 3]; s.alpha = lightQ[i + 4]; n++;
  }
  for (let i = n; i < lightPool.length; i++) lightPool[i].visible = false;
  lightQ.length = 0;
}

const screenFx = new PIXI.Container();
const vignette = new PIXI.Sprite(T.vignette);
app.stage.addChild(worldC, lightSprite, screenFx, vignette);

// clima: ambiente de luz + partículas em espaço de tela
const WX = {
  clear: { amb: [176, 186, 214], motes: 26, moteTint: 0xb7f6bb },
  sunny: { amb: [255, 241, 212], motes: 30, moteTint: 0xffe6a8, rays: 6 },
  rain:  { amb: [128, 144, 174], rain: 90, wind: .25 },
  storm: { amb: [92, 104, 140],  rain: 120, wind: .55, lightning: true },
  snow:  { amb: [190, 202, 226], snow: 60 },
  fog:   { amb: [148, 158, 180], clouds: 7 }
};
let weather = { type: 'clear', until: Date.now() + 60000 };
const amb = [176, 186, 214];
const lightning = { t: 0 };
const wp = { rain: [], snow: [], mote: [], cloud: [], ray: [] };
function mkWp(kind, n, make) {
  for (let i = 0; i < n; i++) { const s = make(); s.visible = false; s.u = Math.random(); s.v = Math.random(); s.w = Math.random(); screenFx.addChild(s); wp[kind].push(s); }
}
mkWp('ray', 6, () => { const s = new PIXI.Sprite(T.ray); s.anchor.set(.5, 0); s.blendMode = BM.ADD; s.tint = 0xffe9b8; return s; });
mkWp('cloud', 7, () => { const s = new PIXI.Sprite(T.soft); s.anchor.set(.5); s.tint = 0xc7cae0; return s; });
mkWp('mote', 44, () => { const s = new PIXI.Sprite(T.dot); s.anchor.set(.5); s.blendMode = BM.ADD; return s; });
mkWp('snow', 70, () => { const s = new PIXI.Sprite(T.dot); s.anchor.set(.5); s.tint = 0xf3f6ff; return s; });
mkWp('rain', 120, () => { const s = new PIXI.Sprite(T.streak); s.anchor.set(.5, 1); s.tint = 0xc3dcff; return s; });
const flash = new PIXI.Sprite(PIXI.Texture.WHITE); flash.tint = 0xcfe0ff; flash.alpha = 0; flash.blendMode = BM.ADD;
const bolt = new PIXI.Graphics(); bolt.alpha = 0;
screenFx.addChild(flash, bolt);

function triggerLightning() {
  lightning.t = 1; bolt.clear();
  let bx = VW * (.15 + Math.random() * .7), by = 0;
  const pts = [[bx, by]];
  for (let i = 0; i < 7; i++) { bx += (Math.random() - .5) * 90; by += VH / 7; pts.push([bx, by]); }
  for (const [w, a] of [[9, .22], [3, 1]]) {
    bolt.lineStyle(w, 0xe6efff, a); bolt.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) bolt.lineTo(pts[i][0], pts[i][1]);
  }
}
function updateWeather(dt, t) {
  const cfg = WX[weather.type] || WX.clear, wq = Q.weather;
  const k = 1 - Math.exp(-dt * 1.6);
  for (let i = 0; i < 3; i++) amb[i] += (cfg.amb[i] - amb[i]) * k;
  if (cfg.lightning && Math.random() < dt * .28) triggerLightning();
  const fl = lightning.t; lightning.t = Math.max(0, lightning.t - dt * 3);
  flash.alpha = fl * .32 * (.7 + .3 * Math.sin(t * 90)); bolt.alpha = fl > .4 ? 1 : fl * 2;
  const boost = fl * 70;
  lightBg.tint = (clamp(amb[0] + boost, 0, 255) << 16) | (clamp(amb[1] + boost, 0, 255) << 8) | clamp(amb[2] + boost, 0, 255) | 0;

  const wind = cfg.wind || 0, nRain = Math.round((cfg.rain || 0) * wq);
  const tilt = -Math.atan2(wind * .35 * VW, 1.1 * VH);
  wp.rain.forEach((s, i) => {
    if (i >= nRain) { s.visible = false; return; }
    s.visible = true; s.v += dt * (.95 + s.w * .6) * (1 + wind * .4); s.u += dt * wind * .35 * (.8 + s.w * .4);
    if (s.v > 1.1) { s.v = -.1; s.u = Math.random() * 1.1; } if (s.u > 1.1) s.u -= 1.2;
    s.position.set(s.u * VW, s.v * VH); s.rotation = tilt; s.scale.y = .5 + s.w * .7; s.alpha = .3 + s.w * .3;
  });
  const nSnow = Math.round((cfg.snow || 0) * wq);
  wp.snow.forEach((s, i) => {
    if (i >= nSnow) { s.visible = false; return; }
    s.visible = true; s.v += dt * (.05 + s.w * .07); s.u += Math.sin(t * .9 + s.w * 20) * dt * .02;
    if (s.v > 1.05) { s.v = -.05; s.u = Math.random(); } s.u = (s.u + 1) % 1;
    s.position.set(s.u * VW, s.v * VH); s.scale.set(.3 + s.w * .5); s.alpha = .55 + s.w * .4;
  });
  const nMote = Math.round((cfg.motes || 0) * wq);
  wp.mote.forEach((s, i) => {
    if (i >= nMote) { s.visible = false; return; }
    s.visible = true; s.tint = cfg.moteTint;
    s.u += Math.sin(t * .4 + s.w * 30) * dt * .012 + dt * .004; s.v += Math.cos(t * .35 + s.u * 20) * dt * .01 - dt * .004;
    s.u = (s.u + 1) % 1; s.v = (s.v + 1) % 1;
    s.position.set(s.u * VW, s.v * VH); s.scale.set(.45 + s.w * .6); s.alpha = .15 + .6 * (.5 + .5 * Math.sin(t * 1.6 + s.w * 40));
  });
  const nCloud = cfg.clouds ? Math.max(2, Math.round(cfg.clouds * wq)) : 0;
  wp.cloud.forEach((s, i) => {
    if (i >= nCloud) { s.visible = false; return; }
    s.visible = true; s.u += dt * .012 * (.6 + s.w); if (s.u > 1.4) s.u = -.4;
    s.position.set(s.u * VW, VH * (.1 + s.v * .8)); s.scale.set(VW * (.7 + s.w * .5) / 64, VH * (.35 + s.v * .2) / 64);
    s.alpha = .13 + .08 * Math.sin(t * .3 + s.w * 10);
  });
  const nRay = cfg.rays || 0;
  wp.ray.forEach((s, i) => {
    if (i >= nRay) { s.visible = false; return; }
    s.visible = true; s.rotation = -.38 + Math.sin(t * .25 + s.w * 9) * .03;
    s.position.set(VW * (.4 + s.u * .75), -VH * .1); s.scale.set(1.2 + s.w * 2.6, VH * 1.5 / 256); s.alpha = .06 + .05 * Math.sin(t * .5 + s.w * 12);
  });
}

// faíscas (impacto/morte) e números de dano
const sparks = []; let sparkCur = 0;
function spark(x, y, vx, vy, life, sc, tint, grav) {
  let s = null;
  for (let i = 0; i < sparks.length; i++) { const q = sparks[(sparkCur + i) % sparks.length]; if (!q.on) { s = q; sparkCur = (sparkCur + i + 1) % sparks.length; break; } }
  if (!s) {
    if (sparks.length >= 220) return;
    const spr = new PIXI.Sprite(T.dot); spr.anchor.set(.5); spr.blendMode = BM.ADD; fxWorld.addChild(spr);
    s = { spr, on: false }; sparks.push(s);
  }
  s.on = true; s.x = x; s.y = y; s.vx = vx; s.vy = vy; s.life = s.max = life; s.sc = sc; s.g = grav || 0; s.spr.tint = tint; s.spr.visible = true;
}
function burst(x, y, n, tint, speed, life, sc) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, v = speed * (.35 + Math.random() * .65);
    spark(x, y, Math.cos(a) * v, Math.sin(a) * v - speed * .25, life * (.6 + Math.random() * .6), sc * (.6 + Math.random() * .7), tint, 160);
  }
}
function updateSparks(dt) {
  for (const s of sparks) {
    if (!s.on) continue;
    s.life -= dt; if (s.life <= 0) { s.on = false; s.spr.visible = false; continue; }
    s.vy += s.g * dt; s.x += s.vx * dt; s.y += s.vy * dt;
    const a = s.life / s.max; s.spr.position.set(s.x, s.y); s.spr.alpha = a; s.spr.scale.set(s.sc * (.4 + a * .6));
  }
}
let dmgFont = false;
try {
  PIXI.BitmapFont.from('umbraDmg', { fontFamily: 'IM Fell English, Georgia, serif', fontSize: 26, fontWeight: 'bold', fill: 0xffffff, stroke: 0x1a0c1c, strokeThickness: 5, lineJoin: 'round' }, { chars: '0123456789-+', resolution: 2 });
  dmgFont = true;
} catch (e) { console.warn('Fonte de dano indisponível:', e); }
const floats = [];
function floatText(txt, x, y, tint, scale) {
  if (!dmgFont) return;
  let f = floats.find(q => !q.on);
  if (!f) {
    if (floats.length >= 30) return;
    const bt = new PIXI.BitmapText('0', { fontName: 'umbraDmg', fontSize: 20, align: 'center' }); bt.anchor.set(.5); fxWorld.addChild(bt);
    f = { bt, on: false }; floats.push(f);
  }
  f.on = true; f.bt.text = txt; f.bt.tint = tint; f.sc = scale || 1; f.bt.scale.set(f.sc); f.x = x; f.y = y; f.life = f.max = .9; f.bt.visible = true;
}
function updateFloats(dt) {
  for (const f of floats) {
    if (!f.on) continue;
    f.life -= dt; if (f.life <= 0) { f.on = false; f.bt.visible = false; continue; }
    f.y -= 42 * dt; const a = f.life / f.max;
    f.bt.position.set(f.x, f.y); f.bt.alpha = Math.min(1, a * 2.2); f.bt.scale.set(f.sc * (1 + (1 - a) * .15));
  }
}

/* ---------- 5) Entidades (jogadores e monstros) ---------- */
const G = fn => { const g = new PIXI.Graphics(); fn(g); return g; };
const NAME_STYLE = { fontFamily: 'Alegreya Sans, system-ui, sans-serif', fontSize: 13, fontWeight: '700', fill: 0xf5f0ff, stroke: 0x070a0d, strokeThickness: 3, lineJoin: 'round' };
const pEnt = new Map(), mEnt = new Map();

function createHero(p) {
  const col = hexNum(p.color);
  const root = new PIXI.Container();
  const shadow = new PIXI.Sprite(T.shadow); shadow.anchor.set(.5); shadow.width = 44; shadow.height = 18; shadow.y = 11;
  const aura = new PIXI.Sprite(T.glow); aura.anchor.set(.5); aura.blendMode = BM.ADD; aura.tint = col; aura.alpha = .2; aura.scale.set(.55); aura.y = -6;
  const rot = new PIXI.Container();
  const boot = () => G(g => { g.beginFill(0x2a2038); g.drawEllipse(0, 0, 4, 6); g.endFill(); });
  const bootL = boot(), bootR = boot(); bootL.x = -5; bootR.x = 5;
  const cloak = G(g => {
    g.beginFill(0x201b31); g.moveTo(-9, -13); g.quadraticCurveTo(-17, -2, -13, 8); g.lineTo(-7, 12); g.lineTo(0, 8); g.lineTo(7, 12); g.lineTo(14, 7); g.quadraticCurveTo(16, -3, 9, -13); g.closePath(); g.endFill();
    g.beginFill(col); g.moveTo(-8, -12); g.quadraticCurveTo(-13, -1, -9, 6); g.lineTo(0, 9); g.lineTo(8, 6); g.quadraticCurveTo(13, -1, 8, -12); g.closePath(); g.endFill();
    g.lineStyle(1.2, 0xf2daff, .75); g.moveTo(-8, 2); g.quadraticCurveTo(0, 7, 8, 2);
  });
  const hood = G(g => {
    g.beginFill(0x2b213a); g.drawEllipse(0, -13, 10, 11); g.endFill();
    g.beginFill(0xbca4a0); g.drawEllipse(0, -12, 6.5, 7.5); g.endFill();
    g.beginFill(0x171627); g.moveTo(-8, -17); g.arc(0, -17, 8, Math.PI, Math.PI * 2); g.lineTo(7, -10); g.quadraticCurveTo(0, -14, -7, -10); g.closePath(); g.endFill();
    g.beginFill(0xbaf6e5); g.drawRect(-3, -12, 2, 2); g.drawRect(1, -12, 2, 2); g.endFill();
    g.beginFill(0xe4c987); g.drawCircle(-7, -6, 2); g.endFill();
  });
  const slash = G(g => { g.lineStyle(3, 0xd8fff2, 1); g.arc(0, 0, 21, Math.PI * 1.12, Math.PI * 1.88); g.lineStyle(1, 0xa2dfff, 1); g.arc(0, 0, 26, Math.PI * 1.15, Math.PI * 1.85); });
  slash.y = -17; slash.blendMode = BM.ADD; slash.visible = false;
  const ring = G(g => { g.lineStyle(1.5, 0xc7f9e6, .75); g.drawEllipse(0, -3, 19, 21); }); ring.visible = false;
  rot.addChild(ring, bootL, bootR, cloak, hood, slash);
  const nameText = new PIXI.Text(p.name || 'Exilado', NAME_STYLE); nameText.anchor.set(.5, 1); nameText.y = -36; nameText.resolution = 2;
  const afkText = new PIXI.Text('✦ auto-farm', { ...NAME_STYLE, fontSize: 11, fill: 0xb8f4da }); afkText.anchor.set(.5, 0); afkText.y = 24; afkText.resolution = 2; afkText.visible = false;
  root.addChild(shadow, aura, rot, nameText, afkText);
  ySort.addChild(root);
  return { root, rot, bootL, bootR, slash, ring, nameText, afkText, name: p.name, col, vx: p.x, vy: p.y, px: p.x, py: p.y, ang: 0, walk: 0, phase: Math.random() * 6, seed: Math.random() * 6, atk: 0 };
}
function updateHero(ent, p, dt, now, t, isMe) {
  const dist = Math.hypot(p.x - ent.vx, p.y - ent.vy);
  if (dist > 260) { ent.vx = p.x; ent.vy = p.y; } else { const k = 1 - Math.exp(-dt * (isMe ? 18 : 11)); ent.vx += (p.x - ent.vx) * k; ent.vy += (p.y - ent.vy) * k; }
  const mx = ent.vx - ent.px, my = ent.vy - ent.py, sp = Math.hypot(mx, my) / Math.max(dt, .001);
  ent.px = ent.vx; ent.py = ent.vy;
  ent.walk += ((sp > 16 ? 1 : 0) - ent.walk) * Math.min(1, dt * 12);
  let target = null;
  if (sp > 24) target = Math.atan2(mx, -my); else if (p.faceX || p.faceY) target = Math.atan2(p.faceX, -p.faceY);
  if (target !== null) { let d = target - ent.ang; d = Math.atan2(Math.sin(d), Math.cos(d)); ent.ang += d * Math.min(1, dt * 14); }
  ent.rot.rotation = ent.ang;
  ent.phase += dt * Math.min(sp, 260) * .055;
  const step = Math.sin(ent.phase) * 3 * ent.walk + Math.sin(t * 3 + ent.seed) * .7 * (1 - ent.walk);
  ent.bootL.y = 7 + step; ent.bootR.y = 7 - step;
  const bob = (1 - ent.walk) * Math.sin(t * 4 + ent.seed) - ent.walk * Math.abs(Math.sin(ent.phase)) * 1.4;
  ent.root.position.set(ent.vx, ent.vy + bob);
  const z = Math.round(ent.vy) + 11; if (ent.root.zIndex !== z) ent.root.zIndex = z;
  if (now < ent.atk) { const a = (ent.atk - now) / 230; ent.slash.visible = true; ent.slash.alpha = a; ent.slash.scale.set(1 + (1 - a) * .3); } else ent.slash.visible = false;
  ent.ring.visible = isMe;
  if (ent.name !== p.name) { ent.name = p.name; ent.nameText.text = p.name || 'Exilado'; }
  ent.afkText.visible = !!p.afk;
  const flick = 1 + Math.sin(t * 7 + ent.seed) * .018 + Math.sin(t * 13.3) * .012;
  addLight(ent.vx, ent.vy - 6, (isMe ? 230 : 140) * flick, isMe ? 0xffdfa6 : ent.col, isMe ? .95 : .6);
}
function destroyEnt(ent) { ent.root.parent && ent.root.parent.removeChild(ent.root); ent.root.destroy({ children: true }); }

function createMonster(m) {
  const wraith = m.kind === 'wraith';
  const root = new PIXI.Container(), body = new PIXI.Container();
  const shadow = new PIXI.Sprite(T.shadow); shadow.anchor.set(.5); shadow.width = 40; shadow.height = 17; shadow.y = 13;
  const glow = new PIXI.Sprite(T.glow); glow.anchor.set(.5); glow.blendMode = BM.ADD; glow.tint = wraith ? 0xb66cff : 0xff6a80; glow.alpha = wraith ? .4 : .2; glow.scale.set(wraith ? .75 : .5);
  const shape = wraith ? G(g => {
    g.beginFill(0x695087); g.moveTo(0, -22); g.quadraticCurveTo(24, -4, 15, 17); g.lineTo(3, 10); g.lineTo(-8, 19); g.quadraticCurveTo(-23, -2, 0, -22); g.closePath(); g.endFill();
    g.beginFill(0x8a6aae, .55); g.moveTo(0, -18); g.quadraticCurveTo(14, -4, 9, 10); g.lineTo(0, 5); g.lineTo(-6, 12); g.quadraticCurveTo(-14, -3, 0, -18); g.closePath(); g.endFill();
    g.beginFill(0xf1d4ff); g.drawRect(-5, -4, 3, 3); g.drawRect(3, -4, 3, 3); g.endFill();
  }) : G(g => {
    g.beginFill(0x776052); g.drawEllipse(0, 0, 14, 17); g.endFill();
    g.beginFill(0x907867, .55); g.drawEllipse(-3, -6, 8, 9); g.endFill();
    g.beginFill(0x40303a); g.moveTo(-9, -9); g.lineTo(-16, -24); g.lineTo(-3, -14); g.closePath(); g.endFill();
    g.beginFill(0x40303a); g.moveTo(8, -9); g.lineTo(16, -24); g.lineTo(3, -14); g.closePath(); g.endFill();
    g.beginFill(0xff8194); g.drawRect(-5, -4, 3, 3); g.drawRect(3, -4, 3, 3); g.endFill();
  });
  const flash = new PIXI.Sprite(T.glow); flash.anchor.set(.5); flash.blendMode = BM.ADD; flash.tint = 0xffb0c0; flash.alpha = 0; flash.scale.set(.45);
  body.addChild(shape, flash);
  const hpRoot = new PIXI.Container(); hpRoot.visible = false;
  const hpBg = new PIXI.Sprite(PIXI.Texture.WHITE); hpBg.tint = 0x15121c; hpBg.width = 32; hpBg.height = 5; hpBg.position.set(-16, -34);
  const hpFill = new PIXI.Sprite(PIXI.Texture.WHITE); hpFill.tint = 0xe46b91; hpFill.width = 30; hpFill.height = 3; hpFill.position.set(-15, -33);
  hpRoot.addChild(hpBg, hpFill);
  root.addChild(shadow, glow, body, hpRoot); ySort.addChild(root);
  return { root, body, glow, flash, hpRoot, hpFill, wraith, vx: m.x, vy: m.y, px: m.x, py: m.y, pop: 0, flip: 1, hp: -1, dying: 0 };
}
function updateMonster(ent, m, dt, t) {
  if (Math.hypot(m.x - ent.vx, m.y - ent.vy) > 200) { ent.vx = m.x; ent.vy = m.y; } else { const k = 1 - Math.exp(-dt * 9); ent.vx += (m.x - ent.vx) * k; ent.vy += (m.y - ent.vy) * k; }
  const mx = ent.vx - ent.px; ent.px = ent.vx; ent.py = ent.vy;
  if (Math.abs(mx) > .15) ent.flip = mx > 0 ? 1 : -1;
  ent.pop = Math.max(0, ent.pop - dt * 5);
  const sc = 1 + ent.pop * .18, flutter = ent.wraith ? 1 + Math.sin(t * 5 + m.id) * .04 : 1;
  ent.body.scale.set(sc * flutter * ent.flip, sc); ent.body.y = Math.sin(t * 3.8 + m.id) * 3;
  ent.flash.alpha = ent.pop * .8;
  if (ent.hp !== m.hp) { ent.hp = m.hp; ent.hpFill.width = 30 * clamp(m.hp / m.maxHp, 0, 1); ent.hpRoot.visible = m.hp < m.maxHp; }
  ent.root.position.set(ent.vx, ent.vy);
  const z = Math.round(ent.vy) + 13; if (ent.root.zIndex !== z) ent.root.zIndex = z;
  ent.glow.alpha = (ent.wraith ? .38 : .18) * (.8 + .2 * Math.sin(t * 2.4 + m.id));
  addLight(ent.vx, ent.vy, ent.wraith ? 95 : 55, ent.wraith ? 0xa060ff : 0xff5070, ent.wraith ? .6 : .28);
}
const markAttack = id => { const e = pEnt.get(id); if (e) e.atk = performance.now() + 230; };
function onMonsterHit(d) {
  const m = mData.get(d.id); if (m) m.hp = d.hp;
  const e = mEnt.get(d.id); if (e) e.pop = 1;
  floatText('-' + d.damage, d.x, d.y - 24, 0xff9aab, 1);
  burst(d.x, d.y - 10, 9, 0xff7a9a, 130, .45, .7);
  markAttack(d.attacker);
}
function onMonsterDied(d) {
  const e = mEnt.get(d.id); if (e && !e.dying) e.dying = .4;
  mData.delete(d.id);
  burst(d.x, d.y - 8, 24, 0xf3cf79, 170, .8, .9);
  burst(d.x, d.y - 8, 12, 0xb98cff, 95, .7, 1.1);
}

/* ---------- 6) Loop de render ---------- */
function resizeView() {
  const r = canvas.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return;
  VW = r.width; VH = r.height;
  app.renderer.resize(VW, VH);
  const lw = Math.max(2, Math.ceil(VW * Q.light)), lh = Math.max(2, Math.ceil(VH * Q.light));
  lightRT.resize(lw, lh); lightBg.width = lw; lightBg.height = lh;
  lightSprite.width = VW; lightSprite.height = VH;
  vignette.width = VW; vignette.height = VH; flash.width = VW; flash.height = VH;
}
new ResizeObserver(resizeView).observe(canvas); resizeView();

function applyQuality(l) {
  qLevel = l; Q = LEVELS[l];
  try { app.renderer.resolution = Q.res; } catch (e) { /* mantém a resolução atual */ }
  resizeView();
  for (const o of decorObjs) { if (o.kind === 'mush' && o.glow) o.glow.visible = o.v && Q.fancy; if (!Q.fancy && o.kind === 'tree') o.sp.rotation = 0; }
}
if (qLevel !== 0) applyQuality(qLevel);

const mm = $('minimap'), mmc = mm.getContext('2d');
const mmBg = (() => {
  const c = mk(140, 105), g = c.getContext('2d'), sx = 140 / 2400, sy = 105 / 1800;
  g.fillStyle = '#12261f'; g.fillRect(0, 0, 140, 105);
  for (const d of decor) {
    if (d.type < .19) g.fillStyle = '#1d4a3a'; else if (d.type < .31) g.fillStyle = '#4a534f'; else if (d.type < .42) g.fillStyle = d.h < 180 ? '#5fe0cf' : '#a58aff'; else continue;
    g.fillRect(d.x * sx, d.y * sy, 1.5, 1.5);
  }
  return c;
})();
function drawMinimap() {
  const sx = 140 / world.width, sy = 105 / world.height;
  mmc.drawImage(mmBg, 0, 0);
  mmc.fillStyle = '#f27e9a'; for (const m of mData.values()) mmc.fillRect(m.x * sx - 1, m.y * sy - 1, 3, 3);
  for (const [id, p] of players) { mmc.fillStyle = id === selfId ? '#f0c987' : '#8ce5d0'; mmc.beginPath(); mmc.arc(p.x * sx, p.y * sy, id === selfId ? 3 : 2.2, 0, TAU); mmc.fill(); }
  mmc.strokeStyle = 'rgba(235,229,214,.55)'; mmc.lineWidth = 1; mmc.strokeRect(cam.x * sx, cam.y * sy, VW * sx, VH * sy);
}

let mmTimer = 0, fpsFrames = 0, fpsTime = 0, slowChecks = 0, warm = 4;
const fpsEl = $('fps');
function update(dt) {
  const now = performance.now(), t = now / 1000;

  // jogadores
  for (const [id, p] of players) {
    let ent = pEnt.get(id); if (!ent) { ent = createHero(p); pEnt.set(id, ent); }
    updateHero(ent, p, dt, now, t, id === selfId);
  }
  for (const [id, ent] of pEnt) if (!players.has(id)) { destroyEnt(ent); pEnt.delete(id); }
  // monstros
  for (const [id, m] of mData) {
    let ent = mEnt.get(id); if (!ent) { ent = createMonster(m); mEnt.set(id, ent); }
    updateMonster(ent, m, dt, t);
  }
  for (const [id, ent] of mEnt) {
    if (!mData.has(id) && !ent.dying) ent.dying = .4;
    if (ent.dying) {
      ent.dying -= dt; const a = Math.max(0, ent.dying / .4);
      ent.root.alpha = a; ent.body.scale.set((1 + (1 - a) * .5) * ent.flip, 1 + (1 - a) * .5);
      if (ent.dying <= 0) { destroyEnt(ent); mEnt.delete(id); }
    }
  }

  // câmera: segue o jogador, presa às bordas do mundo (chão e objetos usam a mesma câmera)
  const se = pEnt.get(selfId), sx = se ? se.vx : me.x, sy = se ? se.vy : me.y;
  const tx = world.width <= VW ? (world.width - VW) / 2 : clamp(sx - VW / 2, 0, world.width - VW);
  const ty = world.height <= VH ? (world.height - VH) / 2 : clamp(sy - VH / 2, 0, world.height - VH);
  if (!cam.init) { cam.x = tx; cam.y = ty; cam.init = true; } else { const k = 1 - Math.exp(-dt * 9); cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k; }
  cam.x = Math.round(cam.x * Q.res) / Q.res; cam.y = Math.round(cam.y * Q.res) / Q.res;
  worldC.position.set(-cam.x, -cam.y);

  // decoração: só o que está na tela é desenhado/animado
  const x0 = cam.x - 100, x1 = cam.x + VW + 100, y0 = cam.y - 150, y1 = cam.y + VH + 100;
  const wind = { storm: 3, rain: 1.6, fog: .4, snow: .7, sunny: .8 }[weather.type] || 1;
  let cl = 0;
  for (const o of decorObjs) {
    const vis = o.x > x0 && o.x < x1 && o.y > y0 && o.y < y1;
    if (vis !== o.v) { o.v = vis; o.sp.visible = vis; if (o.glow) o.glow.visible = vis && (o.kind === 'crystal' || Q.fancy); }
    if (!vis) continue;
    if (o.kind === 'tree') { if (Q.fancy) o.sp.rotation = Math.sin(t * 1.2 + o.phase) * .018 * wind; }
    else if (o.glow && o.glow.visible) {
      const pu = .75 + .25 * Math.sin(t * 1.7 + o.phase * 3);
      o.glow.alpha = o.glowBase * pu;
      if (o.kind === 'crystal' && cl < 26) { addLight(o.x, o.y - o.s * .4, o.s * 5 + 30, o.tint, .8 * pu); cl++; }
    }
  }

  updateSparks(dt); updateFloats(dt); updateWeather(dt, t);
  flushLights();
  app.renderer.render(lightC, { renderTexture: lightRT, clear: true });

  // minimapa a 10 Hz
  mmTimer += dt; if (mmTimer > .1) { mmTimer = 0; drawMinimap(); }

  // FPS + qualidade adaptativa (só desce; evita oscilar)
  fpsFrames++; fpsTime += dt;
  if (fpsTime >= 2.5) {
    const fps = fpsFrames / fpsTime; fpsFrames = 0; fpsTime = 0;
    if (fpsEl.style.display === 'block') fpsEl.textContent = Math.round(fps) + ' FPS · qualidade ' + (3 - qLevel) + '/3';
    if (warm > 0) warm -= 2.5; else if (!document.hidden && fps < 45) { if (++slowChecks >= 2 && qLevel < LEVELS.length - 1) { applyQuality(qLevel + 1); slowChecks = 0; warm = 2.5; } } else slowChecks = 0;
  }
}
app.ticker.add(() => update(Math.min(app.ticker.deltaMS / 1000, .1)));

/* ---------- 7) Rede, interface, entrada e login ---------- */
const socket = io({ autoConnect: false, transports: ['websocket'] });
const keys = {};
let lastAttackSent = 0;

function log(s, c = '') {
  const box = $('log'), p = document.createElement('p'); p.textContent = s; if (c) p.className = c;
  box.prepend(p); while (box.children.length > 30) box.lastChild.remove();
}

// DOM só é tocado quando o valor muda (o servidor atualiza 10x/s, o movimento até 30x/s)
const uiCache = {};
function setText(id, v) { v = String(v); if (uiCache[id] !== v) { uiCache[id] = v; $(id).textContent = v; } }
function setWidth(id, pct) { const v = pct.toFixed(1) + '%'; if (uiCache[id] !== v) { uiCache[id] = v; $(id).style.width = v; } }
let inventoryRenderKey = '';
function renderInventory() {
  const list = $('inventoryList'); if (!list) return;
  const items = Array.isArray(me.inventory) ? me.inventory : [];
  const key = items.map(i => (i.id || '') + ':' + (i.quantity || 1) + ':' + (i.name || '') + ':' + (i.icon || '')).join('|');
  if (key === inventoryRenderKey) return;
  inventoryRenderKey = key; list.replaceChildren();
  if (!items.length) { const e = document.createElement('p'); e.className = 'inventory-empty'; e.textContent = 'Inventário vazio. Derrote criaturas para encontrar itens.'; list.appendChild(e); return; }
  for (const item of items) {
    const card = document.createElement('div'); card.className = 'inventory-item';
    const icon = document.createElement('span'); icon.className = 'inventory-icon'; icon.textContent = item.icon || '📦';
    const name = document.createElement('span'); name.className = 'inventory-name'; name.textContent = item.name || item.id || 'Item';
    const qty = document.createElement('span'); qty.className = 'inventory-qty'; qty.textContent = '×' + (item.quantity || 1);
    card.append(icon, name, qty);
    const usable = item.id === 'minor-potion';
    const use = document.createElement('button'); use.className = 'inventory-use'; use.textContent = usable ? '🧪 Usar poção' : '📦 Material (não utilizável)';
    use.disabled = !usable; use.title = usable ? 'Recupera vida' : 'Este material ainda não tem uso no beta';
    if (usable) use.onclick = () => socket.emit('useItem', item.id);
    card.appendChild(use); list.appendChild(card);
  }
}
function ui() {
  renderInventory();
  const name = me.name || 'Exilado', maxHp = me.maxHp || 100, nextXp = me.nextXp || 50;
  setText('heroName', name); setText('sideName', name);
  setText('topLevel', me.level || 1); setText('topGold', me.gold || 0); setText('topKills', me.kills || 0);
  setText('hpText', Math.ceil(me.hp || 0) + ' / ' + maxHp); setWidth('hpBar', clamp((me.hp || 0) / maxHp, 0, 1) * 100);
  setText('xpText', (me.xp || 0) + ' / ' + nextXp); setWidth('xpBar', clamp((me.xp || 0) / nextXp, 0, 1) * 100);
  setText('attackStat', me.attack || 12); setText('killStat', me.kills || 0); setText('playersStat', players.size || 1);
  setText('classTag', 'Nível ' + (me.level || 1));
  setText('afkBtn', me.afk ? '☾ Farm AFK: ON' : '☾ Farm AFK: OFF'); $('afkBtn').classList.toggle('active', !!me.afk);
}

const weatherInfo = {
  clear: { label: 'Tempo ameno', icon: '☁', desc: 'A névoa se abre entre as ruínas.' },
  sunny: { label: 'Sol entre as ruínas', icon: '☀', desc: 'Uma luz dourada atravessa as copas.' },
  rain:  { label: 'Chuva', icon: '🌧', desc: 'A chuva tamborila nas pedras antigas.' },
  storm: { label: 'Tempestade', icon: '⛈', desc: 'Trovões ecoam além do Véu.' },
  snow:  { label: 'Neve', icon: '❄', desc: 'Flocos silenciosos cobrem o caminho.' },
  fog:   { label: 'Névoa densa', icon: '🌫', desc: 'A névoa esconde o que se move adiante.' }
};
function setWeather(w) {
  if (!w) return;
  const changed = weather.type !== w.type; weather = { ...w };
  const info = weatherInfo[weather.type] || weatherInfo.clear;
  $('weatherTag').textContent = info.icon + ' Clima: ' + info.label;
  if (changed) log(info.desc, 'gold');
}

// ---- eventos do servidor ----
function syncPlayers(list) {
  const seen = new Set();
  for (const inc of list || []) { seen.add(inc.id); const cur = players.get(inc.id); if (cur) Object.assign(cur, inc); else players.set(inc.id, { ...inc }); }
  for (const id of [...players.keys()]) if (!seen.has(id)) players.delete(id);
}
function syncMonsters(list) {
  const seen = new Set();
  for (const inc of list || []) { seen.add(inc.id); const cur = mData.get(inc.id); if (cur) Object.assign(cur, inc); else mData.set(inc.id, { ...inc }); }
  for (const id of [...mData.keys()]) if (!seen.has(id)) mData.delete(id);
}
function mergeSelf() {
  const p = players.get(selfId);
  if (p) me = { ...me, x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp, level: p.level, afk: p.afk, name: p.name || me.name };
}

socket.on('connect', () => { $('connection').textContent = 'Conectado'; $('onlineTag').textContent = '● Servidor conectado'; $('onlineTag').classList.remove('off'); });
socket.on('disconnect', () => { $('connection').textContent = 'Desconectado'; $('onlineTag').textContent = '● Conexão perdida'; $('onlineTag').classList.add('off'); log('Conexão com o servidor perdida.', 'bad'); });
socket.on('welcome', d => {
  selfId = d.selfId; world = d.world || world;
  me = { ...me, ...d.player }; inventoryRenderKey = '';
  $('authScreen').style.display = 'none';
  log('Você entrou no mundo de Umbra.', 'good'); ui();
});
socket.on('worldState', d => { syncPlayers(d.players); syncMonsters(d.monsters); if (d.weather) setWeather(d.weather); mergeSelf(); ui(); });
socket.on('worldTick', d => { syncPlayers(d.players); syncMonsters(d.monsters); mergeSelf(); ui(); });
socket.on('playerJoined', p => { players.set(p.id, { ...p }); log(p.name + ' entrou no mundo.', 'gold'); });
socket.on('playerLeft', id => { const p = players.get(id); if (p) log(p.name + ' saiu do mundo.'); players.delete(id); });
socket.on('selfUpdate', p => {
  me = { ...me, ...p };
  const cur = players.get(selfId); if (cur) { cur.x = p.x; cur.y = p.y; cur.faceX = p.faceX; cur.faceY = p.faceY; }
  ui();
});
socket.on('inventoryUpdate', inv => { me.inventory = Array.isArray(inv) ? inv : []; ui(); });
socket.on('weatherChanged', setWeather);
socket.on('notice', s => log(s, 'gold'));
socket.on('monsterHit', onMonsterHit);
socket.on('monsterDied', d => {
  onMonsterDied(d);
  if (d.by === me.name) log('Criatura derrotada! Gold e experiência recebidos.', 'good'); else log(d.by + ' derrotou uma criatura.', 'gold');
});
socket.on('itemUsed', d => { me.hp = d.hp; me.inventory = d.inventory; inventoryRenderKey = ''; ui(); log(d.message); });
socket.on('characterRenamed', d => { me.name = d.name; ui(); $('renameSave').disabled = false; $('renameModal').classList.remove('open'); $('renameMessage').textContent = 'Nome atualizado!'; log('Seu personagem agora se chama ' + d.name + '.'); });
socket.on('renameError', m => { $('renameSave').disabled = false; $('renameMessage').textContent = m; });
socket.on('connect_error', e => { $('authScreen').style.display = 'flex'; $('authMessage').textContent = e.message || 'Falha ao conectar.'; });

// ---- entrada ----
const typing = e => /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '');
function attack(monsterId) {
  const now = performance.now(); if (now - lastAttackSent < 140) return; lastAttackSent = now;
  markAttack(selfId); socket.emit('attack', monsterId == null ? undefined : monsterId);
}
function toggleAfk() { me.afk = !me.afk; socket.emit('toggleAfk', me.afk); ui(); }
window.addEventListener('keydown', e => {
  if (e.key === 'F3') { e.preventDefault(); fpsEl.style.display = fpsEl.style.display === 'block' ? 'none' : 'block'; return; }
  if (typing(e) || $('authScreen').style.display !== 'none' && getComputedStyle($('authScreen')).display !== 'none') return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key; keys[k] = true;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  if (e.code === 'Space') attack();
  if (k === 'e' && !e.repeat) toggleAfk();
});
window.addEventListener('keyup', e => { const k = e.key.length === 1 ? e.key.toLowerCase() : e.key; keys[k] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });   // evita personagem "preso" andando
canvas.addEventListener('pointerdown', e => {
  const r = canvas.getBoundingClientRect(), tx = cam.x + (e.clientX - r.left), ty = cam.y + (e.clientY - r.top);
  let best = null, bd = 45;
  for (const [id, ent] of mEnt) { if (ent.dying) continue; const d = Math.hypot(ent.vx - tx, ent.vy - ty); if (d < bd) { bd = d; best = id; } }
  attack(best);
});
// movimento em ritmo fixo (independente do FPS) — o servidor aceita ~1 passo a cada 32 ms
setInterval(() => {
  if (document.hidden || !socket.connected) return;
  let dx = 0, dy = 0;
  if (keys.w || keys.ArrowUp) dy--; if (keys.s || keys.ArrowDown) dy++;
  if (keys.a || keys.ArrowLeft) dx--; if (keys.d || keys.ArrowRight) dx++;
  if (dx || dy) socket.emit('move', { dx, dy });
}, 33);

$('attackBtn').onclick = () => attack();
$('afkBtn').onclick = toggleAfk;
function openProfile() {
  $('profileName').textContent = me.name || 'Exilado'; $('profileLevel').textContent = me.level || 1; $('profileGold').textContent = me.gold || 0;
  $('profileKills').textContent = me.kills || 0; $('profileXp').textContent = (me.xp || 0) + ' / ' + (me.nextXp || 50); $('profileAttack').textContent = me.attack || 12;
  $('profileModal').classList.add('open');
}
function openRename() {
  $('renameInput').value = me.name || ''; $('renameMessage').textContent = '';
  $('profileModal').classList.remove('open'); $('renameModal').classList.add('open'); $('renameInput').focus();
}
$('profileBtn').onclick = openProfile; $('profileClose').onclick = () => $('profileModal').classList.remove('open');
$('profileRename').onclick = openRename; $('renameBtn').onclick = openRename; $('renameCancel').onclick = () => $('renameModal').classList.remove('open');
$('profileModal').addEventListener('click', e => { if (e.target === $('profileModal')) $('profileModal').classList.remove('open'); });
$('renameModal').addEventListener('click', e => { if (e.target === $('renameModal')) $('renameModal').classList.remove('open'); });
$('renameSave').onclick = () => {
  const name = $('renameInput').value.trim();
  if (!/^[\p{L}0-9 _-]{3,18}$/u.test(name)) { $('renameMessage').textContent = 'Nome inválido. Use 3 a 18 caracteres.'; return; }
  $('renameSave').disabled = true; $('renameMessage').textContent = 'Salvando...'; socket.emit('renameCharacter', name);
};
$('renameInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('renameSave').click(); if (e.key === 'Escape') $('renameModal').classList.remove('open'); });

// ---- login (Supabase) ----
async function connectWithSession(session) {
  if (!session) return;
  socket.auth = { token: session.access_token };
  if (!socket.connected) socket.connect();
}
$('loginBtn').onclick = async () => {
  $('authMessage').textContent = 'Entrando...';
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email: $('authEmail').value.trim(), password: $('authPassword').value });
  if (error) { $('authMessage').textContent = error.message; return; }
  await connectWithSession(data.session);
};
$('registerBtn').onclick = async () => {
  $('authMessage').textContent = 'Criando conta...';
  const { data, error } = await supabaseClient.auth.signUp({ email: $('authEmail').value.trim(), password: $('authPassword').value });
  if (error) { $('authMessage').textContent = error.message; return; }
  if (data.session) await connectWithSession(data.session);
  else $('authMessage').textContent = 'Conta criada! Confira seu e-mail para confirmar o cadastro.';
};
['authEmail', 'authPassword'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') $('loginBtn').click(); }));
(async () => {
  const { data } = await supabaseClient.auth.getSession();
  if (data.session) await connectWithSession(data.session);
})();
ui();
})();
