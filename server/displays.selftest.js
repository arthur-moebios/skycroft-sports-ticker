/* Selftest da validação de displays. Sem servidor, sem rede: node server/displays.selftest.js */
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skycroft-"));
const tmp = path.join(dir, "state.json");
process.env.SKYCROFT_STATE_FILE = tmp;
// sem isto o teste gera uma chave de verdade em server/remote-key
process.env.SKYCROFT_KEY_FILE = path.join(dir, "remote-key");
const srv = require("./index.js");

let falhas = 0;
function caso(nome, fn) {
  try { fn(); console.log("OK     " + nome); }
  catch (e) { falhas++; console.log("FALHA  " + nome + " -> " + e.message); }
}
function ok(c, m) { if (!c) throw new Error(m || "asserção falhou"); }
function lança(fn) { try { fn(); } catch { return true; } return false; }
const novo = (estado) => {
  if (estado) fs.writeFileSync(tmp, JSON.stringify(estado)); else try { fs.unlinkSync(tmp); } catch {}
  srv.setControl(srv.loadControl());
  return srv.getControl();
};
const disp = (id) => srv.getControl().displays.find((d) => d.id === id);

caso("1 migração de estado legado só com ui", () => {
  const c = novo({ favorites: ["NE"], ui: { theme: "arena", fontScale: 1.2, listCount: 2 } });
  ok(c.displays.length === 2, "deveria ter 2 builtins");
  ok(c.displays[0].id === "default" && c.displays[1].id === "gameday");
  ok(c.displays.every((d) => d.builtin));
  ok(disp("default").ui.theme === "arena" && disp("default").ui.fontScale === 1.2 && disp("default").ui.listCount === 2, "ui legado perdido");
  ok(disp("gameday").ui.theme === "midnight", "gameday deveria ter ui padrão");
  ok(c.activeDisplayId === "default");
  ok(!("ui" in c), "control.ui não pode ser estado");
  ok(c.favorites[0] === "NE");
  ok(disp("default").blocks.map((b) => b.type).join() === "brand,clock,spotlight,list,ticker");
  ok(disp("gameday").blocks[0].type === "mosaic" && disp("gameday").blocks[0].filters.states.join() === "in,pre,post");
});

caso("2 create duplicando gameday", () => {
  novo();
  srv.applyDisplays({ action: "create", name: "Game Day", from: "gameday" });
  const d = srv.getControl().displays[2];
  ok(d && d.id !== "gameday" && d.builtin === false, "id novo e builtin false");
  ok(d.blocks.length === 2 && d.blocks[0].type === "mosaic");
  srv.applyDisplays({ action: "create", name: "Game Day", from: "gameday" });
  const ids = srv.getControl().displays.map((x) => x.id);
  ok(new Set(ids).size === ids.length, "ids repetidos: " + ids);
  srv.applyDisplays({ action: "create", name: "Vazio", from: "blank" });
  ok(disp("vazio").blocks.length === 0);
  ok(lança(() => srv.applyDisplays({ action: "create", name: "x", from: "nada" })), "origem inválida deveria falhar");
});

caso("3 update movendo bloco para fora da grade é clampeado", () => {
  novo();
  srv.applyDisplays({ action: "create", name: "Teste", from: "mosaic" });
  srv.applyDisplays({ action: "update", id: "teste", blocks: [{ id: "a", type: "list", x: 10, y: 7, w: 9, h: 5 }, { id: "b", type: "clock", x: -3, y: 2.6, w: 0, h: 1 }] });
  const [a, b] = disp("teste").blocks;
  ok(a.w === 9 && a.x + a.w <= 12 && a.y + a.h <= 8 && a.x === 3 && a.h === 5 && a.y === 3, JSON.stringify(a));
  ok(b.x === 0 && b.w === 1 && b.y === 3, JSON.stringify(b));
});

caso("4 delete de builtin é recusado; builtin só muda ui", () => {
  novo();
  ok(lança(() => srv.applyDisplays({ action: "delete", id: "default" })), "delete default");
  ok(lança(() => srv.applyDisplays({ action: "delete", id: "gameday" })), "delete gameday");
  srv.applyDisplays({ action: "update", id: "gameday", name: "Outro", blocks: [], ui: { theme: "arena" } });
  ok(disp("gameday").name === "Game Day" && disp("gameday").blocks.length === 2, "builtin mexido");
  ok(disp("gameday").ui.theme === "arena", "ui do builtin deveria mudar");
});

caso("5 delete do display ativo volta para default", () => {
  novo();
  srv.applyDisplays({ action: "create", name: "Temp", from: "spotlight" });
  srv.applyDisplays({ action: "activate", id: "temp" });
  ok(srv.getControl().activeDisplayId === "temp");
  srv.applyDisplays({ action: "delete", id: "temp" });
  ok(srv.getControl().activeDisplayId === "default" && !disp("temp"));
  const c = novo({ activeDisplayId: "fantasma" });
  ok(c.activeDisplayId === "default", "activeDisplayId inexistente");
});

caso("6 bloco com type inválido é descartado, resto aplicado", () => {
  novo();
  srv.applyDisplays({ action: "create", name: "Misto", from: "blank" });
  srv.applyDisplays({
    action: "update", id: "misto", name: "Renomeado", ui: { theme: "stars" },
    blocks: [
      { id: "x", type: "hacker", x: 0, y: 0, w: 2, h: 2 },
      { id: "y", type: "mosaic", x: 0, y: 0, w: 4, h: 4, filters: { leagues: ["NFL", "XXX"], states: ["in", "foo"] } },
      { id: "z", type: "list", x: "a", y: 0, w: 2, h: 2 },
    ],
  });
  const d = disp("misto");
  ok(d.blocks.length === 1 && d.blocks[0].type === "mosaic", "blocos: " + d.blocks.length);
  ok(d.name === "Renomeado" && d.ui.theme === "stars", "resto do patch");
  ok(d.blocks[0].filters.leagues.join() === "NFL" && d.blocks[0].filters.states.join() === "in", "filtros");
  const f = srv.getControl().displays.length;
  for (let i = 0; i < 20; i++) try { srv.applyDisplays({ action: "create", name: "n", from: "blank" }); } catch {}
  ok(srv.getControl().displays.length === 12 && f < 12, "limite de 12 displays");
  srv.applyDisplays({ action: "update", id: "misto", blocks: Array.from({ length: 30 }, () => ({ type: "clock", x: 0, y: 0, w: 1, h: 1 })) });
  ok(disp("misto").blocks.length === 10, "limite de 10 blocos");
});

caso("7 snapshot().ui reflete o display ativo; /api/control {ui} vai pro ativo", () => {
  novo();
  srv.applyDisplays({ action: "activate", id: "gameday" });
  srv.applyControl({ ui: { theme: "hardwood", showClock: false } });
  const s = srv.snapshot();
  ok(s.ui.theme === "hardwood" && s.ui.showClock === false, "ui derivado");
  ok(disp("gameday").ui.theme === "hardwood" && disp("default").ui.theme === "midnight", "aplicou no display errado");
  ok(s.control.ui.theme === "hardwood", "control.ui derivado p/ os clientes");
  ok(s.activeDisplayId === "gameday" && s.displays.length === 2);
  for (const k of ["updatedAt", "favorites", "control", "leagues", "catalog", "error", "net"]) ok(k in s, "faltou " + k);
  ok(["mode", "fixedEventId", "enabledLeagues", "favorites"].every((k) => k in s.control));
  srv.applyDisplays({ action: "reorder", ids: ["gameday", "default"] });
  ok(srv.getControl().displays[0].id === "gameday");
});

try { fs.rmSync(path.dirname(tmp), { recursive: true }); } catch {}
console.log(falhas ? `\n${falhas} caso(s) com FALHA` : "\ntudo OK");
process.exit(falhas ? 1 : 0);
