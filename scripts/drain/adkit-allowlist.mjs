/**
 * The AdKit command allowlist, shared by the VPS executor (adkit-executor.mjs) and core (workers/core/src/adkit-terminal.ts,
 * the panel's AdKit Terminal). One module, so panel and VPS accept and refuse the same argument vectors. Pure: no
 * Node imports, no I/O, so a Worker can bundle it. Moved out of adkit-executor.mjs unchanged (T13-6); the executor
 * re-exports ALLOWED_COMMANDS, PROJECT_ARG, assertAllowed, assertProject and CommandNotAllowedError.
 */

/** `<resource> <verb>` after `manage google`. Nothing else may run. */
export const ALLOWED_COMMANDS = Object.freeze([
  "accounts list", "conversions list", "results list", "conversions create",
  "campaigns list", "campaigns create", "campaigns update", "results campaigns",
]);

/** A value argument: never empty and never option-like, so it cannot smuggle a flag such as `--help`. */
export const value = (pattern) => (arg) => typeof arg === "string" && arg !== "" && !arg.startsWith("-") && pattern.test(arg);
export const PROJECT_ARG = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const ACCOUNT = value(/^\d{10}$/);
export const PROJECT = value(PROJECT_ARG);
const DATE = value(/^\d{4}-\d{2}-\d{2}$/);
const BREAKDOWN = value(/^(hour|day)$/);
const CAMPAIGN = value(/^\d{1,20}$/);
const PAGE_TOKEN = value(/^[A-Za-z0-9_=.~+/-]{1,512}$/);
const parseObject = (arg) => {
  if (!value(/^\{/)(arg)) return null;
  try {
    const parsed = JSON.parse(arg);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
const DATA = (arg) => parseObject(arg) !== null;

/**
 * The exact argument vectors of each allowed command: literal strings and value checks, in order. A trailing
 * `--project <p>` is the only optional part. Any other flag, an extra argument or a missing one is rejected.
 * `campaigns update` has two shapes: a status change with --publish, a budget change without it.
 */
const SHAPES = {
  "accounts list": [["manage", "google", "accounts", "list", "--json"]],
  "conversions list": [["manage", "google", "conversions", "list", "--account", ACCOUNT, "--limit", "500", "--json"]],
  "results list": [["manage", "google", "results", "list", "--account", ACCOUNT, "--breakdown", BREAKDOWN, "--from", DATE, "--to", DATE, "--json"]],
  "conversions create": [["manage", "google", "conversions", "create", "--account", ACCOUNT, "--data", DATA, "--publish", "--json"]],
  "campaigns list": [
    ["manage", "google", "campaigns", "list", "--account", ACCOUNT, "--limit", "500", "--json"],
    ["manage", "google", "campaigns", "list", "--account", ACCOUNT, "--limit", "500", "--page-token", PAGE_TOKEN, "--json"],
  ],
  "campaigns create": [["manage", "google", "campaigns", "create", "--account", ACCOUNT, "--data", DATA, "--json"]],
  "campaigns update": [
    ["manage", "google", "campaigns", "update", "--account", ACCOUNT, "--campaign", CAMPAIGN, "--data", DATA, "--publish", "--json"],
    ["manage", "google", "campaigns", "update", "--account", ACCOUNT, "--campaign", CAMPAIGN, "--data", DATA, "--json"],
  ],
};

const matches = (shape, args) => args.length === shape.length
  && shape.every((part, i) => (typeof part === "string" ? args[i] === part : part(args[i])));

/** True when the value holds a `status` or `publish` key at any depth. */
const holdsStatus = (v) => v !== null && typeof v === "object"
  && (Array.isArray(v) ? v.some(holdsStatus) : Object.entries(v).some(([k, x]) => k === "status" || k === "publish" || holdsStatus(x)));

export const sameKeys = (o, keys) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

/**
 * The job-kind rule of the commands that write campaigns. The argv shape alone is not enough: the data and the
 * --publish flag must be the ones that kind is allowed to send.
 */
function kindAllows(command, args, kind) {
  if (command !== "campaigns create" && command !== "campaigns update") return true;
  const data = parseObject(args[args.indexOf("--data") + 1]);
  if (data === null) return false;
  if (command === "campaigns create") return kind === "campaign.draft.create" && !holdsStatus(data);
  const publish = args.includes("--publish");
  if (kind === "campaign.enable") return publish && sameKeys(data, ["status"]) && data.status === "ENABLED";
  if (kind === "campaign.pause") return publish && sameKeys(data, ["status"]) && data.status === "PAUSED";
  if (kind === "campaign.update_budget") {
    return !publish && sameKeys(data, ["dailyBudget"]) && typeof data.dailyBudget === "number"
      && Number.isFinite(data.dailyBudget) && data.dailyBudget > 0 && data.dailyBudget <= BUDGET_MAX;
  }
  return false;
}
export const BUDGET_MAX = 1_000_000;
const campaignBase = ["manage", "google", "results", "campaigns", "--account", ACCOUNT];
const campaignTail = ["--from", DATE, "--to", DATE, "--limit", "500", "--json"];
const campaignShapes = [
  [...campaignBase, ...campaignTail],
  [...campaignBase, "--campaign", value(/^\d+$/), "--breakdown", "hour", "--fields", "cost,clicks,impressions", ...campaignTail],
];

export class CommandNotAllowedError extends Error {}

/**
 * Throws unless argv is exactly one allowed command shape, with or without a trailing `--project <p>`, and the job
 * kind may send it. `kind` is the job's kind; the campaign write commands are refused without one.
 */
export function assertAllowed(args, kind) {
  const command = Array.isArray(args) ? `${args[2]} ${args[3]}` : "";
  const shapes = !Array.isArray(args) ? [] : command === "results campaigns" ? campaignShapes : Object.hasOwn(SHAPES, command) ? SHAPES[command] : [];
  const ok = shapes.length > 0 && args.every((arg) => typeof arg === "string")
    && shapes.some((shape) => matches(shape, args) || matches([...shape, "--project", PROJECT], args))
    && kindAllows(command, args, kind);
  if (!ok) {
    const shown = Array.isArray(args) ? args.slice(0, 4).map(String).join(" ") : String(args);
    throw new CommandNotAllowedError(`adkit command not allowed: ${shown.slice(0, 80) || "(empty)"}`);
  }
}

/** Throws when a configured fallback project is option-like or malformed, before any job runs. */
export function assertProject(project) {
  if (project !== undefined && project !== null && project !== "" && !PROJECT(project)) {
    throw new CommandNotAllowedError(`invalid adkit project: ${String(project).slice(0, 64)}`);
  }
}

// --- AdKit Terminal (T13-6) ------------------------------------------------------------------------
// The panel Terminal sends one `adkit manage ...` line as a `terminal.run` job. parseTerminalLine runs in core before a
// job row exists; the executor runs checkTerminalArgv again on the stored argv. Both end in assertAllowed above, so a
// line the panel accepts is a line the executor accepts, and nothing else runs.

export const TERMINAL_MODES = Object.freeze(["read", "draft", "publish"]);
export const TERMINAL_LINE_MAX = 4000;
/** Most output bytes a terminal job keeps (the executor cuts, core cuts again before it stores or serves). */
export const TERMINAL_OUTPUT_MAX = 20 * 1024;

const READ_COMMANDS = new Set(["accounts list", "conversions list", "results list", "campaigns list", "results campaigns"]);
/** The mode each write command needs. Reading is allowed in every mode. */
const WRITE_MODE = { "campaigns create": "draft", "conversions create": "publish", "campaigns update": "publish" };

const refuse = (reason) => ({ ok: false, reason });

/** Shell metacharacters. adkit is never run through a shell, but a line that holds one is refused outright. */
const SHELL_CHARS = /;|&&|\||`|\$\(|\$\{|[\r\n\0]/;

/** Split on whitespace; single and double quotes group (inside double quotes `\"` and `\\` are escapes). null: a quote is open. */
function tokenize(line) {
  const out = [];
  let cur = "";
  let started = false;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === '"' && ch === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) {
      cur += line[++i];
    } else if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) return null;
  if (started) out.push(cur);
  return out;
}

/** Fill the fixed flags the executor shapes need (`--limit 500`, `--json`), so a short line such as `manage google accounts list` works. */
function normalize(tokens) {
  const a = [...tokens];
  const command = `${a[2]} ${a[3]}`;
  const pi = a.length - 2;
  const project = pi >= 0 && a[pi] === "--project" ? a.splice(pi, 2) : [];
  if (a[a.length - 1] === "--json") a.pop();
  const account = a.indexOf("--account");
  if ((command === "conversions list" || command === "campaigns list") && !a.includes("--limit") && account !== -1) {
    a.splice(account + 2, 0, "--limit", "500");
  }
  if (command === "results campaigns" && !a.includes("--limit")) a.push("--limit", "500");
  // The checker reads the parsed object, so forward exactly that object (JSON.parse keeps the last of a duplicate key).
  const di = a.indexOf("--data");
  const parsed = di !== -1 && di + 1 < a.length ? parseObject(a[di + 1]) : null;
  if (parsed) a[di + 1] = JSON.stringify(parsed);
  return [...a, "--json", ...project];
}

/** The job kind the executor allowlist judges a terminal argv by: a draft create or a pause, else a plain `terminal.run`. */
export function terminalKind(argv) {
  const command = Array.isArray(argv) ? `${argv[2]} ${argv[3]}` : "";
  if (command === "campaigns create") return "campaign.draft.create";
  if (command === "campaigns update") {
    const data = parseObject(argv[argv.indexOf("--data") + 1]);
    if (data && sameKeys(data, ["status"]) && data.status === "PAUSED") return "campaign.pause";
  }
  return "terminal.run";
}

/** Judge a full argv for a mode. Used by parseTerminalLine and again by the executor on the stored argv. */
export function checkTerminalArgv(argv, mode) {
  if (!TERMINAL_MODES.includes(mode)) return refuse("โหมดไม่ถูกต้อง");
  if (!Array.isArray(argv) || argv[0] !== "manage" || argv[1] !== "google") return refuse("รับเฉพาะคำสั่ง adkit manage google ที่อยู่ในรายการอนุญาต");
  const command = `${argv[2]} ${argv[3]}`;
  const need = READ_COMMANDS.has(command) ? "read" : WRITE_MODE[command];
  if (!need) return refuse("คำสั่งนี้ไม่อยู่ในรายการที่อนุญาต");
  if (need !== "read" && need !== mode) {
    return refuse(need === "draft"
      ? "คำสั่งนี้สร้างแคมเปญร่าง สลับเป็นโหมดร่างก่อนส่ง"
      : "คำสั่งนี้เขียนข้อมูลจริง สลับเป็นโหมดเผยแพร่ก่อนส่ง");
  }
  const di = argv.indexOf("--data");
  if (di !== -1) {
    const data = parseObject(argv[di + 1]);
    if (data && JSON.stringify(data) !== argv[di + 1]) return refuse("ข้อมูล JSON ไม่เป็นรูปแบบมาตรฐาน (เช่น คีย์ซ้ำ)");
  }
  if (command === "campaigns update") {
    const data = parseObject(argv[argv.indexOf("--data") + 1]);
    if (data && data.status === "ENABLED") return refuse("เปิดใช้แคมเปญทำที่หน้าแคมเปญเท่านั้น (ตรวจเพดานงบ)");
  }
  try {
    assertAllowed(argv, terminalKind(argv));
  } catch {
    return refuse("รูปแบบคำสั่งไม่ตรงกับที่อนุญาต ตรวจ flag และค่าอีกครั้ง");
  }
  return { ok: true };
}

/**
 * One terminal line to an argv, or the reason it is refused. An optional leading `adkit` is dropped. Nothing is
 * executed here; a refused line never becomes a job.
 */
export function parseTerminalLine(line, mode) {
  if (typeof line !== "string" || line.trim() === "") return refuse("พิมพ์คำสั่งก่อน");
  if (line.length > TERMINAL_LINE_MAX) return refuse("คำสั่งยาวเกินไป");
  if (SHELL_CHARS.test(line)) return refuse("ห้ามใช้ ; && | ` หรือขึ้นบรรทัดใหม่ ส่งได้ทีละหนึ่งคำสั่ง");
  let tokens = tokenize(line);
  if (tokens === null) return refuse("เครื่องหมายคำพูดไม่ครบ");
  if (tokens[0] === "adkit") tokens = tokens.slice(1);
  if (tokens[0] !== "manage" || tokens.length < 4) return refuse("รับเฉพาะคำสั่งที่ขึ้นต้นด้วย manage google");
  const argv = normalize(tokens);
  const verdict = checkTerminalArgv(argv, mode);
  return verdict.ok ? { ok: true, argv, mode } : verdict;
}

const CLICK_KEYS = "gclid|gbraid|wbraid|msclkid|fbclid|click[_-]?id";
// Prefix and suffix are bounded, so a long run of key-like characters costs at most about 64 steps per position.
const SECRET_KEYS = "[A-Za-z_-]{0,32}(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization|credential)[A-Za-z_-]{0,32}";
/** A paging cursor is not a secret: its value is kept so `campaigns list` paging keeps working. */
const keepKey = (key) => /page[_-]?token/i.test(key);
const keepBefore = (text, offset) => /(?:page[_-]?token["']?\s*[:=]?\s*["']?|--page-token\s+)$/i.test(text.slice(Math.max(0, offset - 40), offset));

/** Hide click ids and tokens, then cut to TERMINAL_OUTPUT_MAX bytes. The input is cut first, so the cost is bounded whatever its size. */
export function redactTerminalOutput(text) {
  let out = String(text ?? "").slice(0, TERMINAL_OUTPUT_MAX);
  out = out.replace(/-----BEGIN [A-Z ]{0,24}PRIVATE KEY-----[\s\S]{0,8192}?(?:-----END [A-Z ]{0,24}PRIVATE KEY-----|$)/g, "***");
  out = out.replace(new RegExp(`("(?:${CLICK_KEYS}|${SECRET_KEYS})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi"),
    (m, head) => (keepKey(head) ? m : `${head}"***"`));
  out = out.replace(new RegExp(`\\b((?:${CLICK_KEYS}|${SECRET_KEYS})\\s*[=:]\\s*)[^\\s,"'&}]+`, "gi"),
    (m, head) => (keepKey(head) ? m : `${head}***`));
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***");
  // A bare opaque token: 40 or more characters, or 22 or more mixed-case ones (a Google Ads developer token).
  out = out.replace(/\b[A-Za-z0-9_-]{22,}\b/g, (m, offset, whole) => {
    if (keepBefore(whole, offset)) return m;
    return m.length >= 40 || (/[a-z]/.test(m) && /[A-Z]/.test(m)) ? "***" : m;
  });
  const bytes = new TextEncoder().encode(out);
  if (bytes.length <= TERMINAL_OUTPUT_MAX) return out;
  const note = "\n...(ตัดที่ 20 KB)";
  const room = TERMINAL_OUTPUT_MAX - new TextEncoder().encode(note).length;
  // A cut inside a multibyte character leaves a replacement character; it is dropped.
  return new TextDecoder().decode(bytes.slice(0, room)).replace(/�+$/, "") + note;
}
