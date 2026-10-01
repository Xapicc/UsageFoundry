#!/bin/bash
# Test 1: what tools does a headless -p cycle of the pinned CLI get, and does
# --disallowedTools remove the peer-messaging ones? Runs the real CLI against
# stub.mjs with a dummy key and a scratch config dir; nothing leaves the box.
# usage: run_tools.sh <label> [extra claude args...]
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
OUTROOT=${OUTROOT:-${TMPDIR:-/tmp}/uf-cross-session}
LABEL=$1; shift
OUT=$OUTROOT/$LABEL; rm -rf "$OUT"; mkdir -p "$OUT/cfg" "$OUT/cwd" "$OUT/run"
[ -n "${PRESEED:-}" ] && cp -r "$PRESEED"/. "$OUT/cfg/"
node $HERE/stub.mjs "$OUT/stub" "${SCENARIO:-text}" > "$OUT/stub.stdout" 2>&1 &
STUB=$!
for i in $(seq 50); do grep -q PORT "$OUT/stub.stdout" && break; sleep 0.1; done
PORT=$(awk '/PORT/{print $2}' "$OUT/stub.stdout")
cd "$OUT/cwd"
env -i HOME=/home/node PATH="$PATH" TERM=dumb \
  CLAUDE_CONFIG_DIR="$OUT/cfg" XDG_RUNTIME_DIR="$OUT/run" \
  ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" ANTHROPIC_API_KEY=sk-ant-test-dummy \
  ${EXTRA_ENV:-} \
  timeout 60 claude -p "${PROMPT:-ROLE_A hi}" --output-format stream-json --verbose "$@" \
  > "$OUT/stream.jsonl" 2> "$OUT/stderr.txt"
echo "exit=$?" > "$OUT/exit.txt"
kill $STUB 2>/dev/null
python3 - "$OUT" <<'EOF'
import json,sys,os
o=sys.argv[1]
init=None
for l in open(o+'/stream.jsonl'):
    try: d=json.loads(l)
    except: continue
    if d.get('type')=='system' and d.get('subtype')=='init': init=d
print(open(o+'/exit.txt').read().strip())
if init:
    t=init.get('tools',[])
    print('init tools (%d):'%len(t), ', '.join(t))
    print('init permissionMode:', init.get('permissionMode'), 'apiKeySource:', init.get('apiKeySource'))
mains=[json.loads(l) for l in open(o+'/stub/requests.jsonl') if json.loads(l).get('isMain')] if os.path.exists(o+'/stub/requests.jsonl') else []
if mains:
    print('request tools (%d):'%len(mains[0]['toolNames']), ', '.join(mains[0]['toolNames']))
else:
    print('no main-loop request logged')
print('stderr:', open(o+'/stderr.txt').read()[:600])
EOF
