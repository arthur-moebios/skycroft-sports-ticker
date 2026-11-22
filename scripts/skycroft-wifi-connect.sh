#!/usr/bin/env bash
# Uso: skycroft-wifi-connect.sh SSID   (a senha, se houver, vem pelo STDIN)
# A senha NAO vai em argv para nao aparecer no journal (sudo) nem no ps.
set -euo pipefail

SSID="${1:?uso: skycroft-wifi-connect.sh SSID (senha via stdin)}"
PSK=""
if [[ ! -t 0 ]]; then
  IFS= read -r PSK || true
fi
AP_CON="${SKYCROFT_AP_CON:-Skycroft-Setup}"
WIFI_IF="wlan0"
SCAN_CACHE="${SKYCROFT_SCAN_CACHE:-/run/skycroft/wifi-scan.json}"
KEYFILE_DIR="/etc/NetworkManager/system-connections"
CONNECT_PATH="nenhum"
KEYFILE="$KEYFILE_DIR/skycroft-$(printf %s "$SSID" | sha1sum | cut -c1-12).nmconnection"

log() {
  echo "[skycroft-wifi-connect] $*" >&2
  logger -t skycroft-wifi-connect -- "$*" 2>/dev/null || true
}

mkdir -p /run/skycroft

# Impede que o netcheck manipule a interface durante a conexão.
exec 9>/run/skycroft/wifi.lock
flock -w 10 9 || {
  echo "Erro: gerenciador Wi-Fi ocupado" >&2
  exit 1
}

link_cycle() {
  ip link set "$WIFI_IF" down >/dev/null 2>&1 || true
  sleep 2
  ip link set "$WIFI_IF" up >/dev/null 2>&1 || true
}

# O driver (UWE5622) trava se o AP voltar rápido demais; tenta com folga crescente.
restore_ap() {
  local waits=(5 10 20) i n
  echo "Falha na conexão; tentando restaurar hotspot..." >&2
  for i in 0 1 2; do
    n=$((i + 1))
    log "restaurando hotspot: tentativa $n/3 (espera ${waits[$i]}s)"
    link_cycle
    sleep "${waits[$i]}"
    if timeout 30 nmcli --wait 25 connection up "$AP_CON" >/dev/null 2>&1; then
      log "hotspot restaurado na tentativa $n"
      return 0
    fi
    log "tentativa $n de restaurar o hotspot falhou"
  done
  log "ERRO: hotspot nao voltou apos 3 tentativas"
  return 1
}

# Remove perfis cliente com o mesmo nome (evita duplicatas).
remove_profiles() {
  local uuid
  while IFS= read -r uuid; do
    [[ -n "$uuid" ]] && nmcli connection delete uuid "$uuid" >/dev/null 2>&1 || true
  done < <(SSID="$SSID" nmcli -t -f UUID,NAME connection show |
    python3 -c '
import os,sys
ssid=os.environ["SSID"]
for l in sys.stdin:
    l=l.rstrip("\n")
    u,_,n=l.partition(":")
    if n.replace("\\:",":")==ssid: print(u)')
  rm -f "$KEYFILE"
}

# Segurança vista no scan em cache: open | wpa-psk | sae | unknown ; e se o SSID é visível.
cache_lookup() {
  SSID="$SSID" SCAN_CACHE="$SCAN_CACHE" python3 -I - <<'PY' 2>/dev/null || echo "absent unknown"
import json, os
try:
    data = json.load(open(os.environ["SCAN_CACHE"]))
except Exception:
    print("absent unknown"); raise SystemExit
for n in data:
    if n.get("ssid") == os.environ["SSID"]:
        km = (n.get("keymgmt") or "").upper()
        if not n.get("secure"): sec = "open"
        elif ("SAE" in km or "WPA3" in km) and "WPA2" not in km: sec = "sae"
        elif "WPA" in km: sec = "wpa-psk"
        else: sec = "unknown"
        print("present", sec); break
else:
    print("absent unknown")
PY
}

# Escreve o keyfile (0600 root). Valores só por ambiente.
write_keyfile() {  # $1 = key-mgmt (wpa-psk|sae|open), $2 = hidden (true|false)
  KM="$1" HIDDEN="$2" SSID="$SSID" PSK="$PSK" WIFI_IF="$WIFI_IF" OUT="$KEYFILE" \
  python3 -I - <<'PY'
import os, uuid
ssid = os.environ["SSID"]; psk = os.environ["PSK"]; km = os.environ["KM"]
def esc(v):  # keyfile: valor literal em uma linha
    return v.replace("\\", "\\\\").replace("\n", "\\n")
lines = ["[connection]", "id=" + esc(ssid), "uuid=" + str(uuid.uuid4()),
         "type=wifi", "interface-name=" + os.environ["WIFI_IF"], "autoconnect=true",
         "", "[wifi]", "mode=infrastructure", "ssid=" + esc(ssid),
         "hidden=" + os.environ["HIDDEN"], ""]
if km != "open":
    lines += ["[wifi-security]", "key-mgmt=" + km, "psk=" + esc(psk), ""]
lines += ["[ipv4]", "method=auto", "", "[ipv6]", "method=auto", ""]
path = os.environ["OUT"]
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("\n".join(lines))
os.chown(path, 0, 0); os.chmod(path, 0o600)
PY
}

# Cria o perfil: keyfile primeiro; se não carregar, cai para nmcli add.
create_profile() {  # $1 = key-mgmt, $2 = hidden
  remove_profiles
  write_keyfile "$1" "$2"
  nmcli connection reload >/dev/null 2>&1 || true
  if nmcli -g NAME connection show | grep -Fxq "$SSID"; then
    CONNECT_PATH="keyfile"
    return 0
  fi
  log "keyfile nao carregou; usando nmcli connection add"
  rm -f "$KEYFILE"
  nmcli connection reload >/dev/null 2>&1 || true
  local args=(connection add type wifi con-name "$SSID" ifname "$WIFI_IF"
              ssid "$SSID" 802-11-wireless.hidden "$2" connection.autoconnect yes)
  if [[ "$1" != "open" ]]; then
    args+=(wifi-sec.key-mgmt "$1" wifi-sec.psk "$PSK")
  fi
  nmcli "${args[@]}" >/dev/null
  CONNECT_PATH="nmcli-add"
}

activate() {
  timeout 40 nmcli --wait 35 connection up id "$SSID" ifname "$WIFI_IF"
}

# Libera o rádio e dá folga ao driver antes de trocar de modo.
timeout 12 nmcli --wait 10 connection down "$AP_CON" >/dev/null 2>&1 || true
sleep 1
link_cycle
sleep 3

if [[ -z "$PSK" ]] && nmcli -g NAME connection show | grep -Fxq "$SSID"; then
  # Reutiliza o perfil salvo quando não há nova senha.
  CONNECT_PATH="perfil-existente"
  activate || { restore_ap || true; exit 1; }
else
  read -r PRESENT SEC <<<"$(cache_lookup)"

  # Ordem das tentativas (key-mgmt:hidden). hidden=true so como ULTIMO recurso:
  # com ele o driver faz sondagem dirigida e, sem o AP visivel, trava o radio.
  if [[ -z "$PSK" ]]; then
    ATTEMPTS=(open:false open:true)
  elif [[ "$SEC" == "sae" ]]; then
    ATTEMPTS=(sae:false wpa-psk:false sae:true wpa-psk:true)
  else
    ATTEMPTS=(wpa-psk:false sae:false wpa-psk:true sae:true)
  fi

  OK=0
  N=0
  for ATT in "${ATTEMPTS[@]}"; do
    KM="${ATT%%:*}"; HIDDEN="${ATT##*:}"
    N=$((N + 1))
    if (( N > 1 )); then link_cycle; sleep 2; fi
    create_profile "$KM" "$HIDDEN"
    log "tentativa $N/${#ATTEMPTS[@]}: perfil via $CONNECT_PATH (key-mgmt=$KM, hidden=$HIDDEN)"
    if activate; then OK=1; break; fi
    log "ativacao falhou (key-mgmt=$KM, hidden=$HIDDEN)"
    nmcli connection down id "$SSID" >/dev/null 2>&1 || true
  done
  if (( OK == 0 )); then
    remove_profiles
    nmcli connection reload >/dev/null 2>&1 || true
    restore_ap || true
    exit 1
  fi
fi

# Confirma que a interface realmente conectou.
ACTIVE="$(nmcli -g GENERAL.CONNECTION device show "$WIFI_IF")"

if [[ -z "$ACTIVE" || "$ACTIVE" == "$AP_CON" || "$ACTIVE" == "--" ]]; then
  restore_ap || true
  echo "Erro: Wi-Fi não conectado" >&2
  exit 1
fi

log "caminho de criacao do perfil: $CONNECT_PATH"
echo "Conectado a $SSID"
