"""Smoke test: launch a Codex agent through Reflex, watch its stream, archive it."""
import json
import os
import sys
import time
import urllib.request

cfg = json.load(open(os.path.expanduser("~/.reflex/tui.json")))
BASE = "https://reflex.runloop.ai/api"
HDRS = {
    "content-type": "application/json",
    "Authorization": f"Bearer {cfg['apiKey']}",
    "x-organization-id": cfg["organizationId"],
}


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=HDRS, method=method)
    try:
        return json.loads(urllib.request.urlopen(req, timeout=60).read() or b"{}")
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code} on {method} {path}: {e.read()[:400]}")
        raise


agent = call("POST", "/agents", {
    "name": "ensemble-smoke",
    "agentType": "codex",
    "prompt": "Create a file /home/user/hello.txt containing REFLEX_CODEX_OK and then say done.",
    "authMethod": "codex-subscription",
    "providerSecretId": "mps_6LkDVzgYSJu5kAl5wL5PJG",
})
aid = agent.get("id")
print("agent id:", aid, "| streamId:", agent.get("streamId"), "| status:", agent.get("status"))

t0 = time.time()
last = ""
while time.time() - t0 < 420:
    time.sleep(15)
    a = call("GET", f"/agents/{aid}")
    line = f"{a.get('status')} | devbox={a.get('devboxId')} | turn={a.get('turnStatus', a.get('phase',''))}"
    if line != last:
        print(f"[{time.time()-t0:5.0f}s]", line)
        last = line
    if a.get("status") in ("completed", "idle", "failed", "error", "stopped", "done"):
        break

try:
    stream = call("GET", f"/agents/{aid}/stream")
    txt = json.dumps(stream)
    print("stream bytes:", len(txt))
    print("REFLEX_CODEX_OK in stream:", "REFLEX_CODEX_OK" in txt)
except Exception as e:
    print("stream read failed:", e)

if "--keep" not in sys.argv:
    try:
        call("POST", f"/agents/{aid}/archive")
        print("archived")
    except Exception:
        try:
            call("POST", f"/agents/{aid}/complete")
            print("completed")
        except Exception as e:
            print("cleanup failed (fine for smoke):", e)
