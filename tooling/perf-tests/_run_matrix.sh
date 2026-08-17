#!/usr/bin/env bash
# Performance matrix driver for karpathy-wiki.
# Runs Plans A/B/C + compilelock across normal/high/peak load on SMALL vault,
# then generates a LARGE vault and runs Plan A baseline/high, then restores.
set -u
API="D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库/karpathy-wiki/api"
ROOT="D:/code/otherProjects/19_Karpathy-AI+Obsidian知识库"
PFX="$ROOT/tooling/perf-tests"
VAULT="$ROOT/karpathy-wiki/data/vault"
JM="D:/code/Jmeter/apache-jmeter-5.6.3/bin/jmeter.bat"
NODE="C:/Users/hspcadmin/.workbuddy/binaries/node/versions/22.22.2/node.exe"
JAVA_HOME="D:/code/Java/zulu17.52.17-ca-jdk17.0.12-win_x64"
export JAVA_HOME
RESULTS="$PFX/results"
LOG="$RESULTS/_matrix.log"
mkdir -p "$RESULTS"

BACKEND_ENV="WIKI_DISABLE_RATE_LIMIT=1 WIKI_DISABLE_COMPRESSION=1 UV_THREADPOOL_SIZE=64 WIKI_SESSION_SECRET=fixed-perf-test-secret-1234567890 HTTP_PROXY= HTTPS_PROXY= http_proxy= https_proxy= ALL_PROXY= all_proxy="

backend_stop() {
  PID=$(netstat -ano 2>/dev/null | grep ':3000' | grep LISTENING | awk '{print $5}' | head -1)
  if [ -n "$PID" ]; then taskkill /PID $PID /F /T >/dev/null 2>&1; fi
  sleep 2
}
backend_start() {
  cd "$API"
  env $BACKEND_ENV ./node_modules/.bin/tsx src/index.ts > "$RESULTS/_backend.log" 2>&1 &
  echo $! > "$RESULTS/_backend.pid"
}
backend_wait() {
  for i in $(seq 1 45); do
    code=$(curl -s -m 3 -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/health 2>/dev/null)
    if [ "$code" = "200" ]; then echo "backend ready ($(date +%H:%M:%S))"; return 0; fi
    sleep 2
  done
  echo "backend NOT ready"; return 1
}
mock_check() {
  code=$(curl -s -m 3 -o /dev/null -w "%{http_code}" http://127.0.0.1:4000/v1/models 2>/dev/null)
  if [ "$code" != "200" ]; then
    echo "mock down -> starting" | tee -a "$LOG"
    cd "$PFX/mock-llm"
    env MOCK_LLM_LATENCY_MS=800 MOCK_LLM_CHUNKS=8 MOCK_LLM_CHUNK_GAP_MS=120 "$NODE" "$PFX/mock-llm/server.mjs" > "$RESULTS/_mock.log" 2>&1 &
    sleep 3
  fi
}
run_jmx() {
  local name=$1 jmx=$2 threads=$3 duration=$4
  echo "=== RUN $name (threads=$threads dur=$duration) $(date +%H:%M:%S) ===" | tee -a "$LOG"
  cd "$PFX"
  "$JM" -n -t "$jmx" -l "$RESULTS/$name.jtl" -q jmeter.properties -Jthreads=$threads -Jduration=$duration >> "$LOG" 2>&1
  echo "=== DONE $name $(date +%H:%M:%S) ===" | tee -a "$LOG"
}

echo "===== MATRIX START $(date) =====" | tee -a "$LOG"
mock_check

# ---- Phase 1: SMALL vault ----
backend_stop
backend_start
backend_wait

run_jmx A-small-baseline karpathy-perf.jmx 5 12
run_jmx A-small-high    karpathy-perf.jmx 25 12
run_jmx A-small-peak    karpathy-perf.jmx 50 12
run_jmx B-query-normal  karpathy-perf-ai.jmx 5 25
run_jmx B-query-high    karpathy-perf-ai.jmx 30 25
run_jmx B-query-peak    karpathy-perf-ai.jmx 60 25
run_jmx C-write-normal   karpathy-perf-write.jmx 5 25
run_jmx C-write-high     karpathy-perf-write.jmx 20 25
# clean up write pages created by Plan C
find "$VAULT/perf-test" -name 'load-*.md' -delete 2>/dev/null
run_jmx D-compilelock    karpathy-perf-compilelock.jmx 10 25

# ---- Phase 2: LARGE vault ----
echo "=== generating large vault ===" | tee -a "$LOG"
"$NODE" "$PFX/gen-large-vault.mjs" ../../karpathy-wiki/data/vault "$PFX"
backend_stop
backend_start
backend_wait
run_jmx A-large-baseline karpathy-perf.jmx 5 12
run_jmx A-large-high    karpathy-perf.jmx 25 12
# restore small vault
echo "=== restoring small vault (deleting synthetic pages) ===" | tee -a "$LOG"
find "$VAULT" -name 'synthetic-*.md' -delete 2>/dev/null
backend_stop
backend_start
backend_wait

echo "===== MATRIX COMPLETE $(date) =====" | tee -a "$LOG"
