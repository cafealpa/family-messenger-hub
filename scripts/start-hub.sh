#!/data/data/com.termux/files/usr/bin/sh
#
# Termux 부팅 스크립트.
# 설치 위치: ~/.termux/boot/start-hub.sh  (Termux:Boot 애드온 필요)
#   mkdir -p ~/.termux/boot
#   cp hub/scripts/start-hub.sh ~/.termux/boot/
#   chmod +x ~/.termux/boot/start-hub.sh
#
# 하는 일:
#   1. wake-lock 으로 CPU 잠자기 방지
#   2. 허브를 실행하고, 죽으면 다시 살린다
#   3. 로그를 ~/hub.log 에 append. 10MB 넘으면 1회 로테이트

HUB_DIR="${HUB_DIR:-$HOME/family-messenger/hub}"
LOG="${HUB_LOG:-$HOME/hub.log}"
MAX_LOG_BYTES=10485760   # 10MB
RESTART_DELAY=5
CONFIG_RETRY_DELAY=30    # 설정 문제(예: Tailscale 미기동)일 때는 천천히 재시도
EXIT_CONFIG=78

# 바인딩 주소.
#   tailscale → 이 폰의 100.x 주소에만 묶는다 (외부망 사용, 권장)
#   0.0.0.0   → 집 안 Wi-Fi 전용
# Tailscale 이 Termux 보다 늦게 올라오는 경우가 있어, 못 찾으면 30초 뒤 다시 시도한다.
export HUB_HOST="${HUB_HOST:-tailscale}"

# CPU 가 잠들면 소켓이 조용히 죽는다. 이 줄이 없으면 허브가 밤새 먹통이 된다.
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') [start-hub] $*" >> "$LOG"
}

rotate_if_needed() {
  [ -f "$LOG" ] || return 0
  # busybox/coreutils 어느 쪽이든 동작하도록 wc -c 사용
  size=$(wc -c < "$LOG" 2>/dev/null | tr -d ' ')
  [ -n "$size" ] || return 0
  if [ "$size" -gt "$MAX_LOG_BYTES" ]; then
    mv "$LOG" "$LOG.1"
    log "rotated log (was $size bytes)"
  fi
}

cd "$HUB_DIR" || {
  log "FATAL: HUB_DIR not found: $HUB_DIR"
  exit 1
}

log "supervisor started (pid $$)"

while true; do
  rotate_if_needed
  log "starting node src/index.js (HUB_HOST=$HUB_HOST)"
  node src/index.js >> "$LOG" 2>&1
  code=$?

  if [ "$code" -eq "$EXIT_CONFIG" ]; then
    log "설정 문제로 시작하지 못했습니다 (Tailscale 미기동?) — ${CONFIG_RETRY_DELAY}s 뒤 재시도"
    sleep "$CONFIG_RETRY_DELAY"
  else
    log "hub exited with code $code — restarting in ${RESTART_DELAY}s"
    sleep "$RESTART_DELAY"
  fi
done
