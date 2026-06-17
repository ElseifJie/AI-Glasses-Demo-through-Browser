#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT_DIR/.dev-pids"
LOG_DIR="$ROOT_DIR/.dev-logs"
VEADK_RUNNER="$ROOT_DIR/scripts/run-veadk.sh"

mkdir -p "$LOG_DIR"
touch "$PID_FILE"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SERVICES=("veadk-agent" "gateway" "glasses-web")

log_info()  { printf "${GREEN}[dev]${NC} %s\n" "$1"; }
log_warn()  { printf "${YELLOW}[dev]${NC} %s\n" "$1"; }
log_error() { printf "${RED}[dev]${NC} %s\n" "$1"; }

service_port() {
  case "$1" in
    veadk-agent) echo 9001 ;;
    gateway) echo 8787 ;;
    glasses-web) echo 5173 ;;
    *) return 1 ;;
  esac
}

service_log_file() {
  echo "$LOG_DIR/$1.log"
}

service_start_cmd() {
  case "$1" in
    veadk-agent) echo "bash \"$VEADK_RUNNER\"" ;;
    gateway) echo "node \"$ROOT_DIR/apps/gateway/src/server.mjs\"" ;;
    glasses-web) echo "cd \"$ROOT_DIR/apps/glasses-web\" && npx vite" ;;
    *) return 1 ;;
  esac
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
    if [ "$waited" -ge $((max_wait * 2)) ]; then
      return 1
    fi
  done
  return 0
}

service_pid() {
  local service="$1"
  awk -F: -v name="$service" '$1 == name { print $2 }' "$PID_FILE" | tail -n 1
}

remove_pid_entry() {
  local service="$1"
  local tmp
  tmp="$(mktemp)"
  awk -F: -v name="$service" '$1 != name' "$PID_FILE" > "$tmp"
  mv "$tmp" "$PID_FILE"
}

record_pid() {
  local service="$1"
  local pid="$2"
  remove_pid_entry "$service"
  echo "$service:$pid" >> "$PID_FILE"
}

service_is_running() {
  local service="$1"
  local pid
  pid="$(service_pid "$service")"
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  port_in_use "$(service_port "$service")"
}

start_service() {
  local service="$1"
  local port
  port="$(service_port "$service")"

  if service_is_running "$service"; then
    log_warn "$service 已在运行"
    return 0
  fi

  log_info "→ 启动 $service (port $port)"
  local cmd
  cmd="$(service_start_cmd "$service")"
  bash -lc "$cmd" > "$(service_log_file "$service")" 2>&1 &
  record_pid "$service" "$!"

  if wait_for_port "$port" 30; then
    log_info "  ✓ $service 已就绪"
    return 0
  fi

  log_error "  ✗ $service 启动超时，请查看 $(service_log_file "$service")"
  return 1
}

stop_service() {
  local service="$1"
  local pid
  pid="$(service_pid "$service")"

  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    log_info "  已终止 $service (PID $pid)"
  fi

  local port
  port="$(service_port "$service")"
  local pids
  pids="$(lsof -ti "TCP:$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    for target in $pids; do
      kill "$target" 2>/dev/null || true
    done
    sleep 1
    pids="$(lsof -ti "TCP:$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      for target in $pids; do
        kill -9 "$target" 2>/dev/null || true
      done
      log_warn "  已强制释放 $service 端口 $port"
    fi
  fi

  remove_pid_entry "$service"
}

start_group() {
  local group="$1"
  local services=()

  case "$group" in
    all) services=("veadk-agent" "gateway" "glasses-web") ;;
    backend) services=("veadk-agent" "gateway") ;;
    frontend) services=("glasses-web") ;;
    *) log_error "未知分组: $group"; exit 1 ;;
  esac

  log_info "========================================="
  log_info "  启动 $group"
  log_info "========================================="

  local failed=0
  for service in "${services[@]}"; do
    if ! start_service "$service"; then
      failed=1
    fi
  done

  if [ "$failed" -eq 0 ]; then
    log_info "启动完成"
  else
    log_warn "有服务启动失败，请查看 $LOG_DIR"
    return 1
  fi
}

stop_group() {
  local group="$1"
  local services=()

  case "$group" in
    all) services=("glasses-web" "gateway" "veadk-agent") ;;
    backend) services=("gateway" "veadk-agent") ;;
    frontend) services=("glasses-web") ;;
    *) log_error "未知分组: $group"; exit 1 ;;
  esac

  log_info "正在关闭 $group..."
  for service in "${services[@]}"; do
    stop_service "$service"
  done
  log_info "$group 已关闭"
}

show_status() {
  echo ""
  printf "${CYAN}%-20s %-8s %s${NC}\n" "服务" "端口" "状态"
  printf "${CYAN}%-20s %-8s %s${NC}\n" "--------------------" "--------" "----------"

  for service in "${SERVICES[@]}"; do
    local port
    port="$(service_port "$service")"
    if service_is_running "$service"; then
      printf "%-20s %-8s ${GREEN}● 运行中${NC}\n" "$service" ":$port"
    else
      printf "%-20s %-8s ${RED}○ 未启动${NC}\n" "$service" ":$port"
    fi
  done
  echo ""
}

tail_logs() {
  if compgen -G "$LOG_DIR/*.log" >/dev/null; then
    log_info "实时日志 (Ctrl+C 退出)..."
    tail -f "$LOG_DIR"/*.log 2>/dev/null || true
  else
    log_warn "暂无日志文件，请先启动服务"
  fi
}

print_usage() {
  cat <<'EOF'

用法: bash scripts/dev.sh [命令]

命令:
  start            启动全部服务
  start-frontend   只启动前端 glasses-web
  start-backend    只启动后端 veadk-agent + gateway
  stop             关闭全部服务
  stop-frontend    只关闭前端 glasses-web
  stop-backend     只关闭后端 veadk-agent + gateway
  status           查看各服务运行状态
  logs             实时查看日志

EOF
}

case "${1:-}" in
  start)
    start_group all
    ;;
  start-frontend)
    start_group frontend
    ;;
  start-backend)
    start_group backend
    ;;
  stop)
    stop_group all
    ;;
  stop-frontend)
    stop_group frontend
    ;;
  stop-backend)
    stop_group backend
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
