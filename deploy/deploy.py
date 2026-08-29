"""Deploy Ensemble to two Runloop devboxes: hub (server+web) and agent (runner+codex+target-app).

Usage:
  python deploy/deploy.py            # fresh deploy of both boxes
  python deploy/deploy.py --teardown # shut down boxes from state.json
"""
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from runloop_api_client import RunloopSDK

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "deploy" / "state.json"
KEEP_ALIVE = 4 * 3600


def run_long(devbox, name, command, timeout=420):
    """Run a long command via background + sentinel files, polling with short execs."""
    wrapped = (
        f"nohup bash -lc '({command}) > /tmp/{name}.log 2>&1 && "
        f"touch /tmp/{name}.ok || touch /tmp/{name}.fail' > /dev/null 2>&1 &"
    )
    devbox.cmd.exec(wrapped)
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = devbox.cmd.exec(f"ls /tmp/{name}.ok /tmp/{name}.fail 2>/dev/null; true")
        out = r.stdout()
        if f"{name}.ok" in out:
            print(f"    [{name}] ok in {time.time()-t0:.0f}s")
            return
        if f"{name}.fail" in out:
            log = devbox.cmd.exec(f"tail -30 /tmp/{name}.log").stdout()
            raise RuntimeError(f"step {name} failed:\n{log}")
        time.sleep(3)
    raise TimeoutError(f"step {name} timed out after {timeout}s")


def start_daemon(devbox, name, command):
    devbox.cmd.exec(f"nohup bash -lc '{command}' > /tmp/{name}.log 2>&1 & echo started")


def wait_http_ok(devbox, url_local, tries=30):
    for _ in range(tries):
        r = devbox.cmd.exec(f"curl -s -o /dev/null -w '%{{http_code}}' {url_local}; true")
        if r.stdout().strip() in ("200", "304"):
            return
        time.sleep(2)
    raise TimeoutError(f"{url_local} never became healthy")


def main():
    sdk = RunloopSDK()

    if "--teardown" in sys.argv:
        st = json.loads(STATE.read_text())
        for key in ("hub_id", "agent_id"):
            if st.get(key):
                try:
                    sdk.devbox.from_id(st[key]).shutdown()
                    print(f"shut down {st[key]}")
                except Exception as e:
                    print(f"({key}: {e})")
        return

    ensemble_key = secrets.token_hex(16)
    print("== bundling ==")
    bundle = ROOT / "deploy" / "bundle.tgz"
    subprocess.run(
        ["tar", "czf", str(bundle), "--exclude", "node_modules", "--exclude", ".git",
         "server", "web/dist", "runner", "target-app"],
        cwd=ROOT, check=True,
    )
    print(f"bundle: {bundle.stat().st_size//1024} KB")

    print("== hub devbox ==")
    hub = sdk.devbox.create(
        name="ensemble-hub",
        launch_parameters={"keep_alive_time_seconds": KEEP_ALIVE},
    )
    print(f"  id={hub.id}")
    hub.cmd.exec("mkdir -p /home/user/app")
    with open(bundle, "rb") as f:
        hub.file.upload(path="/home/user/app/bundle.tgz", file=f)
    hub.cmd.exec("cd /home/user/app && tar xzf bundle.tgz")
    run_long(hub, "npm-server", "cd /home/user/app/server && npm install --omit=dev")
    start_daemon(hub, "server",
                 f"cd /home/user/app/server && PORT=8080 HOST=0.0.0.0 ENSEMBLE_KEY={ensemble_key} npm start")
    wait_http_ok(hub, "http://localhost:8080/healthz")
    hub.net.enable_tunnel(auth_mode="open")
    hub_url = hub.get_tunnel_url(8080)
    print(f"  HUB URL: {hub_url}")

    print("== agent devbox ==")
    agent = sdk.devbox.create(
        name="ensemble-agent",
        mounts=[{"type": "agent_mount", "agent_name": "codex"}],
        launch_parameters={"keep_alive_time_seconds": KEEP_ALIVE},
    )
    print(f"  id={agent.id}")
    agent.cmd.exec("mkdir -p /home/user/app /home/user/.codex")
    with open(os.path.expanduser("~/.codex/auth.json"), "rb") as f:
        agent.file.upload(path="/home/user/.codex/auth.json", file=f)
    with open(bundle, "rb") as f:
        agent.file.upload(path="/home/user/app/bundle.tgz", file=f)
    agent.cmd.exec("cd /home/user/app && tar xzf bundle.tgz")
    run_long(agent, "npm-target", "cd /home/user/app/target-app && npm install")
    start_daemon(agent, "vite",
                 "cd /home/user/app/target-app && npm run dev -- --host 0.0.0.0 --port 5173")
    wait_http_ok(agent, "http://localhost:5173/")
    agent.net.enable_tunnel(auth_mode="open")
    preview_url = agent.get_tunnel_url(5173)
    print(f"  PREVIEW URL: {preview_url}")
    start_daemon(agent, "runner",
                 f"cd /home/user/app/runner && SERVER_URL={hub_url} ENSEMBLE_KEY={ensemble_key} "
                 f"TARGET_DIR=/home/user/app/target-app node index.mjs")

    print("== announcing preview to hub ==")
    req = urllib.request.Request(
        f"{hub_url}/runner/events",
        data=json.dumps([{"type": "preview.updated", "payload": {"url": preview_url}}]).encode(),
        headers={"content-type": "application/json", "x-ensemble-key": ensemble_key},
    )
    print("  status:", urllib.request.urlopen(req, timeout=20).status)

    STATE.write_text(json.dumps({
        "hub_id": hub.id, "agent_id": agent.id, "hub_url": hub_url,
        "preview_url": preview_url, "ensemble_key": ensemble_key,
        "deployed_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }, indent=2))
    print(f"\nSTATE -> {STATE}\nJOIN/QR URL: {hub_url}")


if __name__ == "__main__":
    main()
