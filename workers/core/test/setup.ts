import { afterAll } from "vitest";
import { leakedRuntimes } from "./helpers.js";

// Every Miniflare keeps a workerd process and a loopback listener until disposed.
// A file that skips dispose leaves them alive for the whole run, so fail the file and clean up.
afterAll(async () => {
  const leaked = leakedRuntimes();
  await Promise.all(leaked.map((mf) => mf.dispose()));
  if (leaked.length) throw new Error(`${leaked.length} Miniflare runtime(s) not disposed by the test file`);
});
