import { execFile, spawnSync } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = join(root, "scripts/smoke-web.sh");
const html = '<!doctype html><title>release fixture</title>';
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "web-smoke-"));
  await writeFile(join(directory, "index.html"), html);
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe("web smoke against local HTTP fixtures", () => {
  const cases = [
    { name: "authenticated matching 200", token: "both", status: 200, body: html, ok: true },
    { name: "authenticated HTML mismatch", token: "both", status: 200, body: "stale release", ok: false },
    { name: "authenticated 302 never downgrades", token: "both", status: 302, ok: false },
    { name: "authenticated rejected token", token: "both", status: 403, ok: false },
    { name: "missing token accepts Access 302", token: "none", status: 302, ok: true },
    { name: "missing client secret sends no partial header", token: "id", status: 302, ok: true },
    { name: "missing client ID sends no partial header", token: "secret", status: 302, ok: true },
    { name: "anonymous matching 200", token: "none", status: 200, body: html, ok: true },
    { name: "anonymous HTML mismatch", token: "none", status: 200, body: "login page", ok: false },
    { name: "anonymous 500", token: "none", status: 500, ok: false },
    { name: "unrelated redirect", token: "none", status: 302, location: "https://example.test/", ok: false },
    { name: "spoofed Access suffix", token: "none", status: 302, location: "https://team.cloudflareaccess.com.evil.test/", ok: false },
    { name: "Access name in query", token: "none", status: 302, location: "https://example.test/?cloudflareaccess.com/", ok: false },
    { name: "insecure Access redirect", token: "none", status: 302, location: "http://team.cloudflareaccess.com/", ok: false },
  ];
  it.each(cases)("$name", async ({ token, status, body, location, ok }) => {
    const requests: IncomingHttpHeaders[] = [];
    const server = createServer((req, res) => {
      requests.push(req.headers);
      res.writeHead(status, status === 302 ? {
        location: location ?? "https://fixture.cloudflareaccess.com/cdn-cgi/access/login",
      } : {});
      res.end(body ?? "");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      const result = await new Promise<{ code: number; output: string }>((resolve) => {
        execFile("bash", [script, `http://127.0.0.1:${address.port}/`, join(directory, "index.html")], {
          env: {
            ...process.env,
            TMPDIR: directory,
            CF_ACCESS_CLIENT_ID: token === "both" || token === "id" ? "fixture-id" : "",
            CF_ACCESS_CLIENT_SECRET: token === "both" || token === "secret" ? "fixture-secret" : "",
            NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1",
          },
          timeout: 5000,
        }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, output: stdout + stderr }));
      });
      expect(result.code, result.output).toBe(ok ? 0 : 1);
      expect(result.output).toContain(`web smoke mode: ${token === "both" ? "authenticated" : "anonymous-fallback"}`);
      expect(result.output).not.toContain("fixture-secret");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.["cf-access-client-id"]).toBe(token === "both" ? "fixture-id" : undefined);
      expect(requests[0]?.["cf-access-client-secret"]).toBe(token === "both" ? "fixture-secret" : undefined);
      expect(await readdir(directory)).toEqual(["index.html"]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

it("validates workflow YAML, shell syntax, tenant wiring and preserved main fixes", async () => {
  const source = await readFile(join(root, ".github/workflows/deploy.yml"), "utf8");
  expect(source).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
  const document = parseDocument(source, { uniqueKeys: true });
  expect(document.errors).toEqual([]);
  const workflow = document.toJS() as {
    jobs: Record<string, { needs?: string; if?: string; steps: { name?: string; run?: string; env?: Record<string, string> }[] }>;
  };
  expect(workflow.jobs["deploy-friend"]?.if).toBe("${{ vars.FRIEND_ENABLED == 'true' }}");
  expect(workflow.jobs["deploy-friend"]?.needs).toBe("deploy-aduplift");
  for (const tenant of ["aduplift", "friend"]) {
    const steps = workflow.jobs[`deploy-${tenant}`]?.steps;
    const web = steps?.find((step) => step.name === `Smoke test web (${tenant})`);
    const prefix = tenant === "friend" ? "FRIEND_" : "";
    expect(web?.env?.CF_ACCESS_CLIENT_ID).toBe(`\${{ secrets.${prefix}CF_ACCESS_CLIENT_ID }}`);
    expect(web?.env?.CF_ACCESS_CLIENT_SECRET).toBe(`\${{ secrets.${prefix}CF_ACCESS_CLIENT_SECRET }}`);
    const url = tenant === "friend" ? "https://${{ vars.FRIEND_APP_DOMAIN }}/" : "https://app.aduplift.ai/";
    expect(web?.run?.trim()).toBe(`bash scripts/smoke-web.sh "${url}" apps/web/dist/client/index.html`);
    const core = steps?.find((step) => step.name === `Smoke test core (${tenant})`);
    expect(core?.run).toContain("/api/conversions/pending");
    expect(core?.run).toContain('test "$STATUS" = "401"');
  }
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (!step.run) continue;
      // GitHub substitutes expressions before Bash parses the step.
      const result = spawnSync("bash", ["-n"], { input: step.run.replace(/\$\{\{.*?\}\}/g, "fixture"), encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
  }
  const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
});
