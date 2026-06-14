#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT_DIR/.dev-pids"
LOG_DIR="$ROOT_DIR/.dev-logs"
VEADK_RUNNER="$ROOT_DIR/scripts/run-veadk.sh"

mkdir -p "$LOG_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()  { printf "${GREEN}[dev]${NC} %s\n" "$1"; }
log_warn()  { printf "${YELLOW}[dev]${NC} %s\n" "$1"; }
log_error() { printf "${RED}[dev]${NC} %s\n" "$1"; }

PORTS=(9001 8787 5173)
PORT_NAMES=("veadk-agent" "gateway" "glasses-web")

start_all() {
  if is_running; then
    log_warn "已有服务在运行，请先执行 stop"
    show_status
    exit 1
  fi

  log_info "========================================="
  log_info "  启动 AI Glasses 全部服务"
  log_info "========================================="

  rm -f "$PID_FILE"
  touch "$PID_FILE"

  log_info "→ veadk-agent (Python, :9001)"
  bash "$VEADK_RUNNER" \
    > "$LOG_DIR/veadk-agent.log" 2>&1 &
  echo "veadk-agent:$!" >> "$PID_FILE"

  sleep 2

  log_info "→ gateway (Node.js, :8787)"
  node "$ROOT_DIR/apps/gateway/src/server.mjs" \
    > "$LOG_DIR/gateway.log" 2>&1 &
  echo "gateway:$!" >> "$PID_FILE"

  log_info "→ glasses-web (Vite, :5173)"
  (cd "$ROOT_DIR/apps/glasses-web" && npx vite --host 127.0.0.1 \
    > "$LOG_DIR/glasses-web.log" 2>&1) &
  echo "glasses-web:$!" >> "$PID_FILE"

  echo ""
  log_info "所有服务已启动，等待就绪..."

  local all_ready=true
  for i in "${!PORTS[@]}"; do
    if wait_for_port "${PORTS[$i]}" 30; then
      log_info "  ✓ ${PORT_NAMES[$i]} (port ${PORTS[$i]}) 就绪"
    else
      log_error "  ✗ ${PORT_NAMES[$i]} (port ${PORTS[$i]}) 启动超时"
      all_ready=false
    fi
  done

  echo ""
  if $all_ready; then
    log_info "========================================="
    log_info "  全部就绪！打开 http://localhost:5173"
    log_info "  日志目录: $LOG_DIR"
    log_info "========================================="
  else
    log_warn "部分服务启动失败，请查看 $LOG_DIR 下的日志"
    show_status
  fi
}

stop_all() {
  log_info "正在关闭所有服务..."

  if [ -f "$PID_FILE" ]; then
    while IFS=: read -r name pid; do
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        log_info "  已终止 $name (PID $pid)"
      fi
    done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi

  sleep 1

  for port in "${PORTS[@]}"; do
    local pids
    pids=$(lsof -ti "TCP:$port" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$pids" ]; then
      for pid in $pids; do
        kill -9 "$pid" 2>/dev/null || true
      done
      log_info "  已释放端口 $port (PID $pids)"
    fi
  done

  log_info "所有服务已关闭"
}

show_status() {
  echo ""
  printf "${CYAN}%-20s %-8s %s${NC}\n" "服务" "端口" "状态"
  printf "${CYAN}%-20s %-8s %s${NC}\n" "--------------------" "--------" "----------"

  for i in "${!PORTS[@]}"; do
    local port="${PORTS[$i]}"
    local name="${PORT_NAMES[$i]}"
    if port_in_use "$port"; then
      printf "%-20s %-8s ${GREEN}● 运行中${NC}\n" "$name" ":$port"
    else
      printf "%-20s %-8s ${RED}○ 未启动${NC}\n" "$name" ":$port"
    fi
  done
  echo ""
}

port_in_use() {
  lsof -i "TCP:$1" -sTCP:LISTEN -t >/dev/null 2>&1
}

wait_for_port() {
  local port="$1"
  local max_wait="${2:-30}"
  local waited=0
  while ! port_in_use "$port"; do
    sleep 0.5
    waited=$((waited + 1))
    if [ $waited -ge $((max_wait * 2)) ]; then
      return 1
    fi
  done
  return 0
}

is_running() {
  for port in "${PORTS[@]}"; do
    if port_in_use "$port"; then
      return 0
    fi
  done
  return 1
}

tail_logs() {
  if [ -f "$LOG_DIR/veadk-agent.log" ] || [ -f "$LOG_DIR/gateway.log" ] || [ -f "$LOG_DIR/glasses-web.log" ]; then
    log_info "实时日志 (Ctrl+C 退出)..."
    tail -f "$LOG_DIR"/*.log 2>/dev/null || true
  else
    log_warn "暂无日志文件，请先 start"
  fi
}

print_usage() {
  echo ""
  echo "用法: bash scripts/dev.sh [命令]"
  echo ""
  echo "命令:"
  echo "  start    一键启动所有服务 (veadk-agent, gateway, glasses-web)"
  echo "  stop     一键关闭所有服务"
  echo "  status   查看各服务运行状态"
  echo "  logs     实时查看所有服务日志"
  echo ""
  echo "示例:"
  echo "  bash scripts/dev.sh start"
  echo "  bash scripts/dev.sh stop"
  echo ""
}

case "${1:-}" in
  start)
    start_all
    ;;
  stop)
    stop_all
    ;;
  status)
    show_status
    ;;
  logs)
    tail_logs
    ;;
  *)
    print_usage
    ;;
esac
