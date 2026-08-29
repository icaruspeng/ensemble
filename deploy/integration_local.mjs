// Local end-to-end integration: server + runner + REAL codex editing target-app.
// Usage: node deploy/integration_local.mjs "steer text"
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "integration-test-key";
const PORT = 8080;
const steerText = process.argv[2] || "Add a footer to the page that says: built live by Ensemble";
const children = [];

function start(name, cmd, args, env = {}, cwd = ROOT) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`.slice(0, 400)));
  p.stderr.on("data", (d) => process.stdout.write(`[${name}!] ${d}`.slice(0, 400)));
  children.push(p);
  return p;
}

function cleanup(code) {
  for (const p of children) try { p.kill("SIGKILL"); } catch {}
  process.exit(code);
}
process.on("SIGINT", () => cleanup(130));

start("server", "node", ["index.js"], { PORT: String(PORT), ENSEMBLE_KEY: KEY, HOST: "127.0.0.1" }, path.join(ROOT, "server"));
await sleep(1500);

start("runner", "node", ["index.mjs"], {
  SERVER_URL: `http://127.0.0.1:${PORT}`,
  ENSEMBLE_KEY: KEY,
  TARGET_DIR: path.join(ROOT, "target-app"),
}, path.join(ROOT, "runner"));
await sleep(500);

const seen = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("TIMEOUT waiting for crew.task_completed")), 240_000);
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", name: "IntegrationDriver" }));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === "welcome") {
      console.log(`[ws] welcome: actor=${msg.actorId} driver=${msg.driverActorId} replay=${msg.events.length}`);
      ws.send(JSON.stringify({ type: "steer", text: steerText }));
      return;
    }
    if (msg.type !== "event") return;
    const e = msg.event;
    seen.push(e.type);
    const brief = (e.payload?.text || e.payload?.command || e.payload?.summary || "").slice(0, 90);
    console.log(`[ws] ${e.seq} ${e.type} ${brief}`);
    if (e.type === "crew.task_completed") { clearTimeout(timer); resolve(e); }
    if (e.type === "crew.task_failed") { clearTimeout(timer); reject(new Error("task failed: " + JSON.stringify(e.payload))); }
  };
  ws.onerror = (err) => reject(new Error("ws error " + err.message));
});

try {
  const completed = await done;
  console.log("\n=== COMPLETED ===");
  console.log("tokens:", completed.payload.tokens, "cost:", completed.payload.costUsd);
  const must = ["crew.actor_post", "crew.task_dispatched", "agent.turn_started", "agent.turn_completed", "crew.task_completed"];
  const missing = must.filter((t) => !seen.includes(t));
  console.log("event types seen:", [...new Set(seen)].join(", "));
  console.log(missing.length ? "MISSING: " + missing.join(", ") : "ALL REQUIRED EVENTS PRESENT");
  console.log(seen.includes("ledger.updated") ? "ledger updated ✓" : "WARN: no ledger.updated");
  cleanup(missing.length ? 1 : 0);
} catch (err) {
  console.error("INTEGRATION FAILED:", err.message);
  cleanup(1);
}
