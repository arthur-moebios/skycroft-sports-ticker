/* ===== Skycroft Ticker — camada de rede (onboarding WiFi) =====
 * Lê o estado de rede escrito por scripts/skycroft-netcheck.sh e fala com o
 * NetworkManager via nmcli. Tudo com execFile (array de args, SEM shell) para
 * não haver injeção de comando a partir de SSID/senha vindos do celular.
 */
const fs = require("fs");
const { execFile } = require("child_process");

const NET_FILE = process.env.SKYCROFT_NET_FILE || "/run/skycroft/net.json";
const SCAN_CACHE = process.env.SKYCROFT_SCAN_CACHE || "/run/skycroft/wifi-scan.json";
const WIFI_HELPER = process.env.SKYCROFT_WIFI_HELPER || "/opt/skycroft/scripts/skycroft-wifi-connect.sh";

// Estado atual de rede (modo setup/online, SSID, IP, dados do hotspot).
function readNet() {
  try {
    const j = JSON.parse(fs.readFileSync(NET_FILE, "utf8"));
    return {
      mode: j.mode === "setup" ? "setup" : "online",
      ssid: j.ssid || null,
      ip: j.ip || null,
      apSsid: j.apSsid || "Skycroft-Setup",
      apPass: j.apPass || null,
      setupUrl: j.setupUrl || null,
    };
  } catch {
    // Sem arquivo (ex.: rodando no PC em dev): assume online.
    return { mode: "online", ssid: null, ip: null, apSsid: "Skycroft-Setup", apPass: null, setupUrl: null };
  }
}

function run(cmd, args, timeout = 20000, input = null) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || "").trim()));
      resolve(stdout);
    });
    // stdin sempre fechado; dados sensíveis (senha) vão por aqui, nunca em argv.
    child.stdin.on("error", () => {});
    child.stdin.end(input == null ? "" : input);
  });
}

// Cache gravado pelo netcheck (scan feito em modo station, antes do AP subir).
function readScanCache() {
  try {
    const j = JSON.parse(fs.readFileSync(SCAN_CACHE, "utf8"));
    if (!Array.isArray(j)) return [];
    return j.filter((n) => n && n.ssid).slice(0, 30);
  } catch {
    return [];
  }
}

// Lista redes WiFi visíveis: [{ssid, signal, secure, keymgmt?}].
// Em modo AP o scan ao vivo falha (EIO no driver): serve o cache do netcheck.
async function scanWifi() {
  const info = readNet();
  if (info.mode === "setup") {
    const cached = readScanCache();
    if (cached.length) return cached;
  }
  let live = [];
  try {
    live = await scanWifiLive();
  } catch (e) {
    const cached = readScanCache();
    if (cached.length) return cached;
    throw e;
  }
  const useful = live.filter((n) => n.ssid !== info.apSsid);
  if (useful.length) return live;
  const cached = readScanCache();
  return cached.length ? cached : live;
}

async function scanWifiLive() {
  const out = await run("nmcli", ["-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "yes"]);
  const seen = new Map();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    // nmcli -t escapa ":" como "\:" — divide respeitando isso.
    const parts = line.split(/(?<!\\):/).map((s) => s.replace(/\\:/g, ":"));
    const ssid = (parts[0] || "").trim();
    if (!ssid) continue; // ignora SSID oculto
    const signal = parseInt(parts[1] || "0", 10) || 0;
    const secure = !!(parts[2] || "").replace(/--/g, "").trim();
    const prev = seen.get(ssid);
    if (!prev || signal > prev.signal) seen.set(ssid, { ssid, signal, secure });
  }
  return [...seen.values()].sort((a, b) => b.signal - a.signal).slice(0, 30);
}

// Conecta o APARELHO a uma rede WiFi. Chama o helper com sudo (args em array).
async function connectWifi(ssid, psk) {
  if (!ssid || typeof ssid !== "string" || ssid.length > 64) throw new Error("SSID inválido");
  if (psk != null && (typeof psk !== "string" || psk.length > 128)) throw new Error("Senha inválida");
  // SSID em argv; a senha vai pelo stdin do helper (não aparece no journal do sudo).
  const args = ["-n", WIFI_HELPER, ssid];
  await run("sudo", args, 420000, psk ? psk + "\n" : "");
  return true;
}

module.exports = { readNet, scanWifi, connectWifi, NET_FILE };
