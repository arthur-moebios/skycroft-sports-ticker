/* ===== Skycroft Ticker — TV view (lógica) =====
 * Modo AO VIVO: conecta no servidor do dispositivo (/api/state + SSE /api/stream)
 *   e obedece o controle remoto (favoritos, mostrador fixo, ligas).
 * Modo STANDALONE: sem servidor (preview por arquivo), usa window.MOCK_DATA e
 *   simula placares. */

let DATA = window.MOCK_DATA || { updatedAt: 0, favorites: ["NE", "BOS"], leagues: [] };
let CONTROL = {
  favorites: DATA.favorites || ["NE", "BOS"],
  mode: "auto",
  fixedEventId: null,
  enabledLeagues: ["NFL", "NBA"],
  ui: {
    theme: "midnight", density: "comfortable", font: "system", fontScale: 1,
    detail: "rich", listCount: 4, showTicker: true, showClock: true, showFeaturedStats: true, sidePos: "right",
  },
};
let LIVE = false; // true quando conectado ao servidor do dispositivo
let NET = { mode: "online" }; // estado de rede (setup/online)

/* ---- Displays (layouts compostos por blocos numa grade) ----
 * Sem servidor (standalone) usamos estes dois de exemplo; escolha com ?display=gameday. */
const STD_UI = {
  theme: "midnight", density: "comfortable", font: "system", fontScale: 1,
  detail: "rich", listCount: 4, showTicker: true, showClock: true, showFeaturedStats: true, sidePos: "right",
};
const ALL_STATES = ["in", "pre", "post"];
const noFilter = () => ({ leagues: [], states: ALL_STATES.slice(), favoritesOnly: false });
const DEFAULT_DISPLAY = {
  id: "default", name: "Padrão", builtin: true, grid: { cols: 12, rows: 8 }, ui: STD_UI,
  blocks: [
    { id: "brand", type: "brand", x: 0, y: 0, w: 6, h: 1, opts: {}, filters: noFilter() },
    { id: "clock", type: "clock", x: 6, y: 0, w: 6, h: 1, opts: {}, filters: noFilter() },
    { id: "spotlight", type: "spotlight", x: 0, y: 1, w: 7, h: 6, opts: {}, filters: noFilter() },
    { id: "list", type: "list", x: 7, y: 1, w: 5, h: 6, opts: {}, filters: noFilter() },
    { id: "ticker", type: "ticker", x: 0, y: 7, w: 12, h: 1, opts: {}, filters: noFilter() },
  ],
};
const GAMEDAY_DISPLAY = {
  id: "gameday", name: "Game Day", builtin: true, grid: { cols: 12, rows: 8 }, ui: STD_UI,
  blocks: [
    { id: "brand", type: "brand", x: 0, y: 0, w: 6, h: 1, opts: {}, filters: noFilter() },
    { id: "clock", type: "clock", x: 6, y: 0, w: 6, h: 1, opts: {}, filters: noFilter() },
    { id: "mosaic", type: "mosaic", x: 0, y: 1, w: 12, h: 6,
      opts: { cols: 3, showScore: true, showClock: true, showLogo: true, showOdds: false }, filters: noFilter() },
    { id: "ticker", type: "ticker", x: 0, y: 7, w: 12, h: 1, opts: {}, filters: noFilter() },
  ],
};
let DISPLAYS = [DEFAULT_DISPLAY, GAMEDAY_DISPLAY];
let ACTIVE_ID = new URLSearchParams(location.search).get("display") || "default";
function currentDisplay() {
  return DISPLAYS.find((d) => d.id === ACTIVE_ID) || DISPLAYS[0] || DEFAULT_DISPLAY;
}

const LEAGUE_LOGO = {
  NFL: "https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png",
  NBA: "https://a.espncdn.com/i/teamlogos/leagues/500/nba.png",
  MLB: "https://a.espncdn.com/i/teamlogos/leagues/500/mlb.png",
  NHL: "https://a.espncdn.com/i/teamlogos/leagues/500/nhl.png",
};
function leagueLogo(abbrev) {
  const u = LEAGUE_LOGO[abbrev];
  return u ? `<img class="llogo" src="${u}" alt="${abbrev}" onerror="this.remove()">` : "";
}

function favSet() {
  return new Set((CONTROL.favorites && CONTROL.favorites.length ? CONTROL.favorites : DATA.favorites) || []);
}
const isFavTeam = (abbr) => favSet().has(abbr);
const isFavEvent = (e) => isFavTeam(e.home?.abbr) || isFavTeam(e.away?.abbr);

// Filtro único dos blocos: liga (vazio = todas), estado e só favoritos.
function filterEvents(evs, f) {
  f = f || {};
  const lg = f.leagues && f.leagues.length ? new Set(f.leagues) : null;
  const st = f.states && f.states.length ? new Set(f.states) : null;
  return evs.filter((e) =>
    (!lg || lg.has(e.league)) && (!st || st.has(e.state)) && (!f.favoritesOnly || isFavEvent(e)));
}

// Achata os eventos com a info da liga e aplica os filtros do bloco.
// Sem filtro de liga no bloco, vale o que o controle habilitou; com filtro, o bloco manda.
function allEvents(filters) {
  const explicit = !!(filters && filters.leagues && filters.leagues.length);
  const enabled = new Set(CONTROL.enabledLeagues || ["NFL", "NBA"]);
  const out = [];
  for (const lg of DATA.leagues || []) {
    if (!explicit && !enabled.has(lg.abbrev)) continue;
    for (const ev of lg.events || []) out.push({ ...ev, league: lg.abbrev, leagueName: lg.name });
  }
  return filterEvents(out, filters);
}

// Ordena: ao vivo > agendado > encerrado; dentro de cada grupo, favoritos primeiro.
function prioritized(evs = allEvents()) {
  const rank = (e) => (e.state === "in" ? 0 : e.state === "pre" ? 1 : 2);
  return evs.slice().sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (isFavEvent(a) ? 0 : 1) - (isFavEvent(b) ? 0 : 1);
  });
}
const liveEvents = (evs = allEvents()) => evs.filter((e) => e.state === "in");

/* ---- Escala o palco 1920x1080 para caber na janela (kiosk em qualquer tela) ---- */
function scaleStage() {
  const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  document.getElementById("stage").style.transform = `translate(-50%, -50%) scale(${s})`;
}
window.addEventListener("resize", scaleStage);

/* ---- Relógio ---- */
// Os formatadores sao criados uma vez. Construir Intl.DateTimeFormat a cada
// segundo (duas vezes, uma delas com nome de dia e mes por extenso) custa caro
// nesse SoC, e o relogio so mostra hora e minuto: 59 de cada 60 atualizacoes
// produziam exatamente o mesmo texto.
const FMT_TIME = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const FMT_DATE = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
let lastClockT = "", lastClockD = "";

function updateClock(force) {
  const now = new Date();
  const t = FMT_TIME.format(now);
  const d = FMT_DATE.format(now);
  // Escrever no DOM invalida o layout do palco inteiro, e o palco esta escalado
  // para 4K: era esse toque por segundo que engasgava a faixa rolante.
  if (t !== lastClockT || force) {
    lastClockT = t;
    document.querySelectorAll(".clock .time").forEach((el) => { el.textContent = t; });
  }
  if (d !== lastClockD || force) {
    lastClockD = d;
    document.querySelectorAll(".clock .date").forEach((el) => { el.textContent = d; });
  }
}

/* ---- Rótulos de status ---- */
function favMark(abbr) { return isFavTeam(abbr) ? "★ " : ""; }
function statusText(ev) {
  if (ev.state === "in") return "AO VIVO · " + ev.status;
  if (ev.state === "post") return ev.status || "ENCERRADO";
  return formatStart(ev.starts) || ev.status || "EM BREVE";
}

/* ---- Card em destaque (rotaciona entre os jogos priorizados) ---- */
let featIdx = 0;

// Formata horário de início: "sáb 15/11 · 22:00"
function formatStart(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return (
    d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" }) +
    " · " +
    d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo", hour12: false })
  );
}

// Destaque FIXO nos favoritos: para cada favorito, pega jogo ao vivo > próximo > mais recente.
function favGames(evs = allEvents()) {
  const out = [];
  for (const ab of (CONTROL.favorites && CONTROL.favorites.length ? CONTROL.favorites : DATA.favorites) || []) {
    const mine = evs.filter((e) => e.home.abbr === ab || e.away.abbr === ab);
    if (!mine.length) continue;
    const live = mine.find((e) => e.state === "in");
    const nextUp = mine
      .filter((e) => e.state === "pre")
      .sort((a, b) => new Date(a.starts || 0) - new Date(b.starts || 0))[0];
    const recent = mine
      .filter((e) => e.state === "post")
      .sort((a, b) => new Date(b.starts || 0) - new Date(a.starts || 0))[0];
    out.push(live || nextUp || recent || mine[0]);
  }
  return out;
}

// Exibidor principal:
//  - Se o controle fixou um evento (mode=fixed), ele manda.
//  - Senão: AO VIVO tem prioridade (favoritos ao vivo > outros ao vivo),
//    depois o próximo jogo dos favoritos; por fim o geral priorizado.
function featPool(evs = allEvents()) {
  if (CONTROL.mode === "fixed" && CONTROL.fixedEventId) {
    const pinned = evs.find((e) => e.id === CONTROL.fixedEventId);
    if (pinned) return [pinned];
  }
  // TODOS os jogos ao vivo dos filtros do bloco (favoritos primeiro), sem teto.
  const live = evs.filter((e) => e.state === "in");
  if (live.length) return [...live.filter(isFavEvent), ...live.filter((e) => !isFavEvent(e))];
  const favNext = favGames(evs).filter((e) => e.state !== "in");
  return favNext.length ? favNext : prioritized(evs).slice(0, 6);
}
function renderFeatured(root, evs, o = {}) {
  const pool = featPool(evs);
  const el = root.querySelector(".featured");
  if (!pool.length) { el.classList.add("empty"); return; }
  el.classList.remove("empty");
  // Índice por bloco: com dois Destaques de ligas diferentes, um índice
  // compartilhado era zerado pelo bloco de pool menor a cada giro.
  const ev = pool[(root._feat || 0) % pool.length];
  el.querySelector(".league-badge").innerHTML = leagueLogo(ev.league) + `<span>${ev.leagueName}</span>`;
  const pill = el.querySelector(".status-pill");
  pill.className = "status-pill " + ev.state;
  if (ev.state === "in") pill.innerHTML = '<span class="dot"></span>AO VIVO · ' + ev.status;
  else if (ev.state === "pre") pill.innerHTML = "PRÓXIMO JOGO · " + (formatStart(ev.starts) || ev.status);
  else pill.innerHTML = ev.status || "ENCERRADO";

  const rows = el.querySelectorAll(".team-row");
  fillTeamRow(rows[0], ev.away, o);
  fillTeamRow(rows[1], ev.home, o);
  renderFeatExtra(el, ev, o);
  renderFeaturedStats(ev, el);
  // Pontuou desde o último snapshot (só com "Parar no jogo que pontuou" ligado).
  if (root._flash && root._flash.id === ev.id) {
    root._flash.sides.forEach((sd) => {
      const sc = rows[sd === "away" ? 0 : 1].querySelector(".score");
      sc.classList.remove("flash"); void sc.offsetWidth; sc.classList.add("flash");
    });
    root._flash = null;
  }
}

/* ---- Extras do Destaque: cada um liga/desliga nas opções do bloco ---- */
function renderFeatExtra(el, ev, o) {
  let box = el.querySelector(".feat-extra");
  if (!box) { box = document.createElement("div"); box.className = "feat-extra"; el.querySelector(".matchup").after(box); }
  const parts = [];
  const a = ev.away || {}, h = ev.home || {};
  if (o.showSituation === true && ev.state === "in" && ev.situation) {
    const s = ev.situation;
    const line = [s.possession ? "● " + s.possession : "", s.downDistance, s.possessionText, s.isRedZone ? "RED ZONE" : ""].filter(Boolean).join(" · ");
    if (line || s.lastPlay) parts.push(`<div class="fx-sit${s.isRedZone ? " rz" : ""}">${line ? `<b>${esc(line)}</b>` : ""}${s.lastPlay ? `<span>${esc(String(s.lastPlay).trim())}</span>` : ""}</div>`);
  }
  if (o.showTopScorers !== false && ev.state === "in" && (ev.topScorers || []).length) {
    const rows = ev.topScorers.map((p) => `<span class="nm">${esc(p.name)}<em>${esc(p.team)}</em></span><i class="pt">${p.pts}</i><i>${p.reb}</i><i>${p.ast}</i>`).join("");
    parts.push(`<div class="fx-top"><span class="hd">TOP 5 PONTUADORES</span><i class="hd">PTS</i><i class="hd">REB</i><i class="hd">AST</i>${rows}</div>`);
  }
  if (o.showLinescore === true && (a.lines || []).length && (h.lines || []).length) {
    const n = Math.max(a.lines.length, h.lines.length);
    const lab = (i) => (i < 4 ? String(i + 1) : "OT" + (i > 4 ? i - 3 : ""));
    const cells = (arr) => Array.from({ length: n }, (_, i) => `<i>${esc(arr[i] ?? "")}</i>`).join("");
    parts.push(`<div class="fx-lines" style="--n:${n}">
      <span></span>${Array.from({ length: n }, (_, i) => `<i class="hd">${lab(i)}</i>`).join("")}<i class="hd">T</i>
      <b>${esc(a.abbr)}</b>${cells(a.lines)}<i class="tot">${esc(a.score)}</i>
      <b>${esc(h.abbr)}</b>${cells(h.lines)}<i class="tot">${esc(h.score)}</i></div>`);
  }
  if (o.showWinProb === true && ev.state === "in" && ev.winProb) {
    const w = ev.winProb;
    parts.push(`<div class="fx-prob"><div class="bar"><i style="width:${w.away}%;background:${esc(a.color)}"></i><i style="width:${w.home}%;background:${esc(h.color)}"></i></div>
      <div class="lbl"><span>${esc(a.abbr)} ${w.away}%</span><em>prob. de vitória</em><span>${w.home}% ${esc(h.abbr)}</span></div></div>`);
  }
  box.innerHTML = parts.join("");
  box.hidden = !parts.length;
}
// Placar de cada jogo na leitura anterior, para detectar quem pontuou.
const SCORE_SEEN = new Map();
const HOLD_MS = 10000;
function detectScoring() {
  const first = !SCORE_SEEN.size;
  const changed = new Map(); // id -> ["away","home"]
  for (const lg of DATA.leagues || []) for (const e of lg.events || []) {
    if (e.state !== "in" || !e.away || !e.home) continue;
    const prev = SCORE_SEEN.get(e.id);
    if (prev && !first) {
      const sides = [];
      if (e.away.score !== prev[0]) sides.push("away");
      if (e.home.score !== prev[1]) sides.push("home");
      if (sides.length) changed.set(e.id, sides);
    }
    SCORE_SEEN.set(e.id, [e.away.score, e.home.score]);
  }
  return changed;
}
function holdOnScoring(changed) {
  if (!changed.size) return;
  for (const b of BLOCKS) {
    if (b.block.type !== "spotlight" || (b.block.opts || {}).holdOnScore !== true) continue;
    const pool = featPool(allEvents(b.block.filters));
    const i = pool.findIndex((e) => changed.has(e.id));
    if (i < 0) continue;
    b.el._feat = i;
    b.el._hold = Date.now() + HOLD_MS;
    b.el._flash = { id: pool[i].id, sides: changed.get(pool[i].id) };
  }
}
function renderFeaturedStats(ev, el) {
  const box = el.querySelector(".featured-stats");
  if (!box) return;

  const info = ev.featuredInfo;
  const enabled = CONTROL.ui?.showFeaturedStats !== false;

  if (!enabled || !info) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }

  const rows = [];

  const labels = {
    passingYards: "PASSES",
    rushingYards: "CORRIDAS",
    receivingYards: "RECEPÇÕES",
  };

  for (const leader of info.leaders || []) {
    if (!leader.athlete || !leader.stats) continue;

    const label = labels[leader.category] || leader.label || "LÍDER";
    const name = leader.athlete +
      (leader.position ? " (" + leader.position + ")" : "");

    rows.push({ label, value: name + " · " + leader.stats });
  }

  const location = [info.venue, info.city].filter(Boolean).join(" · ");
  const broadcasts = (info.broadcasts || []).join(", ");
  const meta = [location, broadcasts].filter(Boolean).join(" · ");

  box.replaceChildren();

  if (rows.length) {
    const heading = document.createElement("div");
    heading.className = "featured-stat-heading";
    heading.textContent = "LÍDERES DA TEMPORADA";
    box.appendChild(heading);
  }

  for (const item of rows) {
    const row = document.createElement("div");
    row.className = "featured-stat-row";

    const label = document.createElement("span");
    label.className = "featured-stat-label";
    label.textContent = item.label;

    const value = document.createElement("span");
    value.className = "featured-stat-value";
    value.textContent = item.value;

    row.append(label, value);
    box.appendChild(row);
  }

  if (meta) {
    const footer = document.createElement("div");
    footer.className = "featured-stat-meta";
    footer.textContent = meta;
    box.appendChild(footer);
  }

  box.hidden = !box.childElementCount;
}

function fillTeamRow(row, team, o = {}) {
  if (!row || !team) return; // corrida/card não tem confronto
  applyCrest(row.querySelector(".crest"), team);
  row.querySelector(".team-name").textContent = favMark(team.abbr) + team.name;
  row.querySelector(".team-sub").textContent = team.record && o.showRecord !== false ? `${team.abbr} · ${team.record}` : team.abbr;
  row.querySelector(".score").textContent = team.score ?? "";
}

/* Logo real do time (com fallback pra sigla + cor) */
function applyCrest(el, team) {
  const ab = String(team.abbr || "").slice(0, 3);
  if (team.logo) {
    el.classList.add("has-logo");
    el.style.background = "rgba(255,255,255,.05)";
    el.innerHTML = `<img class="logo" src="${team.logo}" alt="${ab}" onerror="logoFail(this,'${ab}','${team.color}')">`;
  } else {
    el.classList.remove("has-logo");
    el.style.background = team.color;
    el.textContent = ab;
  }
}
window.logoFail = function (img, ab, color) {
  const el = img.parentElement;
  el.classList.remove("has-logo");
  el.style.background = color;
  el.textContent = ab;
};

/* ---- Lista lateral: próximos / ao vivo ---- */
function renderSide(root, evs) {
  const rest = prioritized(evs); // todos, sem teto; o que não couber rola
  root.querySelector(".side-title").textContent =
    liveEvents(evs).length ? "Ao vivo & a seguir" : "Próximos jogos";
  const list = root.querySelector(".mini-list");
  const html = rest.map((ev) => {
    const cls = ev.state === "in" ? "in" : ev.state === "post" ? "post" : "pre";
    return `<div class="mini">
      <div class="mini-top">
        <span class="mini-league">${leagueLogo(ev.league)}${ev.league}</span>
        <span class="mini-status ${cls}">${ev.state === "in" ? "● " : ""}${statusText(ev)}</span>
      </div>
      ${miniTeam(ev.away)}${miniTeam(ev.home)}</div>`;
  }).join("");
  let track = list.firstElementChild;
  if (!track || !track.classList.contains("mini-track")) {
    list.innerHTML = '<div class="mini-track"></div>';
    track = list.firstElementChild;
  }
  // Só mexe no DOM quando o conteúdo mudou; a posição da rolagem é guardada em
  // JS (não numa animação CSS), então nada que redesenhe o bloco a reinicia.
  if (track.dataset.sig !== html) {
    track.dataset.sig = html;
    track.innerHTML = html;
    track.dataset.dup = "";
  }
  setListScroll(list, track);
}
// Rolagem contínua e de velocidade fixa quando a lista não cabe na área do bloco.
const LIST_PX_PER_S = 40;
function setListScroll(list, track) {
  if (track.dataset.dup !== "1") {
    const one = track.scrollHeight;
    if (one <= list.clientHeight + 2) { track._half = 0; track.style.transform = ""; }
    else {
      track.innerHTML = track.dataset.sig + track.dataset.sig;
      track.dataset.dup = "1";
      track._half = track.scrollHeight / 2;
    }
  }
  if (track._raf || !track._half) return;
  let last = performance.now();
  const step = (now) => {
    if (!track.isConnected) { track._raf = 0; return; }
    const dt = Math.min(now - last, 100) / 1000;
    last = now;
    if (track._half) {
      track._off = ((track._off || 0) + LIST_PX_PER_S * dt) % track._half;
      track.style.transform = `translateY(${-track._off}px)`;
    }
    track._raf = requestAnimationFrame(step);
  };
  track._raf = requestAnimationFrame(step);
}
function miniTeam(t) {
  if (!t) return "";
  const ab = String(t.abbr || "").slice(0, 3);
  const crest = t.logo
    ? `<span class="mini-crest has-logo"><img class="logo" src="${t.logo}" alt="${ab}" onerror="logoFail(this,'${ab}','${t.color}')"></span>`
    : `<span class="mini-crest" style="background:${t.color}">${ab}</span>`;
  return `<div class="mini-team">
      ${crest}
      <span class="mini-name">${favMark(t.abbr)}${t.name}</span>
      <span class="mini-score">${t.score}</span>
    </div>`;
}

/* ---- Faixa rolando (ticker) — duplica o conteúdo p/ loop sem emenda ---- */
// Velocidade fixa em pixels por segundo. Com duracao fixa no CSS a faixa
// acelerava sozinha quando havia mais jogos, porque a trilha ficava mais longa
// e o mesmo tempo precisava cobrir mais distancia.
const TICKER_PX_PER_S = 68;

function renderTicker(root, evs) {
  const track = root.querySelector(".ticker-track");
  const items = prioritized(evs).map(tkItem).join("");
  // Reconstruir a cada snapshot (30s) reinicia a animacao e produz um solavanco
  // visivel. So mexe no DOM quando o conteudo mudou de fato.
  if (track.dataset.sig !== items) {
    track.dataset.sig = items;
    track.innerHTML = items + items;
  }
  setTickerSpeed(track);
}

// A trilha tem o conteudo duplicado; a animacao percorre metade dela.
function setTickerSpeed(track) {
  const half = track.scrollWidth / 2;
  if (!half) return;
  const secs = Math.max(20, Math.round(half / TICKER_PX_PER_S));
  if (track.dataset.secs !== String(secs)) {
    track.dataset.secs = String(secs);
    track.style.animationDuration = secs + "s";
  }
}
function tkItem(ev) {
  if (!ev.away || !ev.home) { // corrida/card: só nome e status
    return `<span class="tk-item"><span class="tk-league">${leagueLogo(ev.league)}${ev.league}</span>
      <span class="tk-team">${esc(eventName(ev))}</span><span class="tk-status ${ev.state}">${esc(ev.status || "")}</span></span>`;
  }
  const st = ev.state === "in" ? "in" : ev.state === "post" ? "post" : "pre";
  const shortStatus = ev.state === "in"
    ? ev.status
    : ev.state === "post"
      ? "Final"
      : (formatStart(ev.starts) || ev.status);
  return `<span class="tk-item">
      <span class="tk-league">${leagueLogo(ev.league)}${ev.league}</span>
      ${tkLogo(ev.away)}
      <span class="tk-team">${favMark(ev.away.abbr)}${ev.away.abbr}</span>
      <span class="tk-score">${ev.away.score}</span>
      <span class="tk-status">×</span>
      <span class="tk-score">${ev.home.score}</span>
      <span class="tk-team">${ev.home.abbr}${isFavTeam(ev.home.abbr) ? " ★" : ""}</span>
      ${tkLogo(ev.home)}
      <span class="tk-status ${st}">${shortStatus}</span>
    </span>`;
}
function tkLogo(t) {
  return t.logo
    ? `<img class="tk-logo" src="${t.logo}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'tk-abbr-color',style:'background:${t.color}'}))">`
    : `<span class="tk-abbr-color" style="background:${t.color}"></span>`;
}

/* ---- Aplica a customização visual (tema, fonte, densidade, escala...) ---- */
function applyUi() {
  const u = CONTROL.ui || {};
  const st = document.getElementById("stage");
  if (!st) return;
  st.dataset.theme = u.theme || "midnight";
  st.dataset.density = u.density || "comfortable";
  st.dataset.font = u.font || "system";
  st.dataset.detail = u.detail || "rich";
  st.dataset.side = u.sidePos || "right";
  st.dataset.ticker = u.showTicker === false ? "off" : "on";
  st.dataset.clock = u.showClock === false ? "off" : "on";
  st.style.setProperty("--ui-scale", String(u.fontScale || 1));
}

/* ---- Blocos, grade e renderizadores ---- */
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const eventName = (ev) => ev.name || ev.title || ev.shortName ||
  [ev.away?.name, ev.home?.name].filter(Boolean).join(" × ") || ev.leagueName || "";

// Marcação idêntica à do layout antigo; cada bloco desenha uma vez e depois só atualiza.
const MARKUP = {
  brand: `<div class="brand">
        <div class="bolt"><img src="assets/skycroft-logo.svg" alt="Skycroft"></div>
        <div class="name">SKYCROFT <span>TICKER</span></div>
      </div>`,
  clock: `<div class="clock"><div class="time">--:--</div><div class="date">—</div></div>`,
  spotlight: `<section class="featured">
        <div class="feat-head">
          <div class="league-badge">—</div>
          <div class="status-pill in"><span class="dot"></span>AO VIVO</div>
        </div>
        <div class="matchup">
          <div class="team-row">
            <div class="crest"></div>
            <div><div class="team-name">—</div><div class="team-sub"></div></div>
            <div class="score">0</div>
          </div>
          <div class="vs-sep"></div>
          <div class="team-row">
            <div class="crest"></div>
            <div><div class="team-name">—</div><div class="team-sub"></div></div>
            <div class="score">0</div>
          </div>
        </div>
        <div class="featured-stats" hidden></div>
      </section>`,
  list: `<aside class="side">
        <div class="side-title">Mais jogos ao vivo</div>
        <div class="mini-list"></div>
      </aside>`,
  ticker: `<footer class="ticker">
      <div class="ticker-label">⚽ PLACARES</div>
      <div class="ticker-track"></div>
    </footer>`,
};
function ensureMarkup(blockEl, type) {
  if (!blockEl.firstElementChild) blockEl.innerHTML = MARKUP[type];
  return blockEl.firstElementChild;
}

const RENDERERS = {
  spotlight(blockEl, block, events) { ensureMarkup(blockEl, "spotlight"); renderFeatured(blockEl, events, block.opts || {}); },
  list(blockEl, block, events) { ensureMarkup(blockEl, "list"); renderSide(blockEl, events); },
  ticker(blockEl, block, events) { ensureMarkup(blockEl, "ticker"); renderTicker(blockEl, events); },
  clock(blockEl) { if (!blockEl.firstElementChild) { ensureMarkup(blockEl, "clock"); updateClock(true); } },
  brand(blockEl) { ensureMarkup(blockEl, "brand"); },
  mosaic: renderMosaic,
};

/* ---- Mosaico (Game Day) ---- */
const MZ_GAP = 16, MZ_MIN_H = 190, MZ_MAX_H = 260;

// Ao vivo primeiro, depois os que vão começar (por horário), depois os encerrados.
function mosaicOrder(evs) {
  const rank = (e) => (e.state === "in" ? 0 : e.state === "pre" ? 1 : 2);
  const t = (e) => new Date(e.starts || 0).getTime() || 0;
  return evs.slice().sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.state === "pre") return t(a) - t(b);
    if (a.state === "post") return t(b) - t(a);
    return (isFavEvent(a) ? 0 : 1) - (isFavEvent(b) ? 0 : 1);
  });
}
function mzStatus(ev, o) {
  if (ev.state === "in") {
    if (o.showClock === false) return "● AO VIVO";
    const parts = [ev.period, ev.clock].filter(Boolean);
    return "● " + (parts.length ? parts.join(" · ") : ev.status || "AO VIVO");
  }
  if (ev.state === "post") return ev.status || "ENCERRADO";
  return formatStart(ev.starts) || ev.status || "EM BREVE";
}
function mzTeam(t, ev, o) {
  const poss = ev.state === "in" && ev.situation && ev.situation.possession &&
    (ev.situation.possession === t.abbr || ev.situation.possession === t.id);
  const rec = typeof t.record === "string" && t.record ? `<span class="mz-rec">${esc(t.record)}</span>` : "";
  const score = o.showScore === false ? "" :
    `<span class="mz-score">${ev.state === "pre" ? "–" : esc(t.score ?? "")}</span>`;
  return `<div class="mz-team${o.showLogo === false ? " nologo" : ""}">
      ${o.showLogo === false ? "" : '<span class="crest mz-crest"></span>'}
      <span class="mz-name">${esc(favMark(t.abbr) + (t.name || t.abbr || ""))}${poss ? ' <span class="mz-poss">●</span>' : ""}${rec}</span>
      ${score}
    </div>`;
}
function mosaicCell(ev, o, cellH) {
  const c = document.createElement("div");
  const st = ev.state === "in" ? "in" : ev.state === "post" ? "post" : "pre";
  const top = `<div class="mz-top"><span class="mz-league">${leagueLogo(ev.league)}${esc(ev.league || "")}</span>
      <span class="mz-status ${st}">${esc(mzStatus(ev, o))}</span></div>`;
  const entries = Array.isArray(ev.entries) ? ev.entries : [];
  if (ev.kind === "race" || ev.kind === "card" || !ev.away || !ev.home) {
    // sem placar: título do evento + lista de entries (se vier vazia, só o título)
    const max = Math.max(2, Math.floor((cellH - 90) / 30));
    const rows = entries.slice(0, max).map((e) => `<div class="mz-entry">
        <span class="mz-pos">${esc(e.pos)}</span><span class="mz-ename">${esc(e.name)}</span><span class="mz-edet">${esc(e.detail)}</span></div>`).join("");
    c.className = "mz-cell entries " + st;
    c.innerHTML = top + `<div class="mz-title">${esc(eventName(ev))}</div>` + rows;
    return c;
  }
  const lines = [];
  if (ev.state === "in" && ev.situation && ev.situation.downDistance) lines.push(esc(ev.situation.downDistance));
  if (o.showOdds === true && ev.odds) {
    const od = [ev.odds.details, ev.odds.overUnder != null ? "O/U " + ev.odds.overUnder : ""].filter(Boolean).join(" · ");
    if (od) lines.push(esc(od));
  }
  c.className = "mz-cell " + st;
  c.innerHTML = top + mzTeam(ev.away, ev, o) + mzTeam(ev.home, ev, o) +
    (lines.length ? `<div class="mz-line">${lines.join(" · ")}</div>` : "");
  if (o.showLogo !== false) {
    const cr = c.querySelectorAll(".mz-crest");
    applyCrest(cr[0], ev.away);
    applyCrest(cr[1], ev.home);
  }
  return c;
}
function renderMosaic(blockEl, block, events) {
  const o = block.opts || {};
  const cols = [2, 3, 4].includes(+o.cols) ? +o.cols : 3;
  let root = blockEl.firstElementChild;
  if (!root) {
    root = document.createElement("div");
    root.className = "mosaic";
    blockEl.appendChild(root);
  }
  root.dataset.cols = cols;
  root.replaceChildren();
  const list = mosaicOrder(events);
  if (!list.length) {
    root.innerHTML = '<div class="mz-empty">Sem jogos no momento</div>';
    return;
  }
  // linhas se ajustam à quantidade de jogos; o teto vem da altura mínima legível da célula
  const H = (blockEl.clientHeight || 600) - 22;
  const maxRows = Math.max(1, Math.floor((H + MZ_GAP) / (MZ_MIN_H + MZ_GAP)));
  const rows = Math.min(maxRows, Math.ceil(list.length / cols));
  const per = rows * cols;
  const pages = Math.ceil(list.length / per);
  const page = (blockEl._page || 0) % pages;
  const cellH = Math.min(MZ_MAX_H, (H - MZ_GAP * (rows - 1)) / rows);
  const grid = document.createElement("div");
  grid.className = "mz-grid";
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, ${MZ_MAX_H}px))`;
  list.slice(page * per, page * per + per).forEach((ev) => grid.appendChild(mosaicCell(ev, o, cellH)));
  root.appendChild(grid);
  if (pages > 1) {
    const dots = document.createElement("div");
    dots.className = "mz-dots";
    for (let i = 0; i < pages; i++) dots.appendChild(Object.assign(document.createElement("i"), { className: i === page ? "on" : "" }));
    root.appendChild(dots);
  }
}

/* ---- Layout: monta os blocos do display ativo ---- */
let LAYOUT_SIG = "";
let BLOCKS = []; // { el, block }

// Display "Padrão" (brand, clock, spotlight, list, ticker) usa a estrutura antiga
// (topbar / body / ticker) para sair idêntico; qualquer outro vai na grade 12x8.
function isLegacyLayout(d) {
  return d.blocks.map((b) => b.type).sort().join() === "brand,clock,list,spotlight,ticker";
}
function mkEl(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

function ensureLayout() {
  const d = currentDisplay();
  const blocks = (d.blocks || []).map((b, i) => ({ ...b, id: b.id || b.type + i }));
  const legacy = isLegacyLayout(d);
  const grid = d.grid || { cols: 12, rows: 8 };
  const sig = JSON.stringify([legacy, grid, blocks.map((b) => [b.id, b.type, b.x, b.y, b.w, b.h])]);
  if (sig === LAYOUT_SIG) { // mesma estrutura: só atualiza opts/filtros
    BLOCKS.forEach((b) => { b.block = blocks.find((x) => x.id === b.block.id) || b.block; });
    return;
  }
  LAYOUT_SIG = sig;
  const stage = document.getElementById("stage");
  const host = document.getElementById("blocks");
  const access = document.getElementById("remote-access");
  stage.appendChild(access); // tira do topbar antes de limpar
  stage.insertBefore(access, host.nextSibling);
  host.replaceChildren();
  BLOCKS = [];
  stage.dataset.layout = legacy ? "legacy" : "grid";
  access.classList.toggle("floating", !legacy);
  // Flutuando, o selo fica por cima da grade: o CSS reserva a faixa do topo
  // para ele nao cobrir o conteudo da primeira linha de blocos.
  stage.dataset.remote = !legacy && !access.hidden ? "float" : "bar";

  const mk = (b) => {
    const el = mkEl("div", "block");
    el.dataset.type = b.type;
    BLOCKS.push({ el, block: b });
    return el;
  };
  if (legacy) {
    const by = (t) => blocks.find((b) => b.type === t);
    const header = mkEl("header", "topbar");
    header.append(mk(by("brand")), access, mk(by("clock")));
    const main = mkEl("main", "body");
    main.append(mk(by("spotlight")), mk(by("list")));
    host.append(header, main, mk(by("ticker")));
  } else {
    host.style.gridTemplateColumns = `repeat(${grid.cols || 12}, minmax(0, 1fr))`;
    host.style.gridTemplateRows = `repeat(${grid.rows || 8}, minmax(0, 1fr))`;
    for (const b of blocks) {
      const el = mk(b);
      el.style.gridColumn = `${b.x + 1} / span ${b.w}`;
      el.style.gridRow = `${b.y + 1} / span ${b.h}`;
      host.appendChild(el);
    }
  }
  if (legacy) { host.style.gridTemplateColumns = ""; host.style.gridTemplateRows = ""; }
}

// Desenha cada bloco com os eventos que passam pelos filtros dele.
function renderBlocks(only) {
  for (const b of BLOCKS) {
    if (only && !only.includes(b.block.type)) continue;
    const fn = RENDERERS[b.block.type];
    if (!fn) continue;
    try { fn(b.el, b.block, allEvents(b.block.filters)); }
    catch (e) { console.error("Erro no bloco " + b.block.id + ":", e); }
  }
}

function renderAll() {
  applyUi();
  ensureLayout();
  renderBlocks();
}

// Gira o destaque e as páginas do mosaico.
function tickRotation() {
  featIdx++;
  BLOCKS.forEach((b) => {
    if (b.block.type !== "spotlight") return;
    if (b.el._hold && Date.now() < b.el._hold) return; // acabou de pontuar: segura
    b.el._feat = (b.el._feat || 0) + 1;
  });
  renderBlocks(["spotlight"]);
}
function tickMosaic() {
  BLOCKS.forEach((b) => { if (b.block.type === "mosaic") b.el._page = (b.el._page || 0) + 1; });
  renderBlocks(["mosaic"]);
}

/* ---- Simula updates ao vivo (SÓ no modo standalone, sem servidor) ---- */
function simulateLive() {
  if (LIVE) return;
  const live = liveEvents();
  if (!live.length) return;
  const ev = live[Math.floor(Math.random() * live.length)];
  const side = Math.random() < 0.5 ? "away" : "home";
  ev[side].score += ev.league === "NBA" ? 2 : ev.league === "NFL" ? 7 : 1;

  const pool = featPool();
  const feat = pool[featIdx % pool.length];
  renderBlocks();
  if (feat && feat.id === ev.id) {
    const row = document.querySelectorAll(".featured .team-row")[side === "away" ? 0 : 1];
    const sc = row && row.querySelector(".score");
    if (sc) { sc.classList.remove("flash"); void sc.offsetWidth; sc.classList.add("flash"); }
  }
}


/* ---- Acesso ao PWA pelo QR Code ---- */
let remoteQrUrl = "";
// URL do controle com a chave no fragmento; vem do servidor (a TV e localhost).
// Se o fetch falhar, o selo do QR fica escondido até a URL chegar.
let remoteUrl = "";
fetch("/api/remote-url", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error("sem url"))))
  .then((j) => {
    if (j && typeof j.url === "string" && j.url !== remoteUrl) {
      remoteUrl = j.url;
      try { updateRemoteQr(); } catch {}
    }
  })
  .catch(() => {});

function createRemoteQr(elementId, url) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  el.innerHTML = qr.createSvgTag({
    cellSize: 8,
    margin: 0,
    scalable: true
  });
}



function updateRemoteQr() {
  const access = document.getElementById("remote-access");

  if (NET.mode !== "online") { access.hidden = true; return; }

  const url = remoteUrl;
  if (!url) { access.hidden = true; return; }
  access.hidden = false;

  if (url !== remoteQrUrl) {
    remoteQrUrl = url;
    // Só o selo do canto. O convite em tela cheia saiu: o QR pequeno já é
    // legível na TV e cobrir o ticker não se paga.
    try { createRemoteQr("remote-qr-small", url); }
    catch (e) { console.error("Erro ao gerar QR Code:", e); }
  }
}

/* ---- Conexão ao vivo com o servidor do dispositivo ---- */
function applySnapshot(snap) {
  if (!snap) return;
  DATA = { updatedAt: snap.updatedAt, favorites: snap.favorites, leagues: snap.leagues || [] };
  if (snap.control) CONTROL = { ...CONTROL, ...snap.control };
  // displays: sem eles (servidor antigo) cai no Padrão; o ui vem do display ativo
  DISPLAYS = Array.isArray(snap.displays) && snap.displays.length ? snap.displays : [DEFAULT_DISPLAY];
  ACTIVE_ID = snap.activeDisplayId || DISPLAYS[0].id;
  const ui = snap.ui || currentDisplay().ui;
  if (ui) CONTROL = { ...CONTROL, ui };
  if (snap.net) NET = snap.net;
  renderNet();
  updateRemoteQr();
  const changed = detectScoring();
  renderAll();
  if (changed.size) { holdOnScoring(changed); renderBlocks(["spotlight"]); }
}

/* ---- Tela de configuração (modo setup: aparelho sem WiFi) ---- */
let lastQrKey = "";
let setupStreak = 0;
const SETUP_STREAK_MIN = 2;
// A tela de setup nao fica parada no DOM atras do ticker: ela e montada quando
// o aparelho perde o Wi-Fi e removida assim que volta. Enquanto esta online,
// esses elementos simplesmente nao existem.
const SETUP_HTML = `<section id="setup-screen">
  <div class="setup-card">
    <div class="setup-brand">
      <img src="assets/skycroft-logo.svg" alt="Skycroft">
      <div><b>SKYCROFT</b> TICKER</div>
    </div>
    <h1>Vamos conectar ao seu WiFi</h1>
    <ol class="setup-steps">
      <li><b>1.</b> No celular, aponte a câmera para o <b>QR 1</b> e entre na rede <span class="pill" id="setup-ssid">Skycroft-Setup</span></li>
      <li><b>2.</b> Depois de conectado, aponte a câmera para o <b>QR 2</b> para abrir a página — escolha seu WiFi e digite a senha. <i>O QR 2 só funciona depois de entrar na rede.</i></li>
    </ol>
    <div class="setup-qr-wrap">
      <figure class="setup-qr-item">
        <div id="setup-qr" class="setup-qr"></div>
        <figcaption><b>1.</b> Entre na rede</figcaption>
      </figure>
      <figure class="setup-qr-item">
        <div id="setup-qr2" class="setup-qr"></div>
        <figcaption><b>2.</b> Abra a página</figcaption>
      </figure>
    </div>
    <div class="setup-url">ou abra no navegador: <b id="setup-url">http://10.42.0.1/setup</b></div>
  </div>
</section>`;

function renderNet() {
  let screen = document.getElementById("setup-screen");

  if (!NET || NET.mode !== "setup") {
    setupStreak = 0; lastQrKey = "";
    if (screen) screen.remove();
    return;
  }
  // Sair para online e imediato, entrar em setup exige confirmacao: uma leitura
  // isolada de "setup" no meio de uma reconexao jogaria a tela cheia por cima
  // do ticker por um instante.
  setupStreak++;
  if (setupStreak < SETUP_STREAK_MIN) return;

  if (!screen) {
    document.getElementById("stage").insertAdjacentHTML("beforeend", SETUP_HTML);
    screen = document.getElementById("setup-screen");
    lastQrKey = "";
  }
  const apSsid = NET.apSsid || "Skycroft-Setup";
  const apPass = NET.apPass || "";
  document.getElementById("setup-ssid").textContent = apSsid;
  document.getElementById("setup-url").textContent = NET.setupUrl || "http://10.42.0.1/setup";
  // Payload WiFi padrão (iOS/Android entram na rede ao escanear)
  const payload = apPass
    ? `WIFI:T:WPA;S:${apSsid};P:${apPass};;`
    : `WIFI:T:nopass;S:${apSsid};;`;
  const portalUrl = NET.setupUrl || "http://10.42.0.1/setup";
  const key = payload + "|" + portalUrl;
  if (key === lastQrKey) return; // evita recriar os QRs a cada broadcast
  lastQrKey = key;
  const draw = (id, data, fallback) => {
    const box = document.getElementById(id);
    if (!box) return;
    try {
      const qr = qrcode(0, "M");
      qr.addData(data);
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
    } catch (e) {
      box.textContent = fallback;
    }
  };
  draw("setup-qr", payload, apSsid);
  draw("setup-qr2", portalUrl, portalUrl);
}
function connectLive() {
  return fetch("/api/state", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("sem servidor"))))
    .then((snap) => {
      LIVE = true;
      applySnapshot(snap);
      const es = new EventSource("/api/stream");
      es.addEventListener("state", (ev) => {
        try { applySnapshot(JSON.parse(ev.data)); } catch {}
      });
      es.onerror = () => { /* o próprio EventSource reconecta */ };
      return true;
    })
    .catch(() => false);
}

/* ---- Boot ---- */
async function boot() {
  scaleStage();
  const startUi = currentDisplay().ui;
  if (startUi) CONTROL.ui = startUi;
  renderAll();
  updateClock(true);
  setInterval(updateClock, 1000); // barato: so toca no DOM quando o minuto vira
  // alterna o card em destaque; no modo fixo o pool tem 1 item, então não troca.
  setInterval(tickRotation, 5000); // destaque: 5 s por jogo
  setInterval(tickMosaic, 8000);

  // Atualiza o modo de rede independentemente do SSE.
  // Evita que o HDMI permaneça no setup após recuperar o Wi-Fi.
  let netPolling = false;

  async function refreshNet() {
    if (netPolling) return;
    netPolling = true;
    try {
      const response = await fetch("/api/net", {
        cache: "no-store",
        signal: AbortSignal.timeout(4000)
      });
      if (!response.ok) return;

      const current = await response.json();
      if (current.mode !== NET.mode ||
          current.ssid !== NET.ssid ||
          current.ip !== NET.ip) {
        NET = current;
        renderNet();
        updateRemoteQr();
      }
    } catch (e) {
      // Falha temporária: mantém o estado e tenta novamente.
    } finally {
      netPolling = false;
    }
  }

  await refreshNet();
  setInterval(refreshNet, 5000);

  const ok = await connectLive();
  if (!ok) {
    // standalone: anima placares localmente p/ a demo
    setInterval(simulateLive, 3500);
  }
}
document.addEventListener("DOMContentLoaded", boot);
