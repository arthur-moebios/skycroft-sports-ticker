/* ===== Skycroft Ticker — servidor do dispositivo =====
 * - Coleta NFL/NBA da ESPN (cache + cadência ao vivo 30s / senão 120s)
 * - Empurra atualizações ao vivo p/ a TV e o controle via SSE (sem libs)
 * - Guarda o estado de controle (favoritos, mostrador fixo, ligas) em disco
 * - Serve o display (TV) em /  e o controle remoto PWA em /remote
 *
 * Node >= 18 (fetch nativo). Zero dependências externas.
 */

const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { fetchLeagues, hasLive, catalogMeta, BY_ID } = require("./espn");
const net = require("./net");

// Presets de tema e opções de UI aceitas (validação do /api/control).
const THEME_IDS = ["midnight", "gridiron", "hardwood", "arena", "broadcast", "stars"];
const DENSITIES = ["compact", "comfortable", "spacious"];
const FONTS = ["system", "condensed", "sport"];
const DETAILS = ["score", "rich"];
const SIDES = ["left", "right"];

const PORT = process.env.PORT || 8099;
const ROOT = path.join(__dirname, "..");
const DISPLAY_DIR = path.join(ROOT, "display");
const REMOTE_DIR = path.join(ROOT, "remote");
const SETUP_DIR = path.join(ROOT, "setup");
const STATE_FILE = process.env.SKYCROFT_STATE_FILE || path.join(__dirname, "control-state.json");

const KEY_FILE = process.env.SKYCROFT_KEY_FILE || path.join(__dirname, "remote-key");
// Endereço público do controle (QR da TV). Sem a variável, remoteBase() deduz do pedido ou da LAN.
const BASE = (process.env.SKYCROFT_REMOTE_BASE || "").replace(/\/+$/, "");
// Pareamento por QR desligado por padrao: o que o aparelho serve e placar de
// jogo, que e publico. O que a chave protegia era escrita (trocar o display,
// as ligas, forcar recoleta), nao leitura. SKYCROFT_REQUIRE_KEY=1 religa.
const REQUIRE_KEY = process.env.SKYCROFT_REQUIRE_KEY === "1";

const LIVE_MS = 30_000;   // há jogo ao vivo
const IDLE_MS = 120_000;  // nenhum jogo ao vivo

/* ---------- estado ---------- */
const defaultUi = {
  theme: "midnight",        // preset de cor/modo (ver THEME_IDS)
  density: "comfortable",   // compact | comfortable | spacious (tamanho dos cards)
  font: "system",           // system | condensed | sport
  fontScale: 1,             // 0.8 .. 1.4 (escala global do texto)
  detail: "rich",           // score (só placar) | rich (mais detalhes)
  listCount: 4,             // quantos jogos na lista lateral (0..6)
  showTicker: true,         // mostra a faixa rolante
  showClock: true,          // mostra o relógio
  showFeaturedStats: true,  // estatísticas do jogo em destaque
  sidePos: "right",         // lado da lista: right | left
};
const defaultControl = {
  favorites: ["NE", "BOS"], // Patriots + Celtics
  mode: "auto",             // "auto" (ao vivo tem prioridade) | "fixed" (evento fixado)
  fixedEventId: null,
  enabledLeagues: ["NFL", "NBA"],
  // sem `ui` aqui: a aparência vive só em displays[i].ui (ver activeDisplay())
};

/* ---------- displays (layouts) ---------- */
const BLOCK_TYPES = ["spotlight", "mosaic", "list", "ticker", "clock", "brand"];
const GAME_STATES = ["in", "pre", "post"];
const GRID = { cols: 12, rows: 8 };   // palco 1920x1080 fixo na TV
const MAX_DISPLAYS = 12;
const MAX_BLOCKS = 10;
const OPT_BOOLS = ["showScore", "showClock", "showLogo", "showOdds",
  "showRecord", "showTopScorers", "showLinescore", "showWinProb", "showSituation", "holdOnScore"];
// Recursos novos do Destaque nascem DESLIGADOS; showRecord e showTopScorers nascem ligados.
const defaultOpts = { cols: 2, showScore: true, showClock: true, showLogo: true, showOdds: false,
  showRecord: true, showTopScorers: true, showLinescore: false, showWinProb: false, showSituation: false, holdOnScore: false };
const defaultFilters = () => ({ leagues: [], states: [...GAME_STATES], favoritesOnly: false });
const blk = (id, type, x, y, w, h, opts = {}, filters = {}) =>
  ({ id, type, x, y, w, h, opts: { ...defaultOpts, ...opts }, filters: { ...defaultFilters(), ...filters } });

function builtinDisplays(ui) {
  return [
    { // espelha o CSS antigo: topbar (1 linha), .body 1.35fr/1fr (~7/5), ticker (1 linha)
      id: "default", name: "Padrão", builtin: true, grid: { ...GRID },
      blocks: [
        blk("b1", "brand", 0, 0, 6, 1),
        blk("b2", "clock", 6, 0, 6, 1),
        blk("b3", "spotlight", 0, 1, 7, 6),
        blk("b4", "list", 7, 1, 5, 6),
        blk("b5", "ticker", 0, 7, 12, 1),
      ],
      ui: { ...defaultUi, ...ui },
    },
    {
      id: "gameday", name: "Game Day", builtin: true, grid: { ...GRID },
      blocks: [
        blk("b1", "mosaic", 0, 0, 12, 7, {}, { states: ["in", "pre", "post"] }),
        blk("b2", "ticker", 0, 7, 12, 1),
      ],
      ui: { ...defaultUi, ...ui },
    },
  ];
}

let control = loadControl();
let leagues = [];      // dados ESPN mais recentes
let updatedAt = 0;
let lastError = null;

function loadControl() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { /* sem estado salvo */ }
  const { ui: legacyUi, displays: savedDisplays, ...rest } = raw && typeof raw === "object" ? raw : {};
  const c = { ...defaultControl, ...rest };
  delete c.ui; // control.ui legado não é mais estado
  if (Array.isArray(savedDisplays) && savedDisplays.length) {
    // estado novo: sanitiza tudo de novo, o arquivo pode ter sido editado à mão
    const base = builtinDisplays(legacyUi || {});
    const out = [];
    for (const d of savedDisplays) {
      const b = base.find((x) => x.id === (d && d.id));
      const clean = sanitizeDisplay(d, out, b);
      if (clean) out.push(clean);
    }
    for (const b of base) if (!out.some((d) => d.id === b.id)) out.push(b);
    c.displays = out.slice(0, MAX_DISPLAYS);
  } else {
    // migração: o ui legado vira o ui do display "default"
    const legacy = legacyUi && typeof legacyUi === "object" ? legacyUi : {};
    c.displays = builtinDisplays({});
    c.displays[0].ui = sanitizeUi(legacy, { ...defaultUi });
    c.displays[1].ui = { ...defaultUi };
  }
  if (!c.displays.some((d) => d.id === c.activeDisplayId)) c.activeDisplayId = "default";
  return c;
}
function saveControl() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(control, null, 2));
  } catch (e) {
    console.error("[state] não salvou:", e.message);
  }
}

function activeDisplay() {
  return control.displays.find((d) => d.id === control.activeDisplayId) || control.displays[0];
}
// `ui` é derivado do display ativo; display/ e remote/ continuam lendo control.ui sem mudar.
function snapshot() {
  const ui = { ...activeDisplay().ui };
  const { displays, activeDisplayId, ...rest } = control;
  return {
    updatedAt, favorites: control.favorites, control: { ...rest, ui, activeDisplayId },
    ui, displays, activeDisplayId,
    leagues, catalog: catalogMeta(), error: lastError, net: net.readNet(),
  };
}

/* ---------- SSE (push p/ TV e controle) ---------- */
const clients = new Set();
function broadcast() {
  const payload = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { /* ignora socket morto */ }
  }
}

/* ---------- coleta ESPN ---------- */
let pollTimer = null;
async function poll() {
  try {
    leagues = await fetchLeagues(control.enabledLeagues);
    updatedAt = Date.now();
    lastError = null;
  } catch (e) {
    lastError = e.message;
    console.error("[poll]", e.message);
  }
  broadcast();
  const next = hasLive(leagues) ? LIVE_MS : IDLE_MS;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, next);
}

/* ---------- estáticos ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
// Assets de conteudo fixo (fonte, logo, icone) podem ficar em cache por um dia;
// HTML/JS/CSS tem que revalidar sempre, senao um proxy ou o proprio Chromium do
// kiosk continua rodando a versao velha depois de um deploy.
const LONG_CACHE = new Set([".woff2", ".woff", ".ttf", ".png", ".svg", ".ico", ".jpg"]);

function serveFile(res, file, req) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end("404"); }
    const ext = path.extname(file);
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": LONG_CACHE.has(ext) ? "public, max-age=86400" : "no-cache",
      "Last-Modified": st.mtime.toUTCString(),
      ETag: etag,
    };
    // Revalidacao barata: o navegador ja tem o arquivo, so confirma que nao mudou.
    const inm = req && req.headers["if-none-match"];
    if (inm && inm === etag) { res.writeHead(304, headers); return res.end(); }
    fs.readFile(file, (e2, buf) => {
      if (e2) { res.writeHead(404); return res.end("404"); }
      res.writeHead(200, headers);
      res.end(buf);
    });
  });
}
// Impede path traversal e resolve dentro de um diretório base.
function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base) ? p : null;
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

/* ---------- validação de ui / displays ---------- */
function sanitizeUi(u, cur) {
  cur = { ...defaultUi, ...(cur || {}) };
  if (!u || typeof u !== "object") return cur;
  if (THEME_IDS.includes(u.theme)) cur.theme = u.theme;
  if (DENSITIES.includes(u.density)) cur.density = u.density;
  if (FONTS.includes(u.font)) cur.font = u.font;
  if (DETAILS.includes(u.detail)) cur.detail = u.detail;
  if (SIDES.includes(u.sidePos)) cur.sidePos = u.sidePos;
  if (Number.isFinite(u.fontScale)) cur.fontScale = Math.min(1.4, Math.max(0.8, u.fontScale));
  if (Number.isFinite(u.listCount)) cur.listCount = Math.min(6, Math.max(0, Math.round(u.listCount)));
  if (typeof u.showTicker === "boolean") cur.showTicker = u.showTicker;
  if (typeof u.showClock === "boolean") cur.showClock = u.showClock;
  if (typeof u.showFeaturedStats === "boolean") cur.showFeaturedStats = u.showFeaturedStats;
  return cur;
}

function slug(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32); }
// id único: colisão ganha sufixo numérico
function uniqueId(base, list) {
  const b = slug(base) || "display";
  let id = b, n = 2;
  while (list.some((d) => d.id === id)) id = `${b}-${n++}`;
  return id;
}
function cleanName(n, fb) { return String(n == null ? "" : n).trim().slice(0, 40) || fb; }
function clampInt(v, lo, hi) { return Math.min(hi, Math.max(lo, Math.round(v))); }

function sanitizeFilters(f) {
  const out = defaultFilters();
  if (!f || typeof f !== "object") return out;
  if (Array.isArray(f.leagues)) out.leagues = [...new Set(f.leagues.map((s) => String(s).toUpperCase()).filter((s) => BY_ID[s]))];
  if (Array.isArray(f.states)) {
    const st = [...new Set(f.states.filter((s) => GAME_STATES.includes(s)))];
    if (st.length) out.states = st;
  }
  if (typeof f.favoritesOnly === "boolean") out.favoritesOnly = f.favoritesOnly;
  return out;
}
function sanitizeOpts(o) {
  const out = { ...defaultOpts };
  if (!o || typeof o !== "object") return out;
  if (Number.isFinite(o.cols)) out.cols = clampInt(o.cols, 1, 4);
  for (const k of OPT_BOOLS) if (typeof o[k] === "boolean") out[k] = o[k];
  return out;
}
// Bloco inválido vira null (descartado); o resto do patch segue.
function sanitizeBlock(b, grid, taken) {
  if (!b || typeof b !== "object" || !BLOCK_TYPES.includes(b.type)) return null;
  const n = ["x", "y", "w", "h"].map((k) => b[k]);
  if (!n.every(Number.isFinite)) return null;
  const w = clampInt(n[2], 1, grid.cols), h = clampInt(n[3], 1, grid.rows);
  const x = clampInt(n[0], 0, grid.cols - w), y = clampInt(n[1], 0, grid.rows - h);
  let id = slug(b.id) || "b";
  if (taken.has(id)) { let i = 1; while (taken.has(`b${i}`)) i++; id = `b${i}`; }
  taken.add(id);
  return { id, type: b.type, x, y, w, h, opts: sanitizeOpts(b.opts), filters: sanitizeFilters(b.filters) };
}
function sanitizeBlocks(list, grid) {
  if (!Array.isArray(list)) return [];
  const taken = new Set();
  return list.map((b) => sanitizeBlock(b, grid, taken)).filter(Boolean).slice(0, MAX_BLOCKS);
}
// Reconstrói um display saneado. `ref` = builtin de referência (blocks/grid/name imexíveis).
function sanitizeDisplay(d, existing, ref) {
  if (!d || typeof d !== "object") return null;
  if (ref) return { ...ref, ui: sanitizeUi(d.ui, { ...defaultUi, ...ref.ui }) };
  const grid = { ...GRID };
  return {
    id: uniqueId(d.id || d.name, existing),
    name: cleanName(d.name, "Display"),
    builtin: false,
    grid,
    blocks: sanitizeBlocks(d.blocks, grid),
    ui: sanitizeUi(d.ui, defaultUi),
  };
}

const PRESETS = {
  spotlight: () => [blk("b1", "spotlight", 0, 0, 12, 7), blk("b2", "ticker", 0, 7, 12, 1)],
  mosaic: () => [blk("b1", "mosaic", 0, 0, 12, 7), blk("b2", "ticker", 0, 7, 12, 1)],
  blank: () => [],
};

// Aplica uma ação de /api/displays. Lança Error com mensagem p/ virar 400.
function applyDisplays(p) {
  if (!p || typeof p !== "object") throw new Error("corpo inválido");
  const list = control.displays;
  const find = (id) => list.find((d) => d.id === id);
  switch (p.action) {
    case "activate": {
      if (!find(p.id)) throw new Error("display não existe");
      control.activeDisplayId = p.id;
      break;
    }
    case "create": {
      if (list.length >= MAX_DISPLAYS) throw new Error("limite de displays");
      const src = find(p.from);
      const blocks = src ? JSON.parse(JSON.stringify(src.blocks)) : PRESETS[p.from] ? PRESETS[p.from]() : null;
      if (!blocks) throw new Error("origem inválida");
      const name = cleanName(p.name, src ? `${src.name} cópia` : "Novo display");
      const d = {
        id: uniqueId(name, list), name, builtin: false, grid: { ...GRID },
        blocks: sanitizeBlocks(blocks, GRID),
        ui: src ? { ...src.ui } : { ...activeDisplay().ui },
      };
      list.push(d);
      break;
    }
    case "update": {
      const d = find(p.id);
      if (!d) throw new Error("display não existe");
      // builtin é imexível em name, grid e blocks; só o ui muda (quem quer outro layout duplica antes)
      if (!d.builtin) {
        if ("name" in p) d.name = cleanName(p.name, d.name);
        if (Array.isArray(p.blocks)) d.blocks = sanitizeBlocks(p.blocks, d.grid);
        // grade é fixa em 12x8; aceitar `grid` do PWA só re-clampa os blocos
        if (p.grid) d.blocks = sanitizeBlocks(d.blocks, d.grid);
      }
      if (p.ui) d.ui = sanitizeUi(p.ui, d.ui);
      break;
    }
    case "delete": {
      const d = find(p.id);
      if (!d) throw new Error("display não existe");
      if (d.builtin) throw new Error("display builtin não pode ser apagado");
      control.displays = list.filter((x) => x !== d);
      if (control.activeDisplayId === d.id) control.activeDisplayId = "default";
      break;
    }
    case "reorder": {
      if (!Array.isArray(p.ids)) throw new Error("ids inválido");
      const seen = new Set();
      const first = p.ids.map((id) => find(id)).filter((d) => d && !seen.has(d.id) && seen.add(d.id));
      control.displays = [...first, ...list.filter((d) => !seen.has(d.id))];
      break;
    }
    default:
      throw new Error("ação inválida");
  }
  saveControl();
  broadcast();
}

/* ---------- control: aplica e valida um patch do PWA ---------- */
function applyControl(patch) {
  if (patch.mode === "auto" || patch.mode === "fixed") control.mode = patch.mode;
  if ("fixedEventId" in patch) control.fixedEventId = patch.fixedEventId || null;
  if (Array.isArray(patch.favorites)) {
    control.favorites = patch.favorites
      .map((s) => String(s).toUpperCase().trim())
      .filter(Boolean)
      .slice(0, 12);
  }
  let leaguesChanged = false;
  if (Array.isArray(patch.enabledLeagues)) {
    const next = patch.enabledLeagues.map((s) => String(s).toUpperCase()).filter((s) => BY_ID[s]);
    const value = next.length ? [...new Set(next)] : ["NFL", "NBA"];
    if (value.join(",") !== (control.enabledLeagues || []).join(",")) leaguesChanged = true;
    control.enabledLeagues = value;
  }
  // Customização visual: vai para o ui do display ativo (única fonte de verdade)
  if (patch.ui && typeof patch.ui === "object") {
    const d = activeDisplay();
    d.ui = sanitizeUi(patch.ui, d.ui);
  }
  // fixar um evento implica modo fixo; limpar volta pro automático
  if (patch.fixedEventId) control.mode = "fixed";
  if (patch.mode === "auto") control.fixedEventId = null;
  saveControl();
  broadcast();
  if (leaguesChanged) poll(); // recarrega a liga recém-ligada já já
}

/* ---------- chave do controle remoto ---------- */
// Chave de 32 hex mostrada no QR da TV. Nunca entra no snapshot nem em resposta do tunel.
function loadKey() {
  try {
    const k = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (/^[0-9a-f]{32}$/.test(k)) return k;
  } catch {}
  const k = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(KEY_FILE, k, { mode: 0o600 });
  return k;
}
const KEY = loadKey();
console.log(`[skycroft] controle ${REQUIRE_KEY ? `exige chave ${KEY.slice(0, 4)}…` : "aberto (sem chave)"}`);

// O cloudflared conecta no servidor pelo loopback, entao o IP de origem nao
// distingue nada: quem separa a internet da sala sao os cabecalhos que a
// Cloudflare carimba na borda e o tunel repassa.
function fromTunnel(req) {
  const h = req.headers;
  return !!(h["cf-ray"] || h["cf-connecting-ip"] || h["cf-visitor"] || h["x-forwarded-for"]);
}

// Compara em bytes, nao em caracteres: "e".repeat(32) tem 32 caracteres e 64
// bytes, e o timingSafeEqual lanca com tamanhos diferentes. Lancar aqui derruba
// o processo inteiro (excecao sincrona no handler do http), entao qualquer um
// pela internet derrubaria o servidor com um ?k= de 32 caracteres multibyte.
const KEY_BUF = Buffer.from(KEY);
function keyMatches(cand) {
  if (typeof cand !== "string") return false;
  const buf = Buffer.from(cand);
  if (buf.length !== KEY_BUF.length) return false;
  return crypto.timingSafeEqual(buf, KEY_BUF);
}

// Por padrao a chave vai no fragmento: ele nao e enviado ao servidor nem entra
// em log nenhum da Cloudflare. Mas um login interativo no meio do caminho (o
// Cloudflare Access redireciona para outra origem) perde o fragmento, e ai a
// chave precisa viajar na query. SKYCROFT_KEY_IN_QUERY=1 troca os dois.
// Base do controle: SKYCROFT_REMOTE_BASE; senão o host pelo qual a TV abriu a página
// (se não for loopback); senão o primeiro IPv4 de LAN deste computador.
function remoteBase(req) {
  if (BASE) return BASE;
  const host = String((req && req.headers.host) || "");
  if (host && !/^(localhost|127\.|\[?::1)/i.test(host)) return "http://" + host;
  for (const list of Object.values(require("os").networkInterfaces())) {
    for (const i of list || []) if (i.family === "IPv4" && !i.internal) return `http://${i.address}:${PORT}`;
  }
  return `http://localhost:${PORT}`;
}
function remoteUrl(req) {
  const base = remoteBase(req);
  if (!REQUIRE_KEY) return base + "/remote";
  const sep = process.env.SKYCROFT_KEY_IN_QUERY === "1" ? "?k=" : "#k=";
  return base + "/remote" + sep + KEY;
}

function authorized(req, url) {
  if (!fromTunnel(req)) return true; // TV no localhost, LAN, Tailscale
  // chave por cabecalho (fetch), cookie (EventSource nao manda cabecalho) ou query
  if (keyMatches(req.headers["x-skycroft-key"])) return true;
  const m = /(?:^|;\s*)sk=([^;\s]*)/.exec(req.headers.cookie || "");
  if (m && keyMatches(m[1])) return true;
  return keyMatches(url.searchParams.get("k"));
}

/* ---------- servidor ---------- */
function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // rotas que so servem a sala (hotspot/localhost): proibidas pelo tunel, com ou sem chave
  if (fromTunnel(req) && (pathname === "/api/net" || pathname.startsWith("/api/wifi/") ||
      pathname === "/setup" || pathname.startsWith("/setup/"))) {
    return sendJSON(res, 403, { error: "indisponível pela internet" });
  }

  // rotas da API exigem chave quando vem pelo tunel (antes de o SSE abrir o writeHead)
  if (REQUIRE_KEY && /^\/api\/(stream|state|control|displays|refresh)$/.test(pathname) && !authorized(req, url)) {
    return sendJSON(res, 401, { error: "chave inválida" });
  }

  // URL do controle com a chave (so para a TV; nunca pelo tunel)
  if (pathname === "/api/remote-url") {
    if (fromTunnel(req)) return sendJSON(res, 403, { error: "indisponível pela internet" });
    return sendJSON(res, 200, { url: remoteUrl(req) });
  }

  // SSE
  if (pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`retry: 3000\n`);
    res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const ka = setInterval(() => { try { res.write(": ka\n\n"); } catch {} }, 25_000);
    req.on("close", () => { clearInterval(ka); clients.delete(res); });
    return;
  }

  // estado atual (fetch único)
  if (pathname === "/api/state") return sendJSON(res, 200, snapshot());

  // comandos do controle remoto
  if (pathname === "/api/control" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on("end", () => {
      try { applyControl(JSON.parse(body || "{}")); sendJSON(res, 200, snapshot()); }
      catch { sendJSON(res, 400, { error: "json inválido" }); }
    });
    return;
  }

  // displays (layouts): activate | create | update | delete | reorder
  if (pathname === "/api/displays" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on("end", () => {
      let p; try { p = JSON.parse(body || "{}"); } catch { return sendJSON(res, 400, { error: "json inválido" }); }
      try { applyDisplays(p); sendJSON(res, 200, snapshot()); }
      catch (e) { sendJSON(res, 400, { error: e.message }); }
    });
    return;
  }

  // força recoleta (botão "atualizar agora" no controle)
  if (pathname === "/api/refresh" && req.method === "POST") {
    poll().then(() => sendJSON(res, 200, snapshot()));
    return;
  }

  // estado de rede (modo setup/online) — usado pela TV e pelo portal
  if (pathname === "/api/net") return sendJSON(res, 200, net.readNet());

  // scan de redes WiFi (só no modo setup)
  if (pathname === "/api/wifi/scan") {
    if (net.readNet().mode !== "setup") return sendJSON(res, 403, { error: "fora do modo setup" });
    net.scanWifi()
      .then((list) => sendJSON(res, 200, { networks: list }))
      .catch((e) => sendJSON(res, 500, { error: e.message }));
    return;
  }

  // conectar o aparelho a uma rede WiFi (só no modo setup)
  if (pathname === "/api/wifi/connect" && req.method === "POST") {
    if (net.readNet().mode !== "setup") return sendJSON(res, 403, { error: "fora do modo setup" });
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on("end", () => {
      let p; try { p = JSON.parse(body || "{}"); } catch { return sendJSON(res, 400, { error: "json inválido" }); }
      net.connectWifi(p.ssid, p.psk)
        .then(() => sendJSON(res, 200, { ok: true }))
        .catch((e) => sendJSON(res, 400, { error: e.message }));
    });
    return;
  }

  // portal de configuração (celular no hotspot)
  if (pathname === "/setup" || pathname === "/setup/") return serveFile(res, path.join(SETUP_DIR, "index.html"), req);
  if (pathname.startsWith("/setup/")) {
    const f = safeJoin(SETUP_DIR, pathname.slice("/setup/".length));
    if (f) return serveFile(res, f, req);
  }

  // controle remoto PWA
  if (pathname === "/remote" || pathname === "/remote/") return serveFile(res, path.join(REMOTE_DIR, "index.html"), req);
  if (pathname.startsWith("/remote/")) {
    const f = safeJoin(REMOTE_DIR, pathname.slice("/remote/".length));
    if (f) return serveFile(res, f, req);
  }

  // display (TV) — raiz
  if (pathname === "/" || pathname === "/index.html") return serveFile(res, path.join(DISPLAY_DIR, "index.html"), req);
  const df = safeJoin(DISPLAY_DIR, pathname.slice(1));
  if (df) return serveFile(res, df, req);

  res.writeHead(404); res.end("404");
}

const server = http.createServer(handleRequest);

/* ---------- portal cativo (porta 80, só no IP do AP) ---------- */
const PORTAL_HOST = "10.42.0.1";
const PORTAL_URL = "http://10.42.0.1/setup";
const PORTAL_PROBES = new Set([
  "/generate_204", "/gen_204", "/generate204", "/hotspot-detect.html",
  "/library/test/success.html", "/ncsi.txt", "/connecttest.txt", "/redirect",
  "/success.txt", "/canonical.html", "/nm-check.txt", "/check_network_status.txt",
]);
function portalRedirect(res) {
  res.writeHead(302, { Location: PORTAL_URL, "Cache-Control": "no-store", "Content-Length": 0 });
  res.end();
}
function portalHandler(req, res) {
  let pathname = "/";
  try { pathname = new URL(req.url, "http://x").pathname; } catch {}
  if (PORTAL_PROBES.has(pathname)) return portalRedirect(res);
  const host = String(req.headers.host || "").replace(/:\d+$/, "");
  if (host && host !== PORTAL_HOST) return portalRedirect(res);
  if (pathname === "/" || pathname === "/index.html") return portalRedirect(res);
  return handleRequest(req, res);
}
const portal = http.createServer(portalHandler);
let portalRetry = null;
function portalListen() {
  portalRetry = null;
  portal.listen(80, PORTAL_HOST);
}
portal.on("listening", () => console.log(`[skycroft] portal   http://${PORTAL_HOST}:80/`));
portal.on("error", (e) => {
  console.log(`[skycroft] portal indisponível (${e.code || e.message}); nova tentativa em 10s`);
  if (!portalRetry) portalRetry = setTimeout(portalListen, 10_000);
});
// SKYCROFT_PORTAL=0 (Docker): sem hotspot nem portal cativo, a porta 80 não é aberta.
if (require.main === module && process.env.SKYCROFT_PORTAL !== "0") portalListen();

if (require.main === module) server.listen(PORT, () => {
  console.log(`[skycroft] display  http://localhost:${PORT}/`);
  console.log(`[skycroft] controle http://localhost:${PORT}/remote`);
  poll();
});

// o selftest importa o módulo sem subir servidor
module.exports = { server, loadControl, applyControl, applyDisplays, snapshot, getControl: () => control, setControl: (c) => { control = c; } };
