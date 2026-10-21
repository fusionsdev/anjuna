#!/usr/bin/env node
/**
 * Docker scheduler for the hstgr drain container. Every 10 minutes:
 *   1. write /tmp/heartbeat (the container health check reads it),
 *   2. refresh /data/routing.json from core (a failure keeps the previous file),
 *   3. run the unchanged drain.mjs with BRAND_ROUTING_JSON from that file when present.
 * Ticks never overlap: the next one is scheduled after the current one ends.
 *
 * Plain Node 20, no dependencies. FORM_BASE_URL and DRAIN_TOKEN come from the container env.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const APP_DIR = "/app";
const ROUTING_FILE = "/data/routing.json";
const HEARTBEAT_FILE = "/tmp/heartbeat";
const INTERVAL_MS = 10 * 60 * 1000;
const RUN_TIMEOUT_MS = 9 * 60 * 1000;

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

function routingJson() {
  try {
    const text = readFileSync(ROUTING_FILE, "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

async function tick() {
  const started = new Date().toISOString();
  console.log(`[scheduler] tick start ${started}`);
  writeFileSync(HEARTBEAT_FILE, started);

  const refreshed = await run("refresh-routing.mjs", [ROUTING_FILE], process.env);
  if (refreshed !== 0) console.error(`[scheduler] routing refresh failed (exit ${refreshed}); keeping the previous ${ROUTING_FILE}`);

  const routing = routingJson();
  const env = routing ? { ...process.env, BRAND_ROUTING_JSON: routing } : process.env;
  const code = await run("drain.mjs", [], env);
  console.log(`[scheduler] tick end ${new Date().toISOString()} drain exit ${code}`);
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
