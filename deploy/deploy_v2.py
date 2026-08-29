"""Deploy Ensemble V2: hub (server+web+provisioner) + pinned demo workspace.

Usage:
  python deploy/deploy_v2.py            # fresh deploy of both boxes
  python deploy/deploy_v2.py --teardown
"""
import base64
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
STATE = ROOT / "deploy" / "state_v2.json"
KEEP_ALIVE = 8 * 3600


def run_long(devbox, name, command, timeout=420):
    wrapped = (
        f"nohup bash -lc '({command}) > /tmp/{name}.log 2>&1 && "
        f"touch /tmp/{name}.ok || touch /tmp/{name}.fail' > /dev/null 2>&1 &"
    )
    devbox.cmd.exec(wrapped)
    t0 = time.time()
    while time.time() - t0 < timeout:
        out = devbox.cmd.exec(f"ls /tmp/{name}.ok /tmp/{name}.fail 2>/dev/null; true").stdout()
        if f"{name}.ok" in out:
            print(f"    [{name}] ok in {time.time()-t0:.0f}s")
            return
        if f"{name}.fail" in out:
            raise RuntimeError(f"step {name} failed:\n" + devbox.cmd.exec(f"tail -30 /tmp/{name}.log").stdout())
        time.sleep(3)
    raise TimeoutError(f"step {name} timed out")


def start_daemon(devbox, name, command):
    devbox.cmd.exec(f"nohup bash -lc '{command}' > /tmp/{name}.log 2>&1 & echo started")


def wait_http_ok(devbox, url_local, tries=30):
    for _ in range(tries):
        code = devbox.cmd.exec(f"curl -s -o /dev/null -w '%{{http_code}}' {url_local}; true").stdout().strip()
        if code in ("200", "304"):
            return
        time.sleep(2)
    raise TimeoutError(f"{url_local} never became healthy")


def upload(devbox, local, remote):
    with open(local, "rb") as f:
        devbox.file.upload(path=remote, file=f)


def main():
    sdk = RunloopSDK()

    if "--teardown" in sys.argv:
        st = json.loads(STATE.read_text())
        for key in ("hub_id", "demo_ws_id"):
            if st.get(key):
                try:
                    sdk.devbox.from_id(st[key]).shutdown()
                    print("shut down", st[key])
                except Exception as e:
                    print(f"({key}: {e})")
        return

    reflex_cfg = {}
    tui = Path.home() / ".reflex" / "tui.json"
    if tui.exists():
        reflex_cfg = json.loads(tui.read_text())
    codex_auth_b64 = base64.b64encode((Path.home() / ".codex" / "auth.json").read_bytes()).decode()
    ensemble_key = secrets.token_hex(16)

    print("== bundling ==")
    subprocess.run(["npm", "run", "build"], cwd=ROOT / "web", check=True, capture_output=True)
    main_bundle = ROOT / "deploy" / "bundle_v2.tgz"
    ws_bundle = ROOT / "deploy" / "workspace-bundle.tgz"
    subprocess.run(["tar", "czf", str(main_bundle), "--exclude", "node_modules", "--exclude", ".git",
                    "server", "web/dist"], cwd=ROOT, check=True)
    subprocess.run(["tar", "czf", str(ws_bundle), "--exclude", "node_modules", "--exclude", ".git",
                    "runner", "target-app", "sessions-seed"], cwd=ROOT, check=True)
    print(f"main {main_bundle.stat().st_size//1024}KB ws {ws_bundle.stat().st_size//1024}KB")

    print("== demo workspace devbox ==")
    ws = sdk.devbox.create(
        name="ensemble-demo-ws",
        mounts=[{"type": "agent_mount", "agent_name": "codex"}],
        launch_parameters={"keep_alive_time_seconds": KEEP_ALIVE},
    )
    print("  id=", ws.id)
    ws.cmd.exec("mkdir -p /home/user/app /home/user/.codex")
    upload(ws, Path.home() / ".codex" / "auth.json", "/home/user/.codex/auth.json")
    upload(ws, ws_bundle, "/home/user/app/bundle.tgz")
    ws.cmd.exec("cd /home/user/app && tar xzf bundle.tgz")
    ws.cmd.exec("mkdir -p /home/user/.codex/sessions/2026/08/29 && "
                "cp /home/user/app/sessions-seed/*.jsonl /home/user/.codex/sessions/2026/08/29/ 2>/dev/null; true")
    run_long(ws, "npm-target", "cd /home/user/app/target-app && npm install")
    start_daemon(ws, "vite", "cd /home/user/app/target-app && npm run dev -- --host 0.0.0.0 --port 5173")
    wait_http_ok(ws, "http://localhost:5173/")
    ws.net.enable_tunnel(auth_mode="open")
    preview_url = ws.get_tunnel_url(5173)
    print("  PREVIEW:", preview_url)

    print("== hub devbox ==")
    hub = sdk.devbox.create(name="ensemble-hub-v2",
                            launch_parameters={"keep_alive_time_seconds": KEEP_ALIVE})
    print("  id=", hub.id)
    hub.cmd.exec("mkdir -p /home/user/app")
    upload(hub, main_bundle, "/home/user/app/bundle.tgz")
    upload(hub, ws_bundle, "/home/user/app/workspace-bundle.tgz")
    hub.cmd.exec("cd /home/user/app && tar xzf bundle.tgz")
    run_long(hub, "npm-server", "cd /home/user/app/server && npm install --omit=dev")
    hub.net.enable_tunnel(auth_mode="open")
    hub_url = hub.get_tunnel_url(8080)

    demo_ws_json = json.dumps({"devboxId": ws.id, "previewUrl": preview_url}).replace('"', '\\"')
    env = (
        f"PORT=8080 HOST=0.0.0.0 ENSEMBLE_KEY={ensemble_key} "
        f"RUNLOOP_API_KEY={os.environ['RUNLOOP_API_KEY']} "
        f"CODEX_AUTH_JSON={codex_auth_b64} "
        f"BUNDLE_PATH=/home/user/app/workspace-bundle.tgz "
        f"PUBLIC_URL={hub_url} "
        f"DEMO_ROOM=1 DEMO_WORKSPACE_JSON=\"{demo_ws_json}\" "
        f"DEMO_STEER_TOKEN=crew DEMO_VIEW_TOKEN=watch "
        f"OPEN_STEERING=1 "
    )
    if reflex_cfg.get("apiKey"):
        env += f"REFLEX_API_KEY={reflex_cfg['apiKey']} REFLEX_ORG={reflex_cfg.get('organizationId','')} "
    start_daemon(hub, "server", f"cd /home/user/app/server && {env} npm start")
    wait_http_ok(hub, "http://localhost:8080/healthz")
    print("  HUB:", hub_url)

    print("== demo workspace runner ==")
    agents = json.dumps([{"agentId": "turbo", "label": "Codex Turbo", "engine": "runner",
                          "model": "gpt-5.3-codex-spark"}]).replace('"', '\\"')
    start_daemon(ws, "runner",
                 f'cd /home/user/app/runner && SERVER_URL={hub_url} ENSEMBLE_KEY={ensemble_key} '
                 f'ROOM_ID=demo AGENTS="{agents}" TARGET_DIR=/home/user/app/target-app node index.mjs')

    STATE.write_text(json.dumps({
        "hub_id": hub.id, "demo_ws_id": ws.id, "hub_url": hub_url,
        "preview_url": preview_url, "ensemble_key": ensemble_key,
        "deployed_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }, indent=2))
    print(f"\nSTATE -> {STATE}\nHOME/QR URL: {hub_url}")


if __name__ == "__main__":
    main()
