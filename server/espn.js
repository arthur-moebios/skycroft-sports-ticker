/* ===== Skycroft Ticker — coletor ESPN =====
 * Reaproveita os endpoints públicos da ESPN (mesmos do app Laravel).
 * Catálogo de ligas extensível — basta adicionar uma linha em CATALOG.
 * Sem dependências externas: usa o fetch nativo do Node (>=18).
 */

// id = chave interna/abbrev; path = caminho ESPN (esporte/liga).
// kind: "match" (placar home/away), "race" (F1) ou "card" (UFC) — muda o normalizador.
const CATALOG = [
  { id: "NFL", name: "NFL", path: "football/nfl", sport: "football", kind: "match" },
  { id: "NBA", name: "NBA", path: "basketball/nba", sport: "basketball", kind: "match" },
  { id: "MLB", name: "MLB", path: "baseball/mlb", sport: "baseball", kind: "match" },
  { id: "NHL", name: "NHL", path: "hockey/nhl", sport: "hockey", kind: "match" },
  { id: "PL", name: "Premier League", path: "soccer/eng.1", sport: "soccer", kind: "match" },
  { id: "UCL", name: "Champions League", path: "soccer/uefa.champions", sport: "soccer", kind: "match" },
  { id: "BRA", name: "Brasileirão", path: "soccer/bra.1", sport: "soccer", kind: "match" },
  { id: "NCAAF", name: "College Football", path: "football/college-football", sport: "football", kind: "match" },
  { id: "NCAAB", name: "College Basketball", path: "basketball/mens-college-basketball", sport: "basketball", kind: "match" },
  { id: "LALIGA", name: "La Liga", path: "soccer/esp.1", sport: "soccer", kind: "match" },
  { id: "SERIEA", name: "Serie A", path: "soccer/ita.1", sport: "soccer", kind: "match" },
  { id: "BUNDES", name: "Bundesliga", path: "soccer/ger.1", sport: "soccer", kind: "match" },
  { id: "LIGUE1", name: "Ligue 1", path: "soccer/fra.1", sport: "soccer", kind: "match" },
  { id: "BRAB", name: "Brasileirão Série B", path: "soccer/bra.2", sport: "soccer", kind: "match" },
  // slug da ESPN é "brazil" com z, não "brasil".
  { id: "COPABR", name: "Copa do Brasil", path: "soccer/bra.copa_do_brazil", sport: "soccer", kind: "match" },
  { id: "LIB", name: "Libertadores", path: "soccer/conmebol.libertadores", sport: "soccer", kind: "match" },
  { id: "SUDAM", name: "Sul-Americana", path: "soccer/conmebol.sudamericana", sport: "soccer", kind: "match" },
  { id: "MLS", name: "MLS", path: "soccer/usa.1", sport: "soccer", kind: "match" },
  { id: "WNBA", name: "WNBA", path: "basketball/wnba", sport: "basketball", kind: "match" },
  { id: "UFC", name: "UFC", path: "mma/ufc", sport: "mma", kind: "card" },
  { id: "F1", name: "Fórmula 1", path: "racing/f1", sport: "racing", kind: "race" },
];
const BY_ID = Object.fromEntries(CATALOG.map((l) => [l.id, l]));

const stateMap = { pre: "pre", in: "in", post: "post" };

// Um endpoint pendurado travaria a coleta inteira, que e sequencial por natureza.
const FETCH_TIMEOUT_MS = Number(process.env.SKYCROFT_ESPN_TIMEOUT_MS) || 8000;
// Teto por liga: sabado de NCAAF/NCAAB passa de 150 jogos, e o snapshot inteiro
// vai por SSE pra TV e pro celular a cada 30s. Corta pelo que menos interessa.
const EVENT_CAP = Number(process.env.SKYCROFT_EVENT_CAP) || 60;
const STATE_RANK = { in: 0, pre: 1, post: 2 };

// Ao vivo primeiro, depois os que vao comecar (por horario), depois encerrados.
function capEvents(events) {
  if (events.length <= EVENT_CAP) return events;
  return [...events]
    .sort((a, b) => {
      const d = (STATE_RANK[a.state] ?? 3) - (STATE_RANK[b.state] ?? 3);
      if (d !== 0) return d;
      return String(a.starts || "").localeCompare(String(b.starts || ""));
    })
    .slice(0, EVENT_CAP);
}

function normTeam(c) {
  return {
    abbr: c.team?.abbreviation || "?",
    name: c.team?.shortDisplayName || c.team?.displayName || "?",
    score: c.score != null && c.score !== "" ? parseInt(c.score, 10) || 0 : 0,
    color: c.team?.color ? "#" + c.team.color : "#2a3350",
    logo: c.team?.logo || null,
    record: recordOf(c),
    // pontos por período ("24","27"...); vazio se a ESPN não mandar
    lines: (c.linescores || []).map((l) => String(l.displayValue ?? l.value ?? "")).filter((v) => v !== ""),
  };
}

// Campanha do time ("7-3"): registro tipo "total"; senão o primeiro que houver.
function recordOf(c) {
  const rs = c.records || [];
  const r = rs.find((x) => x.type === "total") || rs[0];
  return r?.summary || null;
}

// Placeholder neutro pra corrida/card, que não têm home/away.
const NEUTRAL_TEAM = { abbr: "—", name: "—", score: 0, color: "#2a3350", logo: null, record: null, lines: [] };

// Situação ao vivo (futebol americano, beisebol...). null se não houver.
function normSituation(comp) {
  const s = comp.situation;
  if (!s) return null;
  const poss = (comp.competitors || []).find((c) => String(c.id) === String(s.possession) || String(c.team?.id) === String(s.possession));
  const base = (b) => (b == null ? null : !!b);
  return {
    possession: poss?.team?.abbreviation || (s.possession != null ? String(s.possession) : null),
    downDistance: s.shortDownDistanceText || s.downDistanceText || null,
    lastPlay: s.lastPlay?.text || null,
    onFirst: base(s.onFirst),
    onSecond: base(s.onSecond),
    onThird: base(s.onThird),
    isRedZone: s.isRedZone != null ? !!s.isRedZone : null,
    possessionText: s.possessionText || null,
  };
}

// Probabilidade de vitória (0-100) da última jogada; null se a ESPN não mandar.
function normWinProb(comp) {
  const p = comp.situation?.lastPlay?.probability;
  if (!p || typeof p.homeWinPercentage !== "number" || typeof p.awayWinPercentage !== "number") return null;
  return { home: Math.round(p.homeWinPercentage * 100), away: Math.round(p.awayWinPercentage * 100) };
}

function normOdds(comp) {
  const o = (comp.odds || [])[0];
  if (!o) return null;
  return { details: o.details || null, overUnder: o.overUnder != null ? o.overUnder : null };
}

// F1: usa a sessão "Race"; sem ordem de chegada/grid ainda, cai na última sessão que tenha.
function raceEntries(ev) {
  const comps = ev.competitions || [];
  const ordered = (c) => (c.competitors || []).some((x) => x.order != null);
  const race = comps.find((c) => c.type?.abbreviation === "Race");
  const src = race && ordered(race) ? race : [...comps].reverse().find(ordered) || race || comps[comps.length - 1] || {};
  const label = src.type?.abbreviation || "";
  const entries = (src.competitors || [])
    .filter((x) => x.order != null)
    .sort((a, b) => a.order - b.order)
    .slice(0, 10)
    .map((x) => ({
      pos: x.order,
      name: x.athlete?.displayName || x.athlete?.fullName || "?",
      detail: x.statistics?.[0]?.displayValue || x.status?.displayValue || label,
    }));
  return { race: race || src, entries };
}

// UFC: cada competition é uma luta; a API lista a principal por último, invertemos.
function cardEntries(ev) {
  return [...(ev.competitions || [])].reverse().slice(0, 12).map((c, i) => {
    const cs = c.competitors || [];
    const nm = (x) => x.athlete?.displayName || x.athlete?.fullName || "?";
    const win = cs.find((x) => x.winner);
    const st = c.status?.type;
    const detail = [
      c.type?.abbreviation,
      st?.state === "post" && win ? `${nm(win)} venceu` : null,
      st?.state && st.state !== "pre" ? st.shortDetail : null,
    ].filter(Boolean).join(" · ");
    return { pos: i + 1, name: cs.map(nm).join(" vs ") || "?", detail };
  });
}

// Top pontuadores do jogo (súmula do endpoint "summary"). Só NBA/WNBA e só jogo
// ao vivo; qualquer falha devolve null e o display simplesmente não mostra o bloco.
const SCORERS_LEAGUES = new Set(["NBA", "WNBA"]);
const SCORERS_MAX_GAMES = 12;
async function fetchTopScorers(lg, eventId) {
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${lg.path}/summary?event=${encodeURIComponent(eventId)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const rows = [];
    for (const t of d.boxscore?.players || []) {
      const st = t.statistics?.[0];
      if (!st) continue;
      const L = st.labels || [];
      const ix = { pts: L.indexOf("PTS"), reb: L.indexOf("REB"), ast: L.indexOf("AST") };
      if (ix.pts < 0) continue;
      for (const a of st.athletes || []) {
        const n = (k) => (ix[k] >= 0 ? parseInt(a.stats?.[ix[k]], 10) || 0 : 0);
        if (!a.stats || !a.stats.length) continue; // não entrou em quadra
        rows.push({
          name: a.athlete?.shortName || a.athlete?.displayName || "?",
          team: t.team?.abbreviation || "",
          pts: n("pts"), reb: n("reb"), ast: n("ast"),
        });
      }
    }
    if (!rows.length) return null;
    rows.sort((x, y) => y.pts - x.pts || y.reb + y.ast - (x.reb + x.ast));
    return rows.slice(0, 5);
  } catch {
    return null;
  }
}

async function fetchLeague(lg) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${lg.path}/scoreboard`;
  const r = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`${lg.id} HTTP ${r.status}`);
  const data = await r.json();
  const events = (data.events || []).map((ev) => {
    const comp = (ev.competitions || [])[0] || {};
    const cs = comp.competitors || [];
    const away = cs.find((c) => c.homeAway === "away") || {};
    const home = cs.find((c) => c.homeAway === "home") || {};
    let kind = lg.kind || "match";
    let entries = [];
    let state = stateMap[ev.status?.type?.state] || "pre";
    let status = ev.status?.type?.shortDetail || "";
    let starts = ev.date || null;
    if (kind === "race") {
      // O status do evento F1 é do fim de semana; o que interessa é o da corrida.
      const r = raceEntries(ev);
      entries = r.entries;
      state = stateMap[r.race.status?.type?.state] || state;
      status = r.race.status?.type?.shortDetail || status;
      starts = r.race.date || starts;
    } else if (kind === "card") {
      entries = cardEntries(ev);
    }
    const neutral = kind !== "match";
    return {
      id: String(ev.id),
      // Nome do evento: o mosaico usa pra corrida/card, que nao tem confronto.
      name: ev.name || ev.shortName || null,
      kind,
      state,
      status,
      starts,
      period: ev.status?.period != null ? ev.status.period : null,
      clock: ev.status?.displayClock != null ? ev.status.displayClock : null,
      away: neutral ? { ...NEUTRAL_TEAM } : normTeam(away),
      home: neutral ? { ...NEUTRAL_TEAM } : normTeam(home),
      entries,
      situation: normSituation(comp),
      odds: normOdds(comp),
      winProb: neutral ? null : normWinProb(comp),
      venueIndoor: comp.venue?.indoor != null ? !!comp.venue.indoor : null,
      featuredInfo: {
        leaders: (comp.leaders || []).slice(0, 3).map((group) => {
          const leader = group.leaders?.[0];
          if (!leader?.athlete) return null;
          return {
            category: group.name || "",
            label: group.displayName || group.shortDisplayName || "",
            athlete: leader.athlete.displayName || leader.athlete.fullName || "",
            position: leader.athlete.position?.abbreviation || "",
            stats: leader.displayValue || "",
          };
        }).filter(Boolean),
        venue: comp.venue?.fullName || "",
        city: comp.venue?.address?.city || "",
        broadcasts: [...new Set(
          (comp.broadcasts || []).flatMap((b) => b.names || [])
        )].slice(0, 3),
      },
    };
  });
  const capped = capEvents(events);
  if (SCORERS_LEAGUES.has(lg.id)) {
    const live = capped.filter((e) => e.state === "in").slice(0, SCORERS_MAX_GAMES);
    await Promise.all(live.map(async (e) => { e.topScorers = await fetchTopScorers(lg, e.id); }));
  }
  return { id: lg.id, abbrev: lg.id, name: lg.name, path: lg.path, sport: lg.sport, kind: lg.kind, events: capped };
}

// Busca só as ligas pedidas (por id). Entradas desconhecidas são ignoradas.
// Mantém a ordem de `ids`. Falha de uma liga não derruba as outras.
async function fetchLeagues(ids) {
  const wanted = (ids && ids.length ? ids : ["NFL", "NBA"]).map((s) => BY_ID[s]).filter(Boolean);
  // Em paralelo: com o catalogo grande, em serie os RTTs somam e uma liga lenta
  // atrasa todas. allSettled garante que a falha de uma nao derruba as outras.
  const settled = await Promise.allSettled(wanted.map((lg) => fetchLeague(lg)));
  return settled.map((r, i) => {
    const lg = wanted[i];
    if (r.status === "fulfilled") return r.value;
    console.error(`[espn] ${lg.id} falhou: ${r.reason?.message || r.reason}`);
    return { id: lg.id, abbrev: lg.id, name: lg.name, path: lg.path, sport: lg.sport, kind: lg.kind, events: [] };
  });
}

function hasLive(leagues) {
  return leagues.some((lg) => lg.events.some((e) => e.state === "in"));
}

// Metadados pro controle remoto montar a lista de ligas.
function catalogMeta() {
  return CATALOG.map((l) => ({ id: l.id, name: l.name, sport: l.sport, kind: l.kind }));
}

module.exports = { CATALOG, BY_ID, fetchLeagues, hasLive, catalogMeta };
