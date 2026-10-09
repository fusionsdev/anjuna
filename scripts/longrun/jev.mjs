// Typed decisions for the long-run loop. Usage: bun jev.mjs <review|failure|escalate> <stateFile>
// Prints one token. Jev never approves alone: "review" needs Jev AND the reviewer's VERDICT line to agree.
// Without JEV_API_KEY, on error, or below MIN_CONFIDENCE, the conservative answer is printed.
const [kind, file] = process.argv.slice(2);
const MIN_CONFIDENCE = 0.6;
const text = (await Bun.file(file).text()).slice(-6000);

const verdictLine = (text.match(/VERDICT:\s*(APPROVE|REQUEST_CHANGES|BLOCKER)/i)?.[1] ?? "").toUpperCase();

const QUESTIONS = {
  review: {
    verdict: {
      type: "choice",
      instructions: "What is the code reviewer's verdict on this pull request?",
      criteria: {
        approve: "reviewer approves; only nits or nothing",
        request_changes: "reviewer asks for code changes before merge",
        blocker: "reviewer found a correctness, security, money-path or data-loss bug",
      },
    },
    severity: {
      type: "score",
      instructions: "How severe is the worst issue the reviewer raised?",
      criteria: ["none", "nit or style", "bug that should be fixed", "blocker: money, security or data loss"],
    },
  },
  failure: {
    failure: {
      type: "choice",
      instructions: "Classify why this agent run or test run failed.",
      criteria: {
        rate_limit: "API rate limit, quota, 429, overloaded or usage limit",
        flaky_test: "timeout or intermittent failure unrelated to the change",
        real_test_fail: "typecheck error or a test assertion failing because of the code",
        env_or_tooling: "missing dependency, sandbox, permission, path or tool crash",
        needs_owner: "needs a human decision, credential or account access to continue",
      },
    },
  },
  escalate: {
    escalate: { type: "noul", instructions: "Does fixing this need design judgment beyond a routine code fix?" },
  },
};

const fallback = {
  review: () => (verdictLine === "APPROVE" ? "approve fallback" : "request_changes fallback"),
  failure: () => (/\b429\b|rate.?limit|quota|usage limit/i.test(text) ? "rate_limit" : "real_test_fail"),
  escalate: () => "no",
};

async function ask() {
  const key = process.env.JEV_API_KEY;
  if (!key || !QUESTIONS[kind]) return null;
  const res = await fetch("https://jevtypesafeai.com/api/v1/decide", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state: text, questions: QUESTIONS[kind] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  return (await res.json()).answers;
}

let out;
try {
  const a = await ask();
  if (!a) out = fallback[kind]();
  else if (kind === "review") {
    const ok = a.verdict.choice === "approve" && a.verdict.confidence >= MIN_CONFIDENCE && a.severity.score <= 1;
    out = ok && verdictLine === "APPROVE" ? "approve" : `${a.verdict.choice === "approve" ? "request_changes" : a.verdict.choice} severity=${a.severity.score}`;
  } else if (kind === "failure") {
    out = a.failure.confidence >= MIN_CONFIDENCE ? a.failure.choice : "real_test_fail";
  } else {
    out = a.escalate.noul > 0.6 ? "yes" : "no";
  }
} catch {
  out = fallback[kind]?.() ?? "";
}
console.log(out);
