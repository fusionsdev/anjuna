/**
 * Local certification dry run for the upgrade-test templates. No network, no secrets.
 *   bun run scripts/upgrade-test-templates/check-local.ts [path-to-reference-dist ...]
 * Runs the template-cert lint on a/ and b/, then the template-mcp similarity fingerprint
 * of A vs B and of each against every reference dist given (e.g. a built template-astro-starter dist).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSource, runChecks } from "../../packages/template-cert/src/index.ts";
import { computeFingerprint, compareFingerprints } from "../../workers/template-mcp/src/fingerprint.ts";

const here = dirname(fileURLToPath(import.meta.url));
const load = (dir: string) => {
  const s = loadSource(dir);
  if ("message" in s) throw new Error(`${dir}: ${s.message}`);
  return s;
};

const THRESHOLD = 0.5;
const targets = { a: load(join(here, "a")), b: load(join(here, "b")) };
let failed = false;

for (const [name, source] of Object.entries(targets)) {
  const r = runChecks(source);
  console.log(`lint ${name}: ${r.ok ? "PASS" : "FAIL"} (${r.errors} errors, ${r.warnings} warnings)`);
  for (const c of r.checks) {
    console.log(`  ${c.rule}: ${c.status}`);
    for (const i of c.issues) console.log(`    [${i.severity}] ${i.location}: ${i.en}`);
  }
  if (!r.ok) failed = true;
}

const prints = {
  a: await computeFingerprint(targets.a.files),
  b: await computeFingerprint(targets.b.files),
};
const compare = (label: string, x: typeof prints.a, y: typeof prints.a) => {
  const { score, signals, sharedImages } = compareFingerprints(x, y);
  const similar = score >= THRESHOLD || signals.text >= 0.5 || sharedImages >= 3;
  console.log(`similarity ${label}: score ${score.toFixed(3)} ${similar ? "FAIL (similar)" : "pass"} signals ${JSON.stringify(signals)}`);
  return similar;
};

// A vs B is informational: similarityCheck only compares against SEALED versions, so B passes while A is unsealed.
compare("A vs B (informational, matters only if A is sealed before B is certified)", prints.a, prints.b);
for (const ref of process.argv.slice(2)) {
  const fp = await computeFingerprint(load(ref).files);
  if (compare(`A vs ${ref}`, prints.a, fp)) failed = true;
  if (compare(`B vs ${ref}`, prints.b, fp)) failed = true;
}
process.exitCode = failed ? 1 : 0;
