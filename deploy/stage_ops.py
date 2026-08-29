"""Stage operations for judging night.

  python deploy/stage_ops.py status        # health, rooms, devboxes, tunnels
  python deploy/stage_ops.py reset-demo    # pristine Roomboard seed on the demo workspace
  python deploy/stage_ops.py redeploy-web  # rebuild web dist + hot-swap hub (same URL)
"""
import base64
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from runloop_api_client import Runloop, RunloopSDK

ROOT = Path(__file__).resolve().parent.parent
ST = json.loads((ROOT / "deploy" / "state_v2.json").read_text())


def status():
    try:
        r = urllib.request.urlopen(ST["hub_url"] + "/healthz", timeout=15)
        print("hub:", r.read().decode())
    except Exception as e:
        print("hub: DOWN —", e)
    try:
        rooms = json.loads(urllib.request.urlopen(ST["hub_url"] + "/rooms", timeout=15).read())
        for room in rooms:
            print(f"  room {room['name']!r}: {room['status']}")
    except Exception as e:
        print("rooms: unreadable —", e)
    rl = Runloop()
    for status_name in ("running", "suspended"):
        for d in rl.devboxes.list(status=status_name).devboxes:
            if (d.name or "").startswith(("ens", "ensemble")):
                print(f"  devbox {d.name}: {status_name} ({d.id})")
    try:
        code = urllib.request.urlopen(ST["preview_url"], timeout=15).status
        print("demo preview:", code)
    except Exception as e:
        print("demo preview: DOWN —", e)


def reset_demo():
    sdk = RunloopSDK()
    ws = sdk.devbox.from_id(ST["demo_ws_id"])
    for f in ("App.jsx", "styles.css"):
        with open(ROOT / "target-app" / "src" / f, "rb") as fh:
            ws.file.upload(path=f"/home/user/app/target-app/src/{f}", file=fh)
    print("demo Roomboard reset to pristine seed (hot reload applies it)")


def redeploy_web():
    subprocess.run(["npm", "run", "build"], cwd=ROOT / "web", check=True, capture_output=True)
    subprocess.run(
        ["tar", "czf", str(ROOT / "deploy" / "bundle_v2.tgz"), "--exclude", "node_modules",
         "--exclude", ".git", "server", "web/dist"], cwd=ROOT, check=True)
    sdk = RunloopSDK()
    hub = sdk.devbox.from_id(ST["hub_id"])
    with open(ROOT / "deploy" / "bundle_v2.tgz", "rb") as f:
        hub.file.upload(path="/home/user/app/bundle.tgz", file=f)
    hub.cmd.exec("cd /home/user/app && tar xzf bundle.tgz && pkill -f 'node index.js' || true")
    time.sleep(1)
    import os
    reflex_cfg = json.loads((Path.home() / ".reflex" / "tui.json").read_text())
    codex_auth = base64.b64encode((Path.home() / ".codex" / "auth.json").read_bytes()).decode()
    demo_ws = json.dumps({"devboxId": ST["demo_ws_id"], "previewUrl": ST["preview_url"]}).replace('"', '\\"')
    env = (
        f"PORT=8080 HOST=0.0.0.0 ENSEMBLE_KEY={ST['ensemble_key']} "
        f"RUNLOOP_API_KEY={os.environ['RUNLOOP_API_KEY']} "
        f"CODEX_AUTH_JSON={codex_auth} "
        f"BUNDLE_PATH=/home/user/app/workspace-bundle.tgz "
        f"PUBLIC_URL={ST['hub_url']} "
        f"DEMO_ROOM=1 DEMO_WORKSPACE_JSON=\"{demo_ws}\" "
        f"DEMO_STEER_TOKEN=crew DEMO_VIEW_TOKEN=watch OPEN_STEERING=1 "
        f"REFLEX_API_KEY={reflex_cfg['apiKey']} REFLEX_ORG={reflex_cfg.get('organizationId', '')} "
    )
    hub.cmd.exec(f"nohup bash -lc 'cd /home/user/app/server && {env} npm start' > /tmp/server.log 2>&1 & echo ok")
    for _ in range(20):
        time.sleep(2)
        code = hub.cmd.exec("curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/healthz; true").stdout().strip()
        if code == "200":
            print("hub redeployed and healthy on the same URL")
            return
    print("WARNING: hub not confirming healthy — check /tmp/server.log on the hub")


if __name__ == "__main__":
    {"status": status, "reset-demo": reset_demo, "redeploy-web": redeploy_web}[sys.argv[1]]()
