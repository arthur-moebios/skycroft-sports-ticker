#!/usr/bin/env bash
set -u

AP_CON="${SKYCROFT_AP_CON:-Skycroft-Setup}"
AP_SSID="${SKYCROFT_AP_SSID:-Skycroft-Setup}"
AP_PASS="${SKYCROFT_AP_PASS:-}"
PORT="${PORT:-8099}"

INTERVAL="${SKYCROFT_NETCHECK_INTERVAL:-15}"
GRACE="${SKYCROFT_WIFI_GRACE:-90}"
RETRY="${SKYCROFT_WIFI_RETRY:-300}"
TIMEOUT="${SKYCROFT_WIFI_TIMEOUT:-40}"
MAX_FAILURES="${SKYCROFT_WIFI_MAX_FAILURES:-3}"
AP_BUSY_MAX="${SKYCROFT_AP_BUSY_MAX:-900}"
# Teto do recuo entre tentativas. Cada troca AP->station->AP e uma chance de
# travar o firmware do radio, entao tentativas repetidas ficam cada vez mais
# raras em vez de continuarem a cada RETRY.
RETRY_MAX="${SKYCROFT_WIFI_RETRY_MAX:-3600}"
# Reboot automatico quando o radio trava de vez (unica recuperacao conhecida).
AP_DEAD_MAX="${SKYCROFT_AP_DEAD_MAX:-3}"
REBOOT_ON_DEAD_RADIO="${SKYCROFT_REBOOT_ON_DEAD_RADIO:-1}"
REBOOT_MIN_UPTIME="${SKYCROFT_REBOOT_MIN_UPTIME:-600}"
REBOOT_COOLDOWN="${SKYCROFT_REBOOT_COOLDOWN:-1800}"
REBOOT_STAMP="/run/skycroft/last-auto-reboot"

WIFI_IF="wlan0"
NET_DIR="/run/skycroft"
NET_FILE="$NET_DIR/net.json"
LOCK_FILE="$NET_DIR/wifi.lock"
AP_IP="10.42.0.1"

mkdir -p "$NET_DIR"

log() {
  echo "[skycroft-netcheck] $*" >&2
}

write_net() {
  local mode="$1" ssid="$2" ip="$3"

  MODE="$mode" SSID="$ssid" IP="$ip" \
  AP_SSID="$AP_SSID" AP_PASS="$AP_PASS" \
  AP_IP="$AP_IP" PORT="$PORT" NET_FILE="$NET_FILE" \
  python3 - <<'PY'
import json, os, tempfile

data = {
    "mode": os.environ["MODE"],
    "ssid": os.environ["SSID"] or None,
    "ip": os.environ["IP"] or None,
    "apSsid": os.environ["AP_SSID"],
    "apPass": os.environ["AP_PASS"] or None,
    "setupUrl": f"http://{os.environ['AP_IP']}/setup"
}

path = os.environ["NET_FILE"]
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
os.fchmod(fd, 0o644)

try:
    with os.fdopen(fd, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
PY
}

wifi_state() {
  nmcli -g GENERAL.STATE device show "$WIFI_IF" 2>/dev/null |
    head -n1
}

wifi_connection() {
  nmcli -g GENERAL.CONNECTION device show "$WIFI_IF" 2>/dev/null |
    head -n1
}

wifi_connected() {
  local state con
  state="$(wifi_state)"
  con="$(wifi_connection)"

  [[ "$state" == 100* ]] &&
  [[ -n "$con" && "$con" != "--" && "$con" != "$AP_CON" ]]
}

wifi_connecting() {
  local state
  state="$(wifi_state)"
  [[ "$state" =~ ^(40|50|60|70|80|90) ]]
}

ap_active() {
  nmcli -t -f UUID connection show --active 2>/dev/null |
    grep -Fxq "$AP_UUID"
}

# Quantos clientes estao associados ao hotspot agora.
ap_clients() {
  local n
  n="$(iw dev "$WIFI_IF" station dump 2>/dev/null | grep -c '^Station' || true)"
  (( ${n:-0} > 0 ))
}

# Decide se pode derrubar o hotspot para tentar recuperar o Wi-Fi. Cliente
# associado quase sempre significa alguem na pagina de setup, e derrubar o AP
# mataria a sessao no meio. Adia a recuperacao, com teto para o hotspot nao
# ficar preso por um cliente ocioso.
recovery_allowed() {
  local now="$1"

  if ! ap_clients; then
    ap_busy_since=0
    return 0
  fi

  if (( ap_busy_since == 0 )); then
    ap_busy_since="$now"
    log "Cliente no hotspot; recuperacao adiada"
  fi

  if (( now - ap_busy_since >= AP_BUSY_MAX )); then
    log "Cliente no hotspot ha mais de ${AP_BUSY_MAX}s; recuperacao liberada"
    ap_busy_since=0
    return 0
  fi

  return 1
}

# O NetworkManager diz "activated" mesmo com o firmware do radio morto, entao
# e preciso perguntar a quem de fato opera o AP. O driver sprdwl_ng NAO
# implementa "iw survey dump" (sai 0 com saida vazia), entao aquilo nunca
# serviria de prova. O wpa_supplicant responde: em AP sadio diz
# wpa_state=COMPLETED e mode=AP.
#
# Falha SEGURA: sem resposta utilizavel, assume sadio. Um detector de defeito
# que erra para "morto" reinicia um aparelho que estava bom.
ap_beaconing() {
  local st
  st="$(wpa_cli -i "$WIFI_IF" status 2>/dev/null)" || return 0
  [[ -z "$st" ]] && return 0
  grep -q "^wpa_state=COMPLETED$" <<<"$st" || return 1
  grep -q "^mode=AP$" <<<"$st" || return 1
  return 0
}

# Assinatura exata do travamento observado: o firmware do radio da assert e a
# fila de transmissao do wlan0 estoura o watchdog.
radio_asserted() {
  dmesg 2>/dev/null | tail -200 |
    grep -qE "cp_asserted:1|NETDEV WATCHDOG: ${WIFI_IF}"
}

uptime_secs() {
  local u
  u="$(cut -d. -f1 /proc/uptime 2>/dev/null)"
  echo "${u:-0}"
}

# Radio travado (assert do firmware) so volta com reboot: derrubar e subir a
# conexao nao resolve, e recarregar o sprdwl_ng leva o wlan0 embora, porque o
# modulo base uwe5622_bsp_sdio e compartilhado com o Bluetooth.
reboot_dead_radio() {
  local now="$1" last=0

  (( REBOOT_ON_DEAD_RADIO == 1 )) || { log "Radio travado; reboot automatico desligado"; return 1; }

  if (( $(uptime_secs) < REBOOT_MIN_UPTIME )); then
    log "Radio travado, mas uptime < ${REBOOT_MIN_UPTIME}s; aguardando"
    return 1
  fi

  [[ -r "$REBOOT_STAMP" ]] && last="$(cat "$REBOOT_STAMP" 2>/dev/null || echo 0)"
  if (( now - last < REBOOT_COOLDOWN )); then
    log "Radio travado, mas ja houve reboot automatico ha menos de ${REBOOT_COOLDOWN}s"
    return 1
  fi

  mkdir -p "$(dirname "$REBOOT_STAMP")" 2>/dev/null || true
  echo "$now" > "$REBOOT_STAMP" 2>/dev/null || true
  log "Radio travado (firmware); reiniciando o aparelho"
  systemctl reboot
  return 0
}

publish_online() {
  local ssid ip

  ssid="$(wifi_connection)"
  ip="$(nmcli -g IP4.ADDRESS device show "$WIFI_IF" 2>/dev/null |
    head -n1 | cut -d/ -f1)"

  write_net online "$ssid" "$ip"
}

saved_profiles() {
  nmcli -t -f UUID,TYPE connection show 2>/dev/null |
    awk -F: '$2=="wifi" || $2=="802-11-wireless"{print $1}' |
    while IFS= read -r uuid; do
      [[ "$uuid" == "$AP_UUID" ]] && continue

      mode="$(nmcli -g 802-11-wireless.mode connection show "$uuid" 2>/dev/null)"
      auto="$(nmcli -g connection.autoconnect connection show "$uuid" 2>/dev/null)"

      if [[ "$mode" == "infrastructure" && "$auto" == "yes" ]]; then
        printf '%s\n' "$uuid"
      fi
    done
}

driver_healthy() {
  nmcli -t -f DEVICE,TYPE device status 2>/dev/null |
    grep -Fxq "$WIFI_IF:wifi" || return 1

  iw dev "$WIFI_IF" info >/dev/null 2>&1
}

SCAN_FILE="$NET_DIR/wifi-scan.json"

# Scan em modo station (o scan falha com EIO quando o wlan0 esta em AP);
# grava cache para o portal servir enquanto o hotspot estiver no ar.
cache_scan() {
  local out rc=0 count

  out="$(timeout 40 nmcli -t -f SSID,SIGNAL,SECURITY device wifi list \
    --rescan yes ifname "$WIFI_IF" 2>&1)" || rc=$?

  if (( rc != 0 )); then
    log "Scan Wi-Fi falhou (rc=$rc): $(printf '%s' "$out" | head -n1)"
    return 1
  fi

  count="$(SCAN_OUT="$out" AP_SSID="$AP_SSID" SCAN_FILE="$SCAN_FILE" \
  python3 -I - <<'PY'
import json, os, re, tempfile

best = {}
for line in os.environ["SCAN_OUT"].splitlines():
    if not line.strip():
        continue
    parts = [p.replace("\\:", ":") for p in re.split(r"(?<!\\):", line)]
    ssid = parts[0].strip()
    if not ssid or ssid == os.environ["AP_SSID"]:
        continue
    try:
        signal = int(parts[1])
    except (IndexError, ValueError):
        signal = 0
    km = (parts[2] if len(parts) > 2 else "").strip()
    if km == "--":
        km = ""
    prev = best.get(ssid)
    if prev is None or signal > prev["signal"]:
        best[ssid] = {"ssid": ssid, "signal": signal,
                      "secure": bool(km), "keymgmt": km}

nets = sorted(best.values(), key=lambda n: -n["signal"])
path = os.environ["SCAN_FILE"]
if nets or not os.path.exists(path):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    os.fchmod(fd, 0o644)
    with os.fdopen(fd, "w") as f:
        json.dump(nets, f)
    os.replace(tmp, path)
print(len(nets))
PY
)" || count=""

  if [[ -z "$count" ]]; then
    log "Scan Wi-Fi: falha ao processar resultado"
    return 1
  fi

  log "Scan Wi-Fi em modo station: $count rede(s) encontrada(s)"
  [[ "$count" -gt 0 ]]
}

# Casa perfis Wi-Fi salvos com redes visiveis no cache de scan.
# Saida (ordenada por sinal): uuid<TAB>ssid<TAB>key-mgmt do perfil<TAB>seguranca vista no scan
match_saved_visible() {
  local uuid ssid km tsv=""

  while IFS= read -r uuid; do
    [[ -n "$uuid" ]] || continue
    ssid="$(nmcli -g 802-11-wireless.ssid connection show uuid "$uuid" 2>/dev/null)"
    km="$(nmcli -g 802-11-wireless-security.key-mgmt connection show uuid "$uuid" 2>/dev/null)"
    tsv+="$uuid"$'\t'"$ssid"$'\t'"$km"$'\n'
  done < <(saved_profiles)

  PROFILES="$tsv" SCAN_FILE="$SCAN_FILE" python3 -I - <<'PY'
import json, os
try:
    nets = json.load(open(os.environ["SCAN_FILE"]))
except Exception:
    raise SystemExit
seen = {n["ssid"]: n for n in nets if n.get("ssid")}
rows = []
for line in os.environ["PROFILES"].splitlines():
    uuid, ssid, km = (line.split("\t") + ["", ""])[:3]
    n = seen.get(ssid)
    if not n:
        continue
    k = (n.get("keymgmt") or "").upper()
    if not n.get("secure"): sec = "open"
    elif ("SAE" in k or "WPA3" in k) and "WPA2" not in k: sec = "sae"
    elif "WPA" in k: sec = "wpa-psk"
    else: sec = "unknown"
    rows.append((-int(n.get("signal") or 0), uuid, ssid, km, sec))
for _, uuid, ssid, km, sec in sorted(rows):
    print("\t".join([uuid, ssid, km, sec]))
PY
}

# Com o wlan0 em station (sem trocar de modo), conecta a um perfil salvo cuja
# rede esta visivel no scan. Corrige key-mgmt (wpa-psk <-> sae) se o scan divergir.
try_saved_visible() {
  local uuid ssid pkm skm want

  [[ -s "$SCAN_FILE" ]] || return 1

  while IFS=$'\t' read -r uuid ssid pkm skm; do
    [[ -n "$uuid" ]] || continue
    driver_healthy || return 1

    want=""
    if [[ "$skm" == "sae" && "$pkm" == "wpa-psk" ]]; then want="sae"
    elif [[ "$skm" == "wpa-psk" && "$pkm" == "sae" ]]; then want="wpa-psk"
    fi

    if [[ -n "$want" ]]; then
      log "Perfil '$ssid' esta como $pkm mas o scan indica $skm; ajustando key-mgmt"
      nmcli connection modify uuid "$uuid" 802-11-wireless-security.key-mgmt "$want" \
        >/dev/null 2>&1 || log "Falha ao ajustar key-mgmt de '$ssid'"
      nmcli connection reload >/dev/null 2>&1 || true
    fi

    log "Rede salva '$ssid' visivel no scan; conectando sem subir hotspot"
    if timeout "$((TIMEOUT + 5))" nmcli --wait "$TIMEOUT" connection up uuid "$uuid" \
        ifname "$WIFI_IF" >/dev/null 2>&1 && wifi_connected; then
      publish_online
      log "Conectado a '$ssid' sem hotspot"
      return 0
    fi
    log "Falha ao conectar a '$ssid'"
  done < <(match_saved_visible)

  return 1
}

activate_ap() {
  if ! driver_healthy; then
    log "ERRO: driver Wi-Fi indisponivel; AP nao sera ativado"
    return 1
  fi

  if ! ap_active; then
    cache_scan || true
    log "Ativando hotspot $AP_SSID"
    timeout 45 nmcli --wait 35 connection up uuid "$AP_UUID" \
      ifname "$WIFI_IF" >/dev/null 2>&1 || return 1

    # Inicia a contagem de 5 minutos apos ativar o AP.
    last_attempt="$(date +%s)"
  fi

  write_net setup "" "$AP_IP"
}

# O lock impede concorrencia com o portal.
# Esta funcao deve ser chamada somente com o lock adquirido.
attempt_recovery() {
  local uuid result=1
  local profiles=()

  mapfile -t profiles < <(saved_profiles)

  if (( ${#profiles[@]} == 0 )); then
    log "Nenhuma rede cliente salva para recuperar"
    return 1
  fi

  log "Iniciando tentativa de recuperacao Wi-Fi"

  if ap_active; then
    timeout 20 nmcli --wait 15 connection down uuid "$AP_UUID" \
      >/dev/null 2>&1 || true
    sleep 3
  fi

  if ! driver_healthy; then
    log "ERRO: driver indisponivel apos desativar AP"
    return 2
  fi

  for uuid in "${profiles[@]}"; do
    log "Tentando perfil UUID $uuid"

    if timeout "$((TIMEOUT + 5))" \
      nmcli --wait "$TIMEOUT" connection up uuid "$uuid" \
      ifname "$WIFI_IF" >/dev/null 2>&1; then

      if wifi_connected; then
        publish_online
        log "Wi-Fi recuperado com sucesso"
        return 0
      fi
    fi

    if ! driver_healthy; then
      log "ERRO: interface Wi-Fi desapareceu"
      return 2
    fi
  done

  log "Nenhuma rede salva conectou nesta tentativa"
  return 1
}

[[ "${SKYCROFT_NETCHECK_SOURCE_ONLY:-0}" == "1" ]] && return 0 2>/dev/null

AP_UUID="$(nmcli -g connection.uuid connection show "$AP_CON" 2>/dev/null)"

if [[ -z "$AP_UUID" ]]; then
  log "ERRO: perfil hotspot nao encontrado"
  exit 1
fi

last_online="$(date +%s)"
last_attempt=0
recovery_disabled=0
ap_busy_since=0
recovery_fails=0
ap_dead=0

log "Iniciado: grace=${GRACE}s retry=${RETRY}s timeout=${TIMEOUT}s"

# Boot: com o wlan0 em station (onde o scan funciona), escaneia e tenta conectar
# a uma rede salva visivel ANTES de subir o hotspot. Sem troca de modo.
if ! ap_active && ! wifi_connected; then
  exec 9>"$LOCK_FILE"
  if flock -w 20 9; then
    cache_scan || true
    if try_saved_visible; then
      last_online="$(date +%s)"
    fi
    flock -u 9
  fi
  exec 9>&-
elif ! ap_active; then
  cache_scan || true
fi

while true; do
  exec 9>"$LOCK_FILE"

  if flock -n 9; then
    now="$(date +%s)"

    if wifi_connected; then
      publish_online
      last_online="$now"
      recovery_disabled=0
      recovery_fails=0
      ap_dead=0

    elif ! driver_healthy; then
      log "ERRO: driver Wi-Fi indisponivel"
      recovery_disabled=1

    elif (( recovery_disabled == 1 )); then
      log "Recuperacao automatica suspensa"

    elif ap_active; then
      write_net setup "" "$AP_IP"

      # O AP pode estar "activated" para o NetworkManager e mudo no ar.
      if ap_beaconing && ! radio_asserted; then
        ap_dead=0
      else
        ap_dead=$(( ap_dead + 1 ))
        log "Hotspot ativo mas o radio nao responde (${ap_dead}/${AP_DEAD_MAX})"
        if (( ap_dead >= AP_DEAD_MAX )); then
          reboot_dead_radio "$now" && exit 0
          ap_dead=0
        fi
      fi

      # Recuo exponencial: cada troca de modo e uma chance de travar o radio,
      # entao tentativa que falha empurra a proxima para mais longe.
      retry_now=$(( RETRY << (recovery_fails < 4 ? recovery_fails : 4) ))
      (( retry_now > RETRY_MAX )) && retry_now="$RETRY_MAX"

      if (( now - last_attempt >= retry_now )) && recovery_allowed "$now"; then
        last_attempt="$now"

        if attempt_recovery; then
          last_online="$(date +%s)"
          recovery_fails=0
        else
          result="$?"
          recovery_fails=$(( recovery_fails + 1 ))
          log "Recuperacao falhou (${recovery_fails}); proxima em $(( RETRY << (recovery_fails < 4 ? recovery_fails : 4) > RETRY_MAX ? RETRY_MAX : RETRY << (recovery_fails < 4 ? recovery_fails : 4) ))s"

          if (( result == 2 )); then
            log "ERRO: falha grave durante recuperacao"
            recovery_disabled=1
          else
            activate_ap || {
              log "ERRO: falha ao restaurar hotspot"
              recovery_disabled=1
            }

            # Preserva o intervalo da ultima tentativa.
            last_attempt="$(date +%s)"
          fi
        fi
      fi

    elif (( now - last_online >= GRACE )); then
      if wifi_connecting; then
        log "Reconexao excedeu ${GRACE}s; ativando fallback"
      fi
      if cache_scan; try_saved_visible; then
        last_online="$(date +%s)"
      else
        activate_ap || log "Falha ao ativar hotspot"
      fi

    elif wifi_connecting; then
      log "NetworkManager tentando conectar"
    fi

    flock -u 9
  fi

  exec 9>&-
  sleep "$INTERVAL"
done
