/* Smoke test manual: busca toda liga do CATALOG na ESPN e resume.
 * Uso: node server/espn.smoke.js   (sai com 1 se alguma liga falhar)
 */
const { CATALOG } = require("./espn.js");

(async () => {
  let falhas = 0;
  for (const lg of CATALOG) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${lg.path}/scoreboard`;
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const evs = data.events || [];
      const live = evs.filter((e) => e.status?.type?.state === "in").length;
      console.log(`${lg.id.padEnd(7)} ok     eventos=${String(evs.length).padStart(3)} aovivo=${live} kind=${lg.kind}`);
    } catch (e) {
      falhas++;
      console.log(`${lg.id.padEnd(7)} FALHA  ${e.message} kind=${lg.kind}`);
    }
  }
  process.exit(falhas ? 1 : 0);
})();
