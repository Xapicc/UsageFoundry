#!/bin/bash
# Two (four) concurrent headless cycles of the pinned CLI, same uid, same scratch
# CLAUDE_CONFIG_DIR, different cwds, all against stub.mjs (scenario "pair"):
#   t=0   A (cwd .../cwdA) starts: ListAgents, then a 25s-slow ListAgents, then a 12s-slow end_turn
#   t=5   B (cwd .../cwdB) starts: ListAgents, then SendMessage to A's listed name   -> lands mid-turn
#   t=30  D (cwd .../cwdD) same as B, while A's final request is in flight             -> can it prolong A?
#   after A exits, C (cwd .../cwdC) same as B                                          -> send to an ended session
# Needs AF_UNIX sockets: it does NOT work inside the Claude Code Bash sandbox
# (socket(AF_UNIX) -> EPERM there); run it from an unsandboxed shell as uid node.
# Nothing touches ~/.claude or /tmp/cc-socks: registry and sockets are scratch.
# usage: pair_test.sh [A permission mode, default acceptEdits]
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
OUTROOT=${OUTROOT:-${TMPDIR:-/tmp}/uf-cross-session}
A_MODE=${1:-acceptEdits}
OUT=$OUTROOT/pair-$A_MODE; rm -rf "$OUT"; mkdir -p "$OUT/cfg" "$OUT/run" "$OUT/cwdA" "$OUT/cwdB" "$OUT/cwdC" "$OUT/cwdD"
node $HERE/stub.mjs "$OUT/stub" pair > "$OUT/stub.stdout" 2>&1 &
STUB=$!
for i in $(seq 50); do grep -q PORT "$OUT/stub.stdout" && break; sleep 0.1; done
PORT=$(awk '/PORT/{print $2}' "$OUT/stub.stdout")
cycle() { # role mode
  local role=$1 mode=$2 dir="$OUT/cwd${1#ROLE_}"
  (cd "$dir" && env -i HOME=/home/node PATH="$PATH" TERM=dumb \
    CLAUDE_CONFIG_DIR="$OUT/cfg" XDG_RUNTIME_DIR="$OUT/run" \
    ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" ANTHROPIC_API_KEY=sk-ant-test-dummy \
    timeout 90 claude -p "$role go" --output-format stream-json --verbose \
      --permission-mode "$mode" --allowedTools Grep Glob --disallowedTools 'Bash(pkill:*)' 'Bash(killall:*)' \
      --debug-file "$OUT/$role.debug.log" > "$OUT/$role.stream.jsonl" 2> "$OUT/$role.stderr"; echo "$role exit=$? at $(date +%T)" >> "$OUT/exits.txt")
}
cycle ROLE_A "$A_MODE" & PA=$!
sleep 5;  cycle ROLE_B acceptEdits & PB=$!
sleep 25; ls -la "$OUT/cfg/sessions" "$OUT/run/cc-socks" > "$OUT/registry-while-live.txt" 2>&1
cycle ROLE_D acceptEdits & PD=$!
wait $PA; sleep 2
ls -la "$OUT/cfg/sessions" "$OUT/run/cc-socks" > "$OUT/registry-after-A-exit.txt" 2>&1
cycle ROLE_C acceptEdits
wait $PB $PD
kill $STUB 2>/dev/null
python3 - "$OUT" <<'EOF'
import json,sys,glob,os
o=sys.argv[1]
print(open(o+'/exits.txt').read())
for role in ['ROLE_A','ROLE_B','ROLE_D','ROLE_C']:
    print('=====',role,'stream-json frames')
    for l in open(f'{o}/{role}.stream.jsonl'):
        d=json.loads(l); t=d.get('type'); st=d.get('subtype')
        if t=='system' and st=='init': print(' init: ListAgents' , 'ListAgents' in d['tools'], 'SendMessage', 'SendMessage' in d['tools']); continue
        if t in('assistant','user'):
            c=d['message']['content']
            for b in (c if isinstance(c,list) else [{'type':'text','text':c}]):
                x=b.get('content',b.get('text',b.get('input')))
                if isinstance(x,list): x=' | '.join(y.get('text','') for y in x)
                print(f' {t}.{b["type"]}', b.get('name',''), str(x)[:400].replace('\n',' / '))
        else: print(' ',t,st,json.dumps(d)[:300])
print('===== A main-loop requests: where does the peer text appear?')
for f in sorted(glob.glob(o+'/stub/main-ROLE_A-*.json')):
    b=json.load(open(f)); msgs=b['messages']
    hits=[]
    for i,m in enumerate(msgs):
        for blk in (m['content'] if isinstance(m['content'],list) else [{'type':'text','text':m['content']}]):
            s=json.dumps(blk)
            if 'PING from' in s: hits.append((i,m['role'],blk['type'],s[:500]))
    print(os.path.basename(f),'messages',len(msgs),'peer hits:',hits)
print('===== A transcript lines mentioning the peer message')
for f in glob.glob(o+'/cfg/projects/*/*.jsonl'):
    for l in open(f):
        if 'PING from' in l:
            d=json.loads(l); print(os.path.basename(os.path.dirname(f))[-20:], d.get('type'), d.get('operation'), d.get('origin'), d.get('isMeta'), str(d.get('content') or d.get('message',{}).get('content'))[:300])
EOF
cat "$OUT/registry-while-live.txt" "$OUT/registry-after-A-exit.txt"
grep -h 'uds-messaging\|cross-session-inbound' "$OUT"/ROLE_A.debug.log | cut -c1-300 | head -20
