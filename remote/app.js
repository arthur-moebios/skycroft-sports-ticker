/* ===== Skycroft Ticker — Controle remoto (lógica) =====
 * Reflete o estado do servidor via SSE e envia comandos por POST /api/control. */

let SNAP = null; // último snapshot do servidor

const $ = (s) => document.querySelector(s);
const leagueLogo = (ab) => `https://a.espncdn.com/i/teamlogos/leagues/500/${ab.toLowerCase()}.png`;
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

/* ---- chave de acesso (QR "CONTROLE" da TV) ----
 * A TV mostra /remote#k=<32 hex>. O fragmento não vai ao servidor nem a logs;
 * aqui a chave é guardada e o fragmento some da barra de endereço. */
let KEY = "";
function lsGet(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } } // aba privativa lança
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
(function captarChave() {
  // Fragmento primeiro (não vai ao servidor nem a log). A query é o plano B:
  // um login interativo no caminho — o Cloudflare Access redireciona para
  // outra origem — perde o fragmento, e aí a chave chega em ?k=.
  const m = /^#k=([0-9a-f]{32})$/i.exec(location.hash);
  const q = new URLSearchParams(location.search).get("k") || "";
  if (m) {
    lsSet("sk", m[1]);
    try { history.replaceState(null, "", location.pathname + location.search); } catch {}
    KEY = m[1];
  } else if (/^[0-9a-f]{32}$/i.test(q)) {
    lsSet("sk", q);
    // tira o k= da barra de endereço e do histórico, preservando o resto
    const sp = new URLSearchParams(location.search); sp.delete("k");
    const qs = sp.toString();
    try { history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "")); } catch {}
    KEY = q;
  } else KEY = lsGet("sk");
  if (!/^[0-9a-f]{32}$/i.test(KEY)) KEY = "";
  // cookie para o EventSource, que não aceita cabeçalho customizado
  if (KEY) document.cookie = `sk=${KEY}; path=/; max-age=31536000; samesite=lax` + (location.protocol === "https:" ? "; secure" : "");
})();

/* fetch único para /api/*: leva a chave quando há (rede local não precisa) e
 * transforma 401 em estado de tela, não em erro. */
let UNAUTH = false;
function setUnauth(on) {
  UNAUTH = on;
  document.body.classList.toggle("unauth", on);
  if (on) setConn("off");
}
async function apiFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (KEY) headers["X-Skycroft-Key"] = KEY;
  const r = await fetch(path, { ...opts, headers });
  if (r.status === 401) setUnauth(true);
  else if (UNAUTH && r.ok) setUnauth(false);
  return r;
}

/* ---- envio de comandos ---- */
async function sendControl(patch) {
  try {
    const r = await apiFetch("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (r.ok) SNAP = await r.json(), render();
  } catch { toast("Sem conexão com o dispositivo"); }
}
/* envia ação de displays; responde com o snapshot novo, como /api/control */
async function sendDisplays(action, payload = {}) {
  try {
    const r = await apiFetch("/api/displays", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    if (r.ok) { SNAP = await r.json(); render(); return true; }
    if (r.status === 401) return false; // a tela de "não autorizado" já assumiu
    let msg = "Não foi possível aplicar"; try { msg = (await r.json()).error || msg; } catch {}
    toast(msg);
  } catch { toast("Sem conexão com o dispositivo"); }
  return false;
}
async function refresh() {
  toast("Atualizando…");
  try { await apiFetch("/api/refresh", { method: "POST" }); } catch { toast("Sem conexão"); }
}

/* ---- aparência ---- */
const DEFAULT_UI = { theme: "midnight", density: "comfortable", font: "system", fontScale: 1, detail: "rich", listCount: 4, showTicker: true, showClock: true, showFeaturedStats: true, sidePos: "right" };
const THEMES = [
  { id: "midnight", name: "Meia-noite", c: ["#0a1430", "#35d07f", "#4aa3ff"] },
  { id: "gridiron", name: "Gridiron", c: ["#0a1430", "#edc256", "#ff4b4b"] },
  { id: "hardwood", name: "Hardwood", c: ["#231708", "#ff8a1e", "#fff2df"] },
  { id: "arena", name: "Arena", c: ["#000000", "#ffb000", "#ff5a2a"] },
  { id: "broadcast", name: "Broadcast", c: ["#e9eef6", "#17935c", "#0d1830"] },
  { id: "stars", name: "Stars", c: ["#0e2150", "#e23b53", "#4aa3ff"] },
];
const LEAGUE_LOGO_MAP = {
  NFL: "https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png",
  NBA: "https://a.espncdn.com/i/teamlogos/leagues/500/nba.png",
  MLB: "https://a.espncdn.com/i/teamlogos/leagues/500/mlb.png",
  NHL: "https://a.espncdn.com/i/teamlogos/leagues/500/nhl.png",
};
function ui() { return { ...DEFAULT_UI, ...((control() && control().ui) || {}) }; }
function sendUi(patch) { sendControl({ ui: patch }); }

/* ---- helpers de dados ---- */
function control() { return (SNAP && SNAP.control) || { mode: "auto", fixedEventId: null, enabledLeagues: ["NFL", "NBA"], favorites: [], ui: { ...DEFAULT_UI } }; }
function catalog() { return (SNAP && SNAP.catalog) || [{ id: "NFL", name: "NFL" }, { id: "NBA", name: "NBA" }]; }
function favList() { const c = control(); return c.favorites && c.favorites.length ? c.favorites : (SNAP && SNAP.favorites) || []; }
function isFav(ab) { return favList().includes(ab); }
function teamByAbbr(ab) {
  for (const lg of (SNAP && SNAP.leagues) || [])
    for (const e of lg.events)
      for (const t of [e.home, e.away]) if (t.abbr === ab) return { ...t, league: lg.abbrev };
  return null;
}
function allGames() {
  const out = [];
  for (const lg of (SNAP && SNAP.leagues) || [])
    for (const e of lg.events) out.push({ ...e, league: lg.abbrev, leagueName: lg.name });
  return out;
}

/* ---- render ---- */
function render() {
  if (!SNAP) return;
  const c = control();

  // modo
  document.querySelectorAll("#mode-seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === c.mode));
  const pinned = c.mode === "fixed" && c.fixedEventId ? allGames().find((g) => g.id === c.fixedEventId) : null;
  $("#mode-hint").textContent = c.mode === "fixed" ? "fixo" : "ao vivo tem prioridade";
  $("#mode-note").textContent = pinned
    ? `Fixado: ${pinned.away.abbr} × ${pinned.home.abbr} (${pinned.league}).`
    : c.mode === "fixed"
    ? "Fixo, mas nenhum jogo selecionado — escolha abaixo."
    : "No automático, jogos ao vivo têm prioridade no exibidor.";

  // ligas (dinâmicas, do catálogo do servidor)
  renderLeagues(c);
  // aparência
  renderThemes();
  renderAppearance();
  // displays
  renderDisplays();
  syncEditor();

  // favoritos
  const favs = $("#favs");
  favs.innerHTML = "";
  favList().forEach((ab) => {
    const t = teamByAbbr(ab);
    const d = document.createElement("div");
    d.className = "fav";
    d.innerHTML =
      `<span class="star">★</span>` +
      (t && t.logo ? `<img src="${t.logo}" alt="" onerror="this.remove()">` : "") +
      `<span>${ab}</span><button class="rm" aria-label="Remover ${ab}">×</button>`;
    d.querySelector(".rm").onclick = () => sendControl({ favorites: favList().filter((x) => x !== ab) });
    favs.appendChild(d);
  });

  // jogos agrupados por liga
  const box = $("#games");
  const games = allGames();
  if (!games.length) { box.innerHTML = `<div class="empty">Nenhum jogo encontrado.</div>`; }
  else {
    box.innerHTML = "";
    for (const lg of (SNAP.leagues || [])) {
      if (!lg.events.length) continue;
      const head = document.createElement("div");
      head.className = "lg-head";
      head.innerHTML = `<img src="${leagueLogo(lg.abbrev)}" alt="" onerror="this.remove()">${lg.name}`;
      box.appendChild(head);
      // ao vivo primeiro, depois agendado, depois encerrado
      const rank = (e) => (e.state === "in" ? 0 : e.state === "pre" ? 1 : 2);
      [...lg.events].sort((a, b) => rank(a) - rank(b)).forEach((e) => box.appendChild(gameEl(e, lg)));
    }
  }

  // rodapé
  const ts = SNAP.updatedAt ? new Date(SNAP.updatedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
  $("#foot").textContent = "Atualizado " + ts + (SNAP.error ? " · erro ESPN" : "");
}

function teamRow(t) {
  const crest = t.logo ? `<img src="${t.logo}" alt="" onerror="this.remove()">` : "";
  const star = isFav(t.abbr) ? ` <span class="st">★</span>` : "";
  return `<div class="row">${crest}<span class="nm">${t.abbr}${star}</span><span class="sc">${t.score}</span></div>`;
}
function gameEl(e, lg) {
  const c = control();
  const fixed = c.mode === "fixed" && c.fixedEventId === e.id;
  const badge = e.state === "in" ? `<span class="badge in">● ${e.status || "AO VIVO"}</span>`
    : e.state === "post" ? `<span class="badge post">${e.status || "Final"}</span>`
    : `<span class="badge pre">${shortWhen(e.starts) || e.status || "Agendado"}</span>`;
  const b = document.createElement("button");
  b.className = "game" + (fixed ? " fixed" : "");
  b.innerHTML = `<div class="rows">${teamRow(e.away)}${teamRow(e.home)}</div>
    <div class="meta">${badge}${fixed ? '<span class="pin">no mostrador</span>' : ""}</div>`;
  b.onclick = () => {
    if (fixed) { sendControl({ mode: "auto" }); toast("Voltou ao automático"); }
    else { sendControl({ fixedEventId: e.id }); toast(`Fixado: ${e.away.abbr} × ${e.home.abbr}`); }
  };
  return b;
}
function shortWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso); if (isNaN(d)) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const t = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? t : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " + t;
}

/* ---- ligas (dinâmicas) ---- */
function renderLeagues(c) {
  const box = $("#league-chips");
  const enabled = new Set(c.enabledLeagues || []);
  box.innerHTML = "";
  catalog().forEach((lg) => {
    const b = document.createElement("button");
    b.className = "chip" + (enabled.has(lg.id) ? " on" : "");
    const logo = LEAGUE_LOGO_MAP[lg.id];
    b.innerHTML = (logo ? `<img src="${logo}" alt="" onerror="this.remove()">` : "") + esc(lg.name);
    b.onclick = () => toggleLeague(lg.id);
    box.appendChild(b);
  });
}
function toggleLeague(id) {
  const cur = new Set(control().enabledLeagues || []);
  cur.has(id) ? cur.delete(id) : cur.add(id);
  const next = [...cur];
  if (!next.length) return toast("Mantenha ao menos uma liga");
  sendControl({ enabledLeagues: next });
}

/* ---- temas ---- */
function renderThemes() {
  const box = $("#themes");
  const cur = ui().theme;
  if (box.childElementCount !== THEMES.length) {
    box.innerHTML = "";
    THEMES.forEach((t) => {
      const b = document.createElement("button");
      b.className = "sw"; b.dataset.theme = t.id;
      b.innerHTML = `<span class="prev" style="background:${t.c[0]}"><i style="background:${t.c[0]}"></i><i style="background:${t.c[1]}"></i><i style="background:${t.c[2]}"></i></span><span class="nm">${t.name}</span>`;
      b.onclick = () => sendUi({ theme: t.id });
      box.appendChild(b);
    });
  }
  box.querySelectorAll(".sw").forEach((b) => b.classList.toggle("on", b.dataset.theme === cur));
}

/* ---- reflete estado dos controles de aparência ---- */
function renderAppearance() {
  const u = ui();
  segOn("#font-seg", "font", u.font);
  segOn("#density-seg", "density", u.density);
  segOn("#detail-seg", "detail", u.detail);
  const scale = $("#scale"); if (document.activeElement !== scale) scale.value = u.fontScale;
  $("#scale-val").textContent = Math.round(u.fontScale * 100) + "%";
  const count = $("#count"); if (document.activeElement !== count) count.value = u.listCount;
  $("#count-val").textContent = u.listCount;
  $("#sw-ticker").checked = u.showTicker !== false;
  $("#sw-clock").checked = u.showClock !== false;
  $("#sw-featured-stats").checked = u.showFeaturedStats !== false;
  $("#sw-side").checked = u.sidePos === "left";
}
function segOn(sel, key, val) {
  document.querySelectorAll(`${sel} button`).forEach((b) => b.classList.toggle("on", b.dataset[key] === val));
}

/* ===== Displays: lista, criação e editor de blocos ===== */
const GRID_COLS = 12, GRID_ROWS = 8, MAX_DISPLAYS = 12, MAX_BLOCKS = 10;
const BLOCK_TYPES = {
  spotlight: "Destaque", mosaic: "Mosaico", list: "Lista", ticker: "Faixa", clock: "Relógio", brand: "Marca",
};
const STATE_LABELS = [["in", "Ao vivo"], ["pre", "Futuros"], ["post", "Encerrados"]];
function displays() { return (SNAP && SNAP.displays) || []; }
function activeId() { return SNAP && SNAP.activeDisplayId; }
function displayById(id) { return displays().find((d) => d.id === id); }
function elOf(html, cls) { const d = document.createElement("div"); if (cls) d.className = cls; d.innerHTML = html; return d; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---- lista ---- */
function renderDisplays() {
  const box = $("#dsp-list");
  const list = displays();
  if (!list.length) { box.innerHTML = `<div class="empty">Sem displays neste dispositivo.</div>`; return; }
  box.innerHTML = "";
  list.forEach((d, i) => {
    const on = d.id === activeId();
    const it = elOf(
      `<button class="dsp-main" aria-label="Ativar ${esc(d.name)}">` +
        `<span class="dsp-name">${esc(d.name)}</span>` +
        (d.builtin ? `<span class="tag">padrão</span>` : "") +
        (on ? `<span class="tag act">ativo</span>` : "") +
      `</button>` +
      `<div class="dsp-acts">` +
        `<button data-a="up" aria-label="Subir" ${i === 0 ? "disabled" : ""}>↑</button>` +
        `<button data-a="down" aria-label="Descer" ${i === list.length - 1 ? "disabled" : ""}>↓</button>` +
        `<button data-a="edit">${d.builtin ? "Ver" : "Editar"}</button>` +
        `<button data-a="dup">Duplicar</button>` +
        (d.builtin ? "" : `<button data-a="ren">Renomear</button><button data-a="del" class="danger">Apagar</button>`) +
      `</div>`,
      "dsp" + (on ? " on" : "")
    );
    it.querySelector(".dsp-main").onclick = () => { if (!on) sendDisplays("activate", { id: d.id }).then((ok) => ok && toast("Ativo: " + d.name)); };
    it.querySelector(".dsp-acts").onclick = (e) => {
      const b = e.target.closest("button"); if (!b || b.disabled) return;
      const a = b.dataset.a;
      if (a === "up" || a === "down") {
        const ids = list.map((x) => x.id), j = a === "up" ? i - 1 : i + 1;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        sendDisplays("reorder", { ids });
      } else if (a === "edit") openEditor(d.id);
      else if (a === "dup") duplicateDisplay(d);
      else if (a === "ren") {
        const n = (prompt("Novo nome", d.name) || "").trim();
        if (n && n !== d.name) sendDisplays("update", { id: d.id, name: n });
      } else if (a === "del") {
        if (confirm(`Apagar o display "${d.name}"?`)) sendDisplays("delete", { id: d.id });
      }
    };
    box.appendChild(it);
  });
  $("#dsp-new").disabled = list.length >= MAX_DISPLAYS;
}
function duplicateDisplay(d) {
  if (displays().length >= MAX_DISPLAYS) return toast(`Máximo de ${MAX_DISPLAYS} displays`);
  return sendDisplays("create", { name: d.name + " (cópia)", from: d.id }).then((ok) => ok && toast("Duplicado"));
}

/* ---- criar ---- */
let createFrom = "mosaic";
function openCreate() {
  if (displays().length >= MAX_DISPLAYS) return toast(`Máximo de ${MAX_DISPLAYS} displays`);
  $("#cr-name").value = "";
  const box = $("#cr-from"); box.innerHTML = "";
  const opts = [["mosaic", "Preset mosaico"], ["spotlight", "Preset destaque"], ["blank", "Em branco"],
    ...displays().map((d) => [d.id, "Duplicar: " + d.name])];
  if (!opts.some((o) => o[0] === createFrom)) createFrom = "mosaic";
  opts.forEach(([id, label]) => {
    const b = document.createElement("button");
    b.className = "opt" + (id === createFrom ? " on" : ""); b.textContent = label;
    b.onclick = () => { createFrom = id; box.querySelectorAll(".opt").forEach((x) => x.classList.toggle("on", x === b)); };
    box.appendChild(b);
  });
  $("#dsp-create").hidden = false;
}
$("#dsp-new").onclick = openCreate;
$("#cr-close").onclick = () => { $("#dsp-create").hidden = true; };
$("#cr-ok").onclick = async () => {
  const name = $("#cr-name").value.trim();
  if (!name) return toast("Dê um nome ao display");
  if (await sendDisplays("create", { name, from: createFrom })) { $("#dsp-create").hidden = true; toast("Display criado"); }
};

/* ---- editor ---- */
let EDIT = null; // { id, name, blocks, sel, dirty }
const cloneBlocks = (bs) => JSON.parse(JSON.stringify(bs || [])).map(normBlock);
function normBlock(b) {
  b.opts = b.opts || {};
  b.filters = { leagues: [], states: ["in", "pre", "post"], favoritesOnly: false, ...(b.filters || {}) };
  return b;
}
function openEditor(id) {
  const d = displayById(id); if (!d) return;
  EDIT = { id, name: d.name, blocks: cloneBlocks(d.blocks), sel: null, dirty: false };
  $("#editor").hidden = false; document.body.classList.add("lock");
  drawEditor();
}
function closeEditor() {
  if (EDIT && EDIT.dirty && !confirm("Descartar alterações não salvas?")) return;
  EDIT = null; $("#editor").hidden = true; document.body.classList.remove("lock");
}
/* chamado a cada snapshot: mantém o rascunho se há edição pendente */
function syncEditor() {
  if (!EDIT) return;
  const d = displayById(EDIT.id);
  if (!d) { EDIT = null; $("#editor").hidden = true; document.body.classList.remove("lock"); return toast("Display removido"); }
  if (d.builtin || !EDIT.dirty) {
    EDIT.name = d.name; EDIT.blocks = cloneBlocks(d.blocks);
    if (EDIT.sel != null && EDIT.sel >= EDIT.blocks.length) EDIT.sel = null;
    drawEditor();
  }
}
function touch() { EDIT.dirty = true; drawEditor(); }

/* posiciona um bloco na prévia (porcentagem da grade) */
// Dois blocos no mesmo lugar na TV viram um por cima do outro: o editor passa
// a recusar a posicao em vez de aceitar e deixar o estrago para depois.
function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
function fits(cand, skip) {
  if (cand.x < 0 || cand.y < 0 || cand.w < 1 || cand.h < 1) return false;
  if (cand.x + cand.w > GRID_COLS || cand.y + cand.h > GRID_ROWS) return false;
  return !EDIT.blocks.some((b, j) => j !== skip && overlaps(cand, b));
}

function placeEl(el, b) {
  el.style.left = (b.x / GRID_COLS * 100) + "%"; el.style.top = (b.y / GRID_ROWS * 100) + "%";
  el.style.width = (b.w / GRID_COLS * 100) + "%"; el.style.height = (b.h / GRID_ROWS * 100) + "%";
}
/* alças de 44x44 px, centradas perto do canto; recuo proporcional ao bloco para não cobri-lo todo */
function placeHandles(g, b) {
  const r = g.getBoundingClientRect(); if (!r.width) return;
  const bw = b.w * r.width / GRID_COLS, bh = b.h * r.height / GRID_ROWS;
  const inset = clamp(Math.min(bw, bh) / 3, 6, 30);
  const L = b.x * r.width / GRID_COLS, T = b.y * r.height / GRID_ROWS;
  const tl = g.querySelector(".hdl-tl"), br = g.querySelector(".hdl-br");
  if (tl) { tl.style.left = (L + inset - 44) + "px"; tl.style.top = (T + inset - 44) + "px"; tl.style.setProperty("--dx", (44 - inset) + "px"); }
  if (br) { br.style.left = (L + bw - inset) + "px"; br.style.top = (T + bh - inset) + "px"; br.style.setProperty("--dx", inset + "px"); }
}
/* arrastar/mover um bloco (Pointer Events: dedo e mouse). Não redesenha o editor durante o gesto. */
function attachDrag(el, g, i, ro) {
  let st = null;
  el.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    const b = EDIT.blocks[i], r = g.getBoundingClientRect();
    st = { id: e.pointerId, sx: e.clientX, sy: e.clientY, r, o: { x: b.x, y: b.y }, moved: false, ghost: null, wasSel: EDIT.sel === i };
    if (ro) return;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    DRAGGING = true;
    g.querySelectorAll(".blk").forEach((n) => n.classList.remove("sel"));
    el.classList.add("sel");
  });
  el.addEventListener("pointermove", (e) => {
    if (!st || e.pointerId !== st.id || ro) return;
    e.preventDefault();
    const b = EDIT.blocks[i], dx = e.clientX - st.sx, dy = e.clientY - st.sy;
    if (!st.moved && Math.hypot(dx, dy) < 6) return;  // tolerância de toque
    if (!st.moved) {
      st.moved = true; el.classList.add("drag");
      st.ghost = document.createElement("div"); st.ghost.className = "gp-ghost"; g.appendChild(st.ghost);
      g.querySelectorAll(".hdl").forEach((h) => (h.style.display = "none"));
    }
    const cw = st.r.width / GRID_COLS, ch = st.r.height / GRID_ROWS;
    // posição final encaixada, sempre dentro da grade
    const nx = clamp(Math.round(st.o.x + dx / cw), 0, GRID_COLS - b.w);
    const ny = clamp(Math.round(st.o.y + dy / ch), 0, GRID_ROWS - b.h);
    const cand = { x: nx, y: ny, w: b.w, h: b.h };
    const ok = fits(cand, i);
    if (ok) { st.nx = nx; st.ny = ny; }   // so guarda posicao valida
    st.ghost.classList.toggle("bad", !ok);
    placeEl(st.ghost, ok ? cand : { x: st.nx ?? b.x, y: st.ny ?? b.y, w: b.w, h: b.h });
    // o bloco acompanha o dedo, preso aos limites da grade
    el.style.left = clamp(st.o.x * cw + dx, 0, (GRID_COLS - b.w) * cw) / st.r.width * 100 + "%";
    el.style.top = clamp(st.o.y * ch + dy, 0, (GRID_ROWS - b.h) * ch) / st.r.height * 100 + "%";
  });
  const end = (e, cancel) => {
    if (!st || e.pointerId !== st.id) return;
    const s = st; st = null; DRAGGING = false;
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    if (ro) { EDIT.sel = EDIT.sel === i ? null : i; drawEditor(); return; }
    const b = EDIT.blocks[i];
    if (s.moved && !cancel) {
      const nx = s.nx ?? b.x, ny = s.ny ?? b.y;   // sem posicao valida: fica onde estava
      const ch = nx !== b.x || ny !== b.y;
      b.x = nx; b.y = ny; EDIT.sel = i;
      if (ch) return touch();
      return drawEditor();
    }
    if (s.moved) return drawEditor();  // cancelado: volta ao lugar
    EDIT.sel = s.wasSel ? null : i;  // toque simples: seleciona / desmarca
    drawEditor();
    // Nao rola ate a lista: levar o formulario para a tela joga a grade para
    // fora e o usuario perde a referencia visual do que acabou de tocar.
  };
  el.addEventListener("pointerup", (e) => end(e, false));
  el.addEventListener("pointercancel", (e) => end(e, true));
}
/* redimensionar pelas alças: k = "br" (canto inferior direito) ou "tl" (superior esquerdo) */
function attachResize(h, g, i, k) {
  let st = null;
  h.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    e.preventDefault(); e.stopPropagation();
    const b = EDIT.blocks[i];
    st = { id: e.pointerId, sx: e.clientX, sy: e.clientY, r: g.getBoundingClientRect(), o: { x: b.x, y: b.y, w: b.w, h: b.h } };
    try { h.setPointerCapture(e.pointerId); } catch (_) {}
    DRAGGING = true;
    h.classList.add("on");
  });
  h.addEventListener("pointermove", (e) => {
    if (!st || e.pointerId !== st.id) return;
    e.preventDefault();
    const o = st.o, b = EDIT.blocks[i];
    const dx = Math.round((e.clientX - st.sx) / (st.r.width / GRID_COLS));
    const dy = Math.round((e.clientY - st.sy) / (st.r.height / GRID_ROWS));
    let n;
    if (k === "br") n = { x: o.x, y: o.y, w: clamp(o.w + dx, 1, GRID_COLS - o.x), h: clamp(o.h + dy, 1, GRID_ROWS - o.y) };
    else {
      const x = clamp(o.x + dx, 0, o.x + o.w - 1), y = clamp(o.y + dy, 0, o.y + o.h - 1);
      n = { x, y, w: o.x + o.w - x, h: o.y + o.h - y };
    }
    if (!fits(n, i)) return;        // recusa invadir outro bloco ou sair da grade
    st.n = n; Object.assign(b, n);  // rascunho em memória; o redesenho completo vem ao soltar
    const el = g.querySelectorAll(".blk")[i]; if (el) placeEl(el, b);
    placeHandles(g, b);
  });
  const end = (e, cancel) => {
    if (!st || e.pointerId !== st.id) return;
    const s = st; st = null; DRAGGING = false;
    try { h.releasePointerCapture(e.pointerId); } catch (_) {}
    if (cancel) Object.assign(EDIT.blocks[i], s.o);
    const changed = !cancel && s.n && ["x", "y", "w", "h"].some((q) => s.n[q] !== s.o[q]);
    if (changed) touch(); else drawEditor();
  };
  h.addEventListener("pointerup", (e) => end(e, false));
  h.addEventListener("pointercancel", (e) => end(e, true));
}

let DRAGGING = false;
function drawEditor() {
  if (DRAGGING) return;  // snapshot do servidor não pode destruir o gesto em curso
  const d = displayById(EDIT.id); if (!d) return;
  const ro = !!d.builtin, body = $("#ed-body");
  const keepScroll = body.scrollTop;
  $("#ed-title").textContent = ro ? d.name + " (padrão)" : "Editar display";
  $("#ed-save").hidden = ro; $("#ed-save").disabled = !EDIT.dirty;
  body.innerHTML = "";

  if (ro) body.appendChild(elOf(`Este é um display padrão: blocos, grade e nome não mudam. A aparência continua editável no cartão "Aparência".<button class="primary" id="ed-dup">Duplicar para editar</button>`, "note ro"));
  else body.appendChild(elOf(`<label class="field-label">Nome</label><input class="txt" id="ed-name" maxlength="40" value="${esc(EDIT.name)}">`));

  // prévia da grade 12x8, 16:9
  body.appendChild(elOf(`<label class="field-label">Grade ${GRID_COLS}×${GRID_ROWS}</label>`));
  const wrap = elOf("", "gridwrap");
  const g = elOf("", "gridprev" + (ro ? " ro" : ""));
  wrap.appendChild(g);
  EDIT.blocks.forEach((b, i) => {
    const c = document.createElement("button");
    c.type = "button";
    c.className = `blk t-${b.type}` + (EDIT.sel === i ? " sel" : "");
    c.textContent = BLOCK_TYPES[b.type] || b.type;
    placeEl(c, b);
    attachDrag(c, g, i, ro);
    g.appendChild(c);
  });
  if (!ro && EDIT.sel != null && EDIT.blocks[EDIT.sel]) {
    for (const k of ["tl", "br"]) {
      const h = document.createElement("div");
      h.className = "hdl hdl-" + k; h.dataset.k = k;
      h.innerHTML = "<i></i>";
      attachResize(h, g, EDIT.sel, k);
      g.appendChild(h);
    }
  }
  body.appendChild(wrap);
  // depois do appendChild: antes disso a grade esta fora do documento e o
  // getBoundingClientRect devolve zero, entao as alcas ficavam encalhadas no
  // canto superior esquerdo e nao dava para pegar nenhuma.
  if (!ro && EDIT.sel != null && EDIT.blocks[EDIT.sel]) placeHandles(g, EDIT.blocks[EDIT.sel]);
  if (EDIT.sel != null && EDIT.blocks[EDIT.sel]) {
    const sb = EDIT.blocks[EDIT.sel];
    body.appendChild(elOf(`${BLOCK_TYPES[sb.type] || esc(sb.type)}: ${sb.w}×${sb.h} na coluna ${sb.x + 1}, linha ${sb.y + 1}` + (ro ? "" : " · arraste para mover; use as alças para redimensionar"), "gridinfo"));
  } else if (!ro) body.appendChild(elOf("Toque num bloco para selecionar; arraste para mover.", "gridinfo"));

  // lista de blocos
  body.appendChild(elOf(`<label class="field-label">Blocos <span class="val">${EDIT.blocks.length}/${MAX_BLOCKS}</span></label>`));
  const list = elOf("", "blk-list");
  EDIT.blocks.forEach((b, i) => {
    const it = elOf(
      `<button class="blk-head"><span class="sq t-${b.type}"></span><span class="bn">${BLOCK_TYPES[b.type] || esc(b.type)}</span><span class="bp">${b.w}×${b.h} · col ${b.x + 1}, linha ${b.y + 1}</span></button>`,
      "blk-item" + (EDIT.sel === i ? " open" : "")
    );
    it.id = "blk-" + i;
    it.querySelector(".blk-head").onclick = () => { EDIT.sel = EDIT.sel === i ? null : i; drawEditor(); };
    if (EDIT.sel === i) it.appendChild(blockForm(b, i, ro));
    list.appendChild(it);
  });
  if (!EDIT.blocks.length) list.appendChild(elOf("Nenhum bloco.", "empty"));
  body.appendChild(list);

  if (!ro) {
    const add = elOf(`<label class="field-label">Adicionar bloco</label><div class="opts" id="ed-add"></div>`);
    Object.entries(BLOCK_TYPES).forEach(([t, n]) => {
      const bt = document.createElement("button"); bt.className = "opt"; bt.textContent = "+ " + n;
      bt.disabled = EDIT.blocks.length >= MAX_BLOCKS;
      bt.onclick = () => addBlock(t);
      add.querySelector("#ed-add").appendChild(bt);
    });
    body.appendChild(add);
    $("#ed-name").oninput = (e) => { EDIT.name = e.target.value; EDIT.dirty = true; $("#ed-save").disabled = false; };
  } else $("#ed-dup").onclick = async () => { const dd = displayById(EDIT.id); EDIT.dirty = false; closeEditor(); if (dd) { await duplicateDisplay(dd); } };
  body.scrollTop = keepScroll;
}

/* acha um canto livre para 4x2 (ou cai em 0,0) */
function freeSpot(w, h) {
  const occ = (x, y) => EDIT.blocks.some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
  for (let y = 0; y + h <= GRID_ROWS; y++)
    for (let x = 0; x + w <= GRID_COLS; x++) {
      let free = true;
      for (let j = 0; j < h && free; j++) for (let i = 0; i < w; i++) if (occ(x + i, y + j)) { free = false; break; }
      if (free) return { x, y };
    }
  return { x: 0, y: 0 };
}
function addBlock(type) {
  if (EDIT.blocks.length >= MAX_BLOCKS) return toast(`Máximo de ${MAX_BLOCKS} blocos`);
  const w = type === "ticker" ? GRID_COLS : 4, h = type === "ticker" || type === "clock" || type === "brand" ? 1 : 2;
  const b = normBlock({ id: "b" + Date.now().toString(36), type, ...freeSpot(w, h), w, h, opts: defaultOpts(type) });
  EDIT.blocks.push(b); EDIT.sel = EDIT.blocks.length - 1; touch();
}
function defaultOpts(t) {
  return t === "mosaic" ? { cols: 3, showScore: true, showClock: true, showLogo: true, showOdds: false } : t === "list" ? { count: 4 } : {};
}

/* formulário de um bloco */
function stepper(label, val, min, max, set) {
  const s = elOf(`<span class="st-l">${label}</span><button aria-label="Menos">−</button><b>${val}</b><button aria-label="Mais">+</button>`, "stepper");
  const [m, p] = s.querySelectorAll("button");
  m.disabled = val <= min; p.disabled = val >= max;
  m.onclick = () => { set(val - 1); touch(); };
  p.onclick = () => { set(val + 1); touch(); };
  return s;
}
function toggleRow(label, on, set) {
  const l = document.createElement("label"); l.className = "switch";
  l.innerHTML = `<span>${label}</span><input type="checkbox"${on ? " checked" : ""}><i></i>`;
  l.querySelector("input").onchange = (e) => { set(e.target.checked); touch(); };
  return l;
}
function blockForm(b, i, ro) {
  const f = elOf("", "blk-form");
  const fs = document.createElement("fieldset"); fs.disabled = ro; f.appendChild(fs);

  const sel = document.createElement("select"); sel.className = "txt";
  Object.entries(BLOCK_TYPES).forEach(([t, n]) => { const o = new Option(n, t); o.selected = t === b.type; sel.add(o); });
  sel.onchange = () => { b.type = sel.value; b.opts = defaultOpts(b.type); touch(); };
  fs.appendChild(elOf(`<label class="field-label">Tipo</label>`)); fs.appendChild(sel);

  const fine = document.createElement("details"); fine.className = "fine";
  fine.innerHTML = `<summary>Ajuste fino (números)</summary>`;
  const grid = elOf("", "steppers");
  grid.append(
    stepper("x", b.x, 0, GRID_COLS - b.w, (v) => (b.x = v)),
    stepper("y", b.y, 0, GRID_ROWS - b.h, (v) => (b.y = v)),
    stepper("largura", b.w, 1, GRID_COLS - b.x, (v) => (b.w = v)),
    stepper("altura", b.h, 1, GRID_ROWS - b.y, (v) => (b.h = v))
  );
  fine.appendChild(grid); fs.appendChild(fine);

  if (b.type === "mosaic") {
    fs.appendChild(elOf(`<label class="field-label">Colunas do mosaico</label>`));
    const seg = elOf([2, 3, 4].map((n) => `<button data-n="${n}" class="${(b.opts.cols || 3) === n ? "on" : ""}">${n}</button>`).join(""), "seg three");
    seg.onclick = (e) => { const x = e.target.closest("button"); if (x) { b.opts.cols = +x.dataset.n; touch(); } };
    fs.appendChild(seg);
    const sw = elOf("", "switches");
    [["showScore", "Placar"], ["showClock", "Tempo de jogo"], ["showLogo", "Escudos"], ["showOdds", "Odds"]].forEach(([k, l]) =>
      sw.appendChild(toggleRow(l, b.opts[k] !== false && (k !== "showOdds" || !!b.opts[k]), (v) => (b.opts[k] = v))));
    fs.appendChild(sw);
  }
  if (b.type === "spotlight") {
    fs.appendChild(elOf(`<label class="field-label">Informações extras</label>`));
    const sw = elOf("", "switches");
    [["showRecord", "Campanha (V-D)", true], ["showTopScorers", "Top 5 pontuadores (NBA)", true], ["showLinescore", "Placar por período", false],
     ["showWinProb", "Probabilidade de vitória", false], ["showSituation", "Situação (posse, down, lance)", false],
     ["holdOnScore", "Parar no jogo que pontuou", false]].forEach(([k, l, def]) =>
      sw.appendChild(toggleRow(l, b.opts[k] === undefined ? def : !!b.opts[k], (v) => (b.opts[k] = v))));
    fs.appendChild(sw);
  }
  if (b.type === "list") {
    fs.appendChild(elOf(`<label class="field-label">Jogos na lista</label>`));
    fs.appendChild(stepper("jogos", b.opts.count || 4, 1, 10, (v) => (b.opts.count = v)));
  }

  // Filtros dobrados: abertos, as 21 ligas mais os interruptores empurram a
  // grade para fora da tela e o usuario perde de vista o bloco que tocou.
  const filtros = document.createElement("details"); filtros.className = "fine";
  filtros.innerHTML = `<summary>Filtros (ligas e situação)</summary>`;
  const fb = elOf("", "filtros-corpo");
  filtros.appendChild(fb); fs.appendChild(filtros);

  fb.appendChild(elOf(`<label class="field-label">Ligas <span class="val">${b.filters.leagues.length ? "" : "todas"}</span></label>`));
  const chips = elOf("", "chips");
  catalog().forEach((lg) => {
    const c = document.createElement("button"); c.type = "button";
    c.className = "chip" + (b.filters.leagues.includes(lg.id) ? " on" : ""); c.textContent = lg.name;
    c.onclick = () => {
      const s = new Set(b.filters.leagues); s.has(lg.id) ? s.delete(lg.id) : s.add(lg.id);
      b.filters.leagues = [...s]; touch();
    };
    chips.appendChild(c);
  });
  fb.appendChild(chips);

  const sw2 = elOf("", "switches");
  STATE_LABELS.forEach(([k, l]) => sw2.appendChild(toggleRow(l, b.filters.states.includes(k), (v) => {
    const s = new Set(b.filters.states); v ? s.add(k) : s.delete(k);
    b.filters.states = ["in", "pre", "post"].filter((x) => s.has(x));
  })));
  sw2.appendChild(toggleRow("Só favoritos", !!b.filters.favoritesOnly, (v) => (b.filters.favoritesOnly = v)));
  fb.appendChild(sw2);

  if (!ro) {
    const rm = document.createElement("button"); rm.className = "danger wide"; rm.textContent = "Remover bloco";
    rm.onclick = () => { EDIT.blocks.splice(i, 1); EDIT.sel = null; touch(); };
    f.appendChild(rm);
  }
  return f;
}

$("#ed-close").onclick = closeEditor;
$("#ed-save").onclick = async () => {
  if (!EDIT || !EDIT.dirty) return;
  const name = EDIT.name.trim();
  if (!name) return toast("Dê um nome ao display");
  // valida de novo no cliente (o servidor também clampeia)
  for (const b of EDIT.blocks) {
    b.w = clamp(b.w, 1, GRID_COLS); b.h = clamp(b.h, 1, GRID_ROWS);
    b.x = clamp(b.x, 0, GRID_COLS - b.w); b.y = clamp(b.y, 0, GRID_ROWS - b.h);
    if (!b.filters.states.length) return toast("Cada bloco precisa de ao menos um estado de jogo");
  }
  const id = EDIT.id;
  if (await sendDisplays("update", { id, name, blocks: EDIT.blocks })) {
    if (EDIT) EDIT.dirty = false; // render() já recarregou o rascunho do servidor
    syncEditor(); toast("Salvo");
  }
};

/* ---- toast ---- */
let toastT = null;
function toast(msg) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 1900);
}

/* ---- conexão ---- */
function setConn(state) {
  const c = $("#conn"); c.className = "conn " + state;
  $("#conn-text").textContent = state === "live" ? "ao vivo" : state === "off" ? "offline" : "conectando…";
}
let sseTry = 0;
function connect() {
  if (UNAUTH) return;
  const es = new EventSource("/api/stream" + (KEY ? "?k=" + KEY : ""));
  es.addEventListener("state", (ev) => {
    try { SNAP = JSON.parse(ev.data); sseTry = 0; if (UNAUTH) setUnauth(false); setConn("live"); render(); } catch {}
  });
  es.onopen = () => { sseTry = 0; setConn("live"); };
  es.onerror = async () => {
    setConn("off");
    if (es.readyState !== EventSource.CLOSED) return; // o navegador reconecta sozinho
    // fechou de vez (ex.: 401): o EventSource não expõe o status, então sonda a API
    try {
      const r = await apiFetch("/api/state", { cache: "no-store" });
      if (r.status === 401) return; // não autorizado: sem reconexão, só o QR resolve
    } catch {}
    setTimeout(connect, Math.min(30000, 2000 * 2 ** sseTry++)); // recuo exponencial
  };
}

/* ---- eventos de UI ---- */
document.querySelectorAll("#mode-seg button").forEach((b) => {
  b.onclick = () => {
    if (b.dataset.mode === "auto") sendControl({ mode: "auto" });
    else sendControl({ mode: "fixed" }); // fixo sem evento: pede escolher na lista
  };
});
// aparência: segmentados
$("#font-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) sendUi({ font: b.dataset.font }); });
$("#density-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) sendUi({ density: b.dataset.density }); });
$("#detail-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) sendUi({ detail: b.dataset.detail }); });
// sliders: atualiza o rótulo ao arrastar, envia ao soltar
$("#scale").addEventListener("input", (e) => { $("#scale-val").textContent = Math.round(e.target.value * 100) + "%"; });
$("#scale").addEventListener("change", (e) => sendUi({ fontScale: parseFloat(e.target.value) }));
$("#count").addEventListener("input", (e) => { $("#count-val").textContent = e.target.value; });
$("#count").addEventListener("change", (e) => sendUi({ listCount: parseInt(e.target.value, 10) }));
// switches
$("#sw-ticker").addEventListener("change", (e) => sendUi({ showTicker: e.target.checked }));
$("#sw-clock").addEventListener("change", (e) => sendUi({ showClock: e.target.checked }));
$("#sw-featured-stats").addEventListener("change", (e) => sendUi({ showFeaturedStats: e.target.checked }));
$("#sw-side").addEventListener("change", (e) => sendUi({ sidePos: e.target.checked ? "left" : "right" }));
$("#fav-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const v = $("#fav-input").value.toUpperCase().trim();
  if (!v) return;
  if (isFav(v)) { toast(v + " já é favorito"); $("#fav-input").value = ""; return; }
  sendControl({ favorites: [...favList(), v] });
  $("#fav-input").value = "";
});
$("#refresh").onclick = refresh;

/* ---- boot ---- */
apiFetch("/api/state", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : null))
  .then((s) => { if (!s) return; SNAP = s; setConn("live"); render(); })
  .catch(() => setConn("off"));
connect();

// O iOS ignora user-scalable=no desde o iOS 10: o pinch so morre no JS.
for (const ev of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/remote/sw.js")
    // Forca a checagem de versao a cada carga: sem isso um service worker
    // antigo (cache-first) pode continuar servindo o app velho por dias.
    .then((reg) => { try { reg.update(); } catch {} })
    .catch(() => {});
}
