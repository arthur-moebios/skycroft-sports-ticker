/* Selftest da autenticação por chave. Sobe o servidor de verdade: node server/auth.selftest.js */
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skycroft-auth-"));
process.env.SKYCROFT_STATE_FILE = path.join(dir, "state.json");
process.env.SKYCROFT_KEY_FILE = path.join(dir, "remote-key");
process.env.PORT = "18411";
process.env.SKYCROFT_REQUIRE_KEY = "1"; // os casos 1-13 exercitam o modo com chave
const PORT = 18411;
const srv = require("./index.js");
const http = require("http");

let falhas = 0, n = 0;
async function caso(nome, fn) {
  n++;
  try { await fn(); console.log(`OK     ${n}  ${nome}`); }
  catch (e) { falhas++; console.log(`FALHA  ${n}  ${nome} -> ${e.message}`); }
}
function ok(c, m) { if (!c) throw new Error(m || "asserção falhou"); }
const igual = (a, b) => ok(a === b, `esperava ${b}, veio ${a}`);

// http.get em vez de fetch: o fetch esconde alguns cabecalhos e o stream nao fecha
function req(p, headers = {}, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => { b += c; if (res.headers["content-type"]?.includes("event-stream")) { res.destroy(); } });
      res.on("close", () => resolve({ status: res.statusCode, body: b }));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    r.on("error", (e) => (e.code === "ECONNRESET" ? null : reject(e)));
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  const KEY = fs.readFileSync(process.env.SKYCROFT_KEY_FILE, "utf8");
  ok(/^[0-9a-f]{32}$/.test(KEY), "chave nao gerada");
  await new Promise((r) => srv.server.listen(PORT, "127.0.0.1", r));
  const cf = { "cf-ray": "abc123-GRU" };
  const errada = "0".repeat(32);

  await caso("sem cabecalho de Cloudflare passa sem chave", async () => igual((await req("/api/state")).status, 200));
  await caso("cf-ray sem chave -> 401", async () => igual((await req("/api/state", cf)).status, 401));
  await caso("cf-ray com x-skycroft-key -> 200", async () => igual((await req("/api/state", { ...cf, "x-skycroft-key": KEY })).status, 200));
  await caso("cf-ray com cookie sk= -> 200", async () => igual((await req("/api/state", { ...cf, cookie: `a=b; sk=${KEY}` })).status, 200));
  await caso("cf-ray com ?k= -> 200", async () => igual((await req("/api/state?k=" + KEY, cf)).status, 200));
  await caso("chave errada do mesmo comprimento -> 401", async () => igual((await req("/api/state", { ...cf, "x-skycroft-key": errada })).status, 401));
  await caso("chave de comprimento diferente -> 401 sem lancar", async () => {
    igual((await req("/api/state", { ...cf, "x-skycroft-key": "abc" })).status, 401);
    igual((await req("/api/state?k=" + KEY + "ff", cf)).status, 401);
  });
  await caso("/api/wifi/connect com cf-ray -> 403 mesmo com a chave", async () =>
    igual((await req("/api/wifi/connect", { ...cf, "x-skycroft-key": KEY }, "POST", "{}")).status, 403));
  await caso("/api/remote-url: 403 pelo tunel, 200 com #k= local", async () => {
    igual((await req("/api/remote-url", { ...cf, "x-skycroft-key": KEY })).status, 403);
    const r = await req("/api/remote-url");
    igual(r.status, 200);
    ok(JSON.parse(r.body).url.includes("#k=" + KEY), "url sem #k=");
  });
  await caso("a chave nao aparece no snapshot", async () => ok(!JSON.stringify(srv.snapshot()).includes(KEY)));
  await caso("chave multibyte de 32 caracteres -> 401, e o servidor continua de pe", async () => {
    // 32 caracteres, 64 bytes: o timingSafeEqual lanca com tamanhos diferentes,
    // e excecao sincrona no handler do http mata o processo inteiro.
    igual((await req("/api/state?k=" + encodeURIComponent("é".repeat(32)), cf)).status, 401);
    igual((await req("/api/state", { ...cf, "x-skycroft-key": "é".repeat(32) })).status, 401);
    igual((await req("/api/state", { ...cf, cookie: "sk=" + "é".repeat(32) })).status, 401);
    igual((await req("/api/state", { ...cf, "x-skycroft-key": KEY })).status, 200); // ainda responde
  });
  await caso("/api/stream com chave valida pelo tunel abre o SSE", async () =>
    igual((await req("/api/stream", { ...cf, "x-skycroft-key": KEY })).status, 200));
  await caso("SKYCROFT_KEY_IN_QUERY=1 poe a chave na query, nao no fragmento", async () => {
    process.env.SKYCROFT_KEY_IN_QUERY = "1";
    const r = await req("/api/remote-url");
    delete process.env.SKYCROFT_KEY_IN_QUERY;
    const u = JSON.parse(r.body).url;
    ok(u.includes("?k=" + KEY), "url sem ?k=");
    ok(!u.includes("#"), "url ainda tem fragmento");
  });

  // --- modo padrao: chave desligada ---
  await caso("padrao (sem SKYCROFT_REQUIRE_KEY): /api/state pelo tunel sem chave -> 200", async () => {
    const { execFileSync } = require("child_process");
    const out = execFileSync(process.execPath, ["-e", `
      const fs=require("fs"),os=require("os"),path=require("path");
      const d=fs.mkdtempSync(path.join(os.tmpdir(),"sk-open-"));
      process.env.SKYCROFT_STATE_FILE=path.join(d,"s.json");
      process.env.SKYCROFT_KEY_FILE=path.join(d,"k");
      delete process.env.SKYCROFT_REQUIRE_KEY;
      process.env.PORT="18412";
      const s=require(${JSON.stringify(require.resolve("./index.js"))});
      s.server.listen(18412,async()=>{
        const h=require("http");
        const get=(p,hd)=>new Promise(r=>h.request({host:"127.0.0.1",port:18412,path:p,headers:hd},(res)=>{res.resume();r(res.statusCode)}).end());
        const semChave=await get("/api/state",{"cf-ray":"x"});
        const wifi=await get("/api/wifi/scan",{"cf-ray":"x"});
        const url=await new Promise(r=>h.get({host:"127.0.0.1",port:18412,path:"/api/remote-url"},(res)=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>r(b))}));
        console.log(JSON.stringify({semChave,wifi,url:JSON.parse(url).url}));
        process.exit(0);
      });
    `], { encoding: "utf8", timeout: 20000 });
    const r = JSON.parse(out.trim().split("\n").pop());
    igual(r.semChave, 200);
    igual(r.wifi, 403); // setup/wifi continuam fechados pelo tunel
    ok(!r.url.includes("k="), "a URL do QR ainda carrega chave: " + r.url);
  });

  srv.server.close();
  srv.server.closeAllConnections?.();
  console.log(falhas ? `${falhas} FALHA(S)` : "tudo OK");
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.log("erro: " + e.stack); process.exit(1); });
