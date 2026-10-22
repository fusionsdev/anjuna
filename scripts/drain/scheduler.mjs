#!/usr/bin/env node
/**
 * Docker scheduler for the hstgr drain container. Every 10 minutes:
 *   1. write /tmp/heartbeat (the container health check reads it),
 *   2. refresh /data/routing.json from core (a failure keeps the previous file),
 *   3. run the unchanged drain.mjs with BRAND_ROUTING_JSON from that file when it holds at least 1 brand.
 *      An empty map stays unset: drain.mjs would skip every row instead of using legacy single-account mode.
 *   4. once an hour (55 minutes or more since the last start), run spend-sync.mjs (FUS-368), which
 *      copies ad spend from AdKit into core. A failure waits for the next hour.
 * Ticks never overlap: the next one is scheduled after the current one ends.
 *
 * Plain Node 20, no dependencies. FORM_BASE_URL and DRAIN_TOKEN come from the container env.
 */
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { routingFromFile } from "./routing-env.mjs";

const APP_DIR = "/app";
const ROUTING_FILE = "/data/routing.json";
const HEARTBEAT_FILE = "/tmp/heartbeat";
const INTERVAL_MS = 10 * 60 * 1000;
const RUN_TIMEOUT_MS = 9 * 60 * 1000;
const SPEND_INTERVAL_MS = 55 * 60 * 1000;
let lastSpendAt = 0;

function run(script, args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd: APP_DIR, env, timeout: RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        resolve(error ? (typeof error.code === "number" ? error.code : 1) : 0);
      });
  });
}

async function tick() {
  const started = new Date().toISOString();
  console.log(`[scheduler] tick start ${started}`);
  writeFileSync(HEARTBEAT_FILE, started);

  const refreshed = await run("refresh-routing.mjs", [ROUTING_FILE], process.env);
  if (refreshed !== 0) console.error(`[scheduler] routing refresh failed (exit ${refreshed}); keeping the previous ${ROUTING_FILE}`);

  const routing = routingFromFile(ROUTING_FILE);
  const env = routing ? { ...process.env, BRAND_ROUTING_JSON: routing } : process.env;
  const code = await run("drain.mjs", [], env);
  console.log(`[scheduler] tick end ${new Date().toISOString()} drain exit ${code}`);

  if (Date.now() - lastSpendAt >= SPEND_INTERVAL_MS) {
    lastSpendAt = Date.now();
    writeFileSync(HEARTBEAT_FILE, new Date(lastSpendAt).toISOString());
    const spend = await run("spend-sync.mjs", [], process.env);
    console.log(`[scheduler] spend sync exit ${spend}`);
  }
}

async function loop() {
  try {
    await tick();
  } catch (e) {
    console.error("[scheduler] tick error:", e);
  }
  setTimeout(loop, INTERVAL_MS);
}

void loop();
