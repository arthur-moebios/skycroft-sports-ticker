/* Teste real do editor de displays: dirige um Chromium por CDP e arrasta de
 * verdade, com Pointer Events, lendo as coordenadas que o editor produziu. */
const http = require("http"), fs = require("fs"), path = require("path");
const { spawn } = require("child_process");

const ROOT = process.env.SKYCROFT_ROOT || "/opt/skycroft";
const PORT = 18450, CDP = 18451;
const MIME = {".html":"text/html;charset=utf-8",".js":"text/javascript;charset=utf-8",".css":"text/css;charset=utf-8",".webmanifest":"application/json",".svg":"image/svg+xml",".png":"image/png"};

const STATE = {
  updatedAt: Date.now(), favorites: [], leagues: [], catalog: [{id:"NFL",name:"NFL",sport:"football",kind:"match"}],
  control: { favorites: [], mode: "auto", fixedEventId: null, enabledLeagues: ["NFL"], activeDisplayId: "meu",
             ui: {theme:"midnight",density:"comfortable",font:"system",fontScale:1,detail:"rich",listCount:4,showTicker:true,showClock:true,showFeaturedStats:true,sidePos:"right"} },
  ui: {theme:"midnight",density:"comfortable",font:"system",fontScale:1,detail:"rich",listCount:4,showTicker:true,showClock:true,showFeaturedStats:true,sidePos:"right"},
  activeDisplayId: "meu",
  displays: [
    { id:"default", name:"Padrão", builtin:true, grid:{cols:12,rows:8},
      blocks:[{id:"b1",type:"ticker",x:0,y:7,w:12,h:1,opts:{},filters:{}}], ui:{} },
    { id:"meu", name:"Meu layout", builtin:false, grid:{cols:12,rows:8},
      blocks:[{id:"s1",type:"spotlight",x:0,y:0,w:4,h:3,opts:{},filters:{}},
              {id:"t1",type:"ticker",x:0,y:7,w:12,h:1,opts:{},filters:{}}],
      ui:{theme:"midnight",density:"comfortable",font:"system",fontScale:1,detail:"rich",listCount:4,showTicker:true,showClock:true,showFeaturedStats:true,sidePos:"right"} },
  ],
  net: { mode:"online", ssid:"X", ip:"1.2.3.4" }, error:null,
};
let ultimoPost = null;

const srv = http.createServer((q, r) => {
  const u = q.url.split("?")[0];
  if (u === "/api/stream") { r.writeHead(204); return r.end(); }
  if (u === "/api/state") { r.writeHead(200,{"Content-Type":"application/json"}); return r.end(JSON.stringify(STATE)); }
  if (u === "/api/displays" && q.method === "POST") {
    let b=""; q.on("data",c=>b+=c); q.on("end",()=>{ ultimoPost = JSON.parse(b||"{}");
      const d = STATE.displays.find(x=>x.id===ultimoPost.id); if (d && ultimoPost.blocks) d.blocks = ultimoPost.blocks;
      r.writeHead(200,{"Content-Type":"application/json"}); r.end(JSON.stringify(STATE)); });
    return;
  }
  let p = (u === "/remote" || u === "/remote/") ? "/remote/index.html" : u;
  fs.readFile(path.join(ROOT, p), (e,buf) => {
    if (e) { r.writeHead(404); return r.end("404"); }
    r.writeHead(200,{"Content-Type":MIME[path.extname(p)]||"application/octet-stream"}); r.end(buf);
  });
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => srv.listen(PORT, "127.0.0.1", r));
  const chrome = spawn("chromium", ["--headless=new","--no-sandbox","--disable-gpu",
    `--remote-debugging-port=${CDP}`,"--remote-allow-origins=*",
    "--window-size=430,932","about:blank"], { stdio: "ignore" });

  let alvo = null;
  for (let i=0;i<40 && !alvo;i++){ await sleep(1000);
    try { const j = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); alvo = j.find(t=>t.type==="page"); } catch {} }
  if (!alvo) { console.log("FALHA: Chromium nao abriu o CDP"); chrome.kill(); srv.close(); process.exit(1); }

  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const cmd = (method, params={}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({id:i, method, params})); });
  const evalJs = async (expr) => {
    const r = await cmd("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };

  await cmd("Page.enable"); await cmd("Runtime.enable");
  await cmd("Page.navigate", { url: `http://127.0.0.1:${PORT}/remote` });
  // o Pi e lento: espera a app montar de verdade em vez de chutar um tempo
  let pronto = false;
  for (let i = 0; i < 30 && !pronto; i++) {
    await sleep(1000);
    try { pronto = await evalJs(`!!document.querySelector(".dsp-list .dsp-main") || [...document.querySelectorAll("button")].some(b=>/editar/i.test(b.textContent))`); } catch {}
  }
  if (!pronto) { console.log("FALHA: a pagina nao montou em 30s"); ws.close(); chrome.kill("SIGKILL"); srv.close(); process.exit(1); }
  await sleep(800);

  let ok = 0, fail = 0;
  const t = (nome, cond, extra="") => { if (cond) { console.log("OK     " + nome); ok++; } else { console.log("FALHA  " + nome + " " + extra); fail++; } };

  // abre o editor do display editavel
  const abriu = await evalJs(`(() => {
    const bs = [...document.querySelectorAll("button")];
    const b = bs.find(x => /editar/i.test(x.textContent));
    if (!b) return "sem botao Editar: " + bs.map(x=>x.textContent.trim()).join("|").slice(0,200);
    b.click(); return "ok";
  })()`);
  t("abre o editor do display editavel", abriu === "ok", abriu);
  await sleep(1200);

  const grade = await evalJs(`(() => {
    const g = document.querySelector(".gridprev");
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { x:r.x, y:r.y, w:r.width, h:r.height, blocos: g.querySelectorAll(".blk").length };
  })()`);
  t("a grade do editor existe", !!grade && grade.w > 0, JSON.stringify(grade));
  if (!grade) { console.log("\nabortando: sem grade"); ws.close(); chrome.kill(); srv.close(); process.exit(1); }

  const cel = { w: grade.w/12, h: grade.h/8 };
  const centro = (x,y,w,h) => ({ x: grade.x + (x + w/2)*cel.w, y: grade.y + (y + h/2)*cel.h });

  const mouse = async (type, x, y, extra={}) =>
    cmd("Input.dispatchMouseEvent", { type, x, y, button:"left", buttons: type==="mouseReleased"?0:1, clickCount:1, pointerType:"mouse", ...extra });

  // le a geometria pelo proprio texto que o editor mostra ("4x3 . col 1, linha 1")
  const bloco = async (i) => evalJs(`(() => {
    const it = document.querySelectorAll(".blk-item")[${i}];
    if (!it) return null;
    const m = /(\\d+)×(\\d+)\\s*·\\s*col\\s*(\\d+),\\s*linha\\s*(\\d+)/.exec(it.querySelector(".bp").textContent);
    return m ? { w:+m[1], h:+m[2], x:+m[3]-1, y:+m[4]-1 } : it.querySelector(".bp").textContent;
  })()`);

  const antes = await bloco(0);
  t("estado inicial do bloco spotlight e 0,0 4x3", antes && antes.x===0 && antes.y===0 && antes.w===4 && antes.h===3, JSON.stringify(antes));

  // ---- arrasta o spotlight de (0,0) para (3,2)
  let p = centro(0,0,4,3);
  await mouse("mousePressed", p.x, p.y); await sleep(150);
  for (let i=1;i<=8;i++){ await mouse("mouseMoved", p.x + (3*cel.w)*i/8, p.y + (2*cel.h)*i/8); await sleep(45); }
  await mouse("mouseReleased", p.x + 3*cel.w, p.y + 2*cel.h); await sleep(900);
  const dep = await bloco(0);
  t("arrastar move o bloco para 3,2 mantendo 4x3", dep && dep.x===3 && dep.y===2 && dep.w===4 && dep.h===3, JSON.stringify(dep));
  const salvavel = await evalJs(`(() => { const b=document.getElementById("ed-save"); return b ? {hidden:b.hidden, disabled:b.disabled} : null; })()`);
  t("o arrasto habilita o botao Salvar", salvavel && !salvavel.hidden && !salvavel.disabled, JSON.stringify(salvavel));

  // ---- tenta arrastar para fora da grade (direita/baixo): tem que grudar no limite
  const b2 = await bloco(0);
  p = centro(b2.x,b2.y,b2.w,b2.h);
  await mouse("mousePressed", p.x, p.y); await sleep(150);
  for (let i=1;i<=8;i++){ await mouse("mouseMoved", p.x + (20*cel.w)*i/8, p.y + (20*cel.h)*i/8); await sleep(45); }
  await mouse("mouseReleased", p.x + 20*cel.w, p.y + 20*cel.h); await sleep(900);
  const lim = await bloco(0);
  t("arrastar para fora gruda no limite (x+w<=12, y+h<=8)", lim && lim.x+lim.w<=12 && lim.y+lim.h<=8 && lim.w===4 && lim.h===3, JSON.stringify(lim));

  // ---- redimensiona pela alca inferior direita
  const b3 = await bloco(0);
  const alca = await evalJs(`(() => {
    const h = document.querySelector(".hdl-br");
    if (!h) return null; const r = h.getBoundingClientRect();
    return { x:r.x+r.width/2, y:r.y+r.height/2, w:r.width, h:r.height };
  })()`);
  t("existe alca de redimensionar no canto inferior direito", !!alca, JSON.stringify(alca));
  t("a alca tem area tocavel de pelo menos 44px", !!alca && alca.w >= 43 && alca.h >= 43, alca ? `${alca.w}x${alca.h}` : "-");
  if (alca) {
    await mouse("mousePressed", alca.x, alca.y); await sleep(150);
    for (let i=1;i<=6;i++){ await mouse("mouseMoved", alca.x - (2*cel.w)*i/6, alca.y - (1*cel.h)*i/6); await sleep(45); }
    await mouse("mouseReleased", alca.x - 2*cel.w, alca.y - cel.h); await sleep(900);
    const r2 = await bloco(0);
    t("a alca redimensiona o bloco", r2 && (r2.w !== b3.w || r2.h !== b3.h), `antes ${b3.w}x${b3.h} depois ${r2 && r2.w+"x"+r2.h}`);
    t("o redimensionamento respeita w>=1 e h>=1", r2 && r2.w >= 1 && r2.h >= 1, JSON.stringify(r2));
  }

  // salva e confere o que foi parar no servidor
  await evalJs(`document.getElementById("ed-save").click()`);
  await sleep(1500);
  t("Salvar envia update com os blocos", ultimoPost && ultimoPost.action === "update" && Array.isArray(ultimoPost.blocks), JSON.stringify(ultimoPost && ultimoPost.action));
  if (ultimoPost && ultimoPost.blocks) {
    const dentro = ultimoPost.blocks.every(b => b.x>=0 && b.y>=0 && b.w>=1 && b.h>=1 && b.x+b.w<=12 && b.y+b.h<=8);
    t("todos os blocos salvos cabem na grade", dentro, JSON.stringify(ultimoPost.blocks));
    const campos = ultimoPost.blocks.every(b => b.id && b.type && "opts" in b && "filters" in b);
    t("os blocos salvos mantem id/type/opts/filters", campos, JSON.stringify(ultimoPost.blocks[0]));
  }

  // ---- a alca tem que estar NO canto do bloco, nao encalhada na origem
  const pos = await evalJs(`(() => {
    const g = document.querySelector(".gridprev"), h = document.querySelector(".hdl-br");
    const sel = document.querySelector(".blk.sel");
    if (!g || !h || !sel) return null;
    const rg = g.getBoundingClientRect(), rh = h.getBoundingClientRect(), rs = sel.getBoundingClientRect();
    return { dx: Math.abs((rh.x + rh.width/2) - (rs.x + rs.width)), dy: Math.abs((rh.y + rh.height/2) - (rs.y + rs.height)),
             distOrigem: Math.hypot(rh.x - rg.x, rh.y - rg.y) };
  })()`);
  t("a alca fica no canto do bloco selecionado, nao na origem da grade",
    pos && pos.dx < 40 && pos.dy < 40, JSON.stringify(pos));

  // ---- a grade continua visivel depois de selecionar um bloco
  const visivel = await evalJs(`(() => {
    const g = document.querySelector(".gridprev");
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { topo: Math.round(r.y), altura: Math.round(r.height), janela: window.innerHeight };
  })()`);
  t("a grade continua na tela depois de selecionar (nao rola para fora)",
    visivel && visivel.topo > -visivel.altura && visivel.topo < visivel.janela, JSON.stringify(visivel));

  // ---- o botao "Criar display" nao pode ser absoluto (colisao de classe .ghost)
  const botao = await evalJs(`(() => {
    const b = document.getElementById("dsp-new");
    if (!b) return "nao achei";
    return getComputedStyle(b).position;
  })()`);
  t("o botao Criar display nao e position:absolute", botao === "static" || botao === "relative", String(botao));

  // ---- arrastar um bloco para cima de outro tem que ser recusado
  const ini = await bloco(0);
  const outro = await bloco(1);
  if (ini && outro && typeof outro === "object") {
    const pIni = centro(ini.x, ini.y, ini.w, ini.h);
    const alvo = centro(outro.x, outro.y, outro.w, outro.h);
    await mouse("mousePressed", pIni.x, pIni.y); await sleep(150);
    for (let i2=1;i2<=8;i2++){ await mouse("mouseMoved", pIni.x + (alvo.x-pIni.x)*i2/8, pIni.y + (alvo.y-pIni.y)*i2/8); await sleep(45); }
    await mouse("mouseReleased", alvo.x, alvo.y); await sleep(900);
    const d0 = await bloco(0), d1 = await bloco(1);
    const sobrepoe = d0 && d1 && typeof d0 === "object" && typeof d1 === "object" &&
      d0.x < d1.x + d1.w && d1.x < d0.x + d0.w && d0.y < d1.y + d1.h && d1.y < d0.y + d0.h;
    t("arrastar por cima de outro bloco nao sobrepoe", !sobrepoe, `${JSON.stringify(d0)} vs ${JSON.stringify(d1)}`);
  }

  // ---- builtin e somente leitura
  await evalJs(`(() => { const b=[...document.querySelectorAll("button")].find(x=>/fechar|voltar|cancelar|✕|×/i.test(x.textContent)); if(b) b.click(); })()`);
  await sleep(900);
  const verBuiltin = await evalJs(`(() => {
    const bs=[...document.querySelectorAll("button")];
    const b=bs.find(x=>/^ver$/i.test(x.textContent.trim()));
    if(!b) return "sem Ver"; b.click(); return "ok";
  })()`);
  await sleep(1200);
  const semAlca = await evalJs(`document.querySelectorAll(".hdl").length`);
  t("display builtin abre sem alcas de edicao", verBuiltin !== "ok" || semAlca === 0, `botao=${verBuiltin} alcas=${semAlca}`);

  console.log(`\n${ok} OK, ${fail} falha(s)`);
  ws.close(); chrome.kill("SIGKILL"); srv.close();
  setTimeout(()=>process.exit(fail?1:0), 500);
})();
