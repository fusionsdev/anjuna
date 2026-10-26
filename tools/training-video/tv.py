"""Training videos for the control panel: scripted screen recording + Thai voiceover.

    python tv.py login                 # owner signs in once; saves .auth/state.json
    python tv.py voice <id>            # one Edge TTS clip per step -> out/<id>/voice/
    python tv.py record <id>           # Playwright run, 1920x1080 -> out/<id>/screen.webm + timeline.json
    python tv.py compose <id>          # ffmpeg: video + voice + Thai subtitles -> out/<id>.mp4
    python tv.py all <id>              # voice, record, compose
    python tv.py stills <id>           # one PNG per step from the composed MP4 -> out/<id>/stills/

Recording is read-only: every request that is not GET/HEAD/OPTIONS is aborted, so no button
can deploy, save or delete anything. See README.md.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"
AUTH = ROOT / ".auth" / "state.json"
DEFAULT_BASE = "https://app.aduplift.ai"
VOICE = "th-TH-PremwadeeNeural"
RATE = "+0%"
WIDTH, HEIGHT = 1920, 1080
LEAD_IN = 0.3  # seconds between a step's first frame and its narration
TAIL = 0.6  # silence after each narration clip before the next step starts
CHANNEL = "msedge"  # installed Edge; Playwright 1.62 bundled Chromium is not downloaded on this machine
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
# POST endpoints that only read. wizard.ts documents zone-check as a read-only Cloudflare pre-check.
SAFE_POSTS = ("/api/wizard/zone-check",)

# Every element that can show PII or a secret (H:/w/anjuna-wt/_briefs/training-video-panel-map.md).
MASK_SELECTORS = [
    ".user-menu > .btn", ".user-pop .who", ".env-badge", "code.token",
    "form.signin input",
    'table[aria-label="ผู้สมัคร (Applicant)"] td', 'table[aria-label="คุณสมบัติ (Profile)"] td',
    'td[data-label="อีเมล"]', 'td[data-label="ชื่อ"]', 'td[data-label="อีเมล (Email)"]',
    'td[data-label="ผู้ใช้"]', 'td[data-label="เดิม"]', 'td[data-label="ใหม่"]',
    'td[data-label="Drain key"]', 'td[data-label="AID"]', 'td[data-label="Prepop base"]',
    "#settings-aid", "#settings-prepop", "#settings-drain", ".settings-diff td",
    ".drawer li", ".confirm-dialog h2", ".confirm-body", ".toast",
    ".tl-actor .mono", ".tl-note", 'td[data-label="ผู้เริ่ม"]', ".deploy-audit dd",
    ".ce-message", ".conv-reason code", 'input[aria-label="lead_id"]', ".final-url-field",
    'td.mono[data-label="เซสชัน (Session ref)"]', 'td.mono[data-label="รหัสลีด (Lead ID)"]',
    'input[aria-label="โทรศัพท์ (Phone)"]', 'input[aria-label="ที่อยู่ (Address)"]', 'input[aria-label="อีเมล (Email)"]',
    ".lifecycle-detail .section > p:first-of-type code", ".revision-list .muted.small",
    'input[aria-label="คีย์ drain (Drain key)"]', 'input[aria-label="รหัส LeadsGate (LeadsGate aid)"]',
    'input[aria-label="URL ฐาน prepop (Prepop base)"]',
    # BuilderKeys uses a plain table (no data-label): blur the label and key columns on that page.
    'html[data-tv-path="/builder-keys"] main table td:nth-child(-n+2)',
    'td[data-label="คีย์"]', 'td[data-label="ผู้เริ่ม"]', 'td[data-label="เพิ่มโดย (Added by)"]',
]
# Hint lines that start with these words name a person (template submitter); overlay.js blurs them.
MASK_TEXT_PREFIXES = ["ส่งโดย"]


def load_scene(scene_id: str):
    return importlib.import_module(f"scenes.{scene_id}").SCENE


def scene_dir(scene_id: str) -> Path:
    d = OUT / scene_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def ffprobe_seconds(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout
    return float(out.strip())


# ---------- voice ----------

async def _tts(text: str, voice: str, rate: str, out: Path, tries: int = 6) -> None:
    """Edge TTS drops some requests with NoAudioReceived, often for Thai. Retry, then fail on the step."""
    import edge_tts

    for attempt in range(1, tries + 1):
        try:
            await edge_tts.Communicate(text, voice, rate=rate).save(str(out))
            return
        except edge_tts.exceptions.NoAudioReceived:
            if attempt == tries:
                raise SystemExit(f"Edge TTS returned no audio {tries} times for: {text}\nReword this step and run again.")
            await asyncio.sleep(1.5 * attempt)


def cmd_voice(scene_id: str) -> None:
    scene = load_scene(scene_id)
    vdir = scene_dir(scene_id) / "voice"
    vdir.mkdir(exist_ok=True)
    voice, rate = scene.get("voice", VOICE), scene.get("rate", RATE)
    lengths = []
    for i, step in enumerate(scene["steps"]):
        clip = vdir / f"{i:02d}.mp3"
        asyncio.run(_tts(step["say"], voice, rate, clip))
        lengths.append(round(ffprobe_seconds(clip), 3))
        print(f"step {i:02d}  {lengths[-1]:6.2f}s  {step['say'][:40]}")
    (scene_dir(scene_id) / "voice.json").write_text(json.dumps({"voice": voice, "rate": rate, "lengths": lengths}, indent=2))
    print(f"total narration {sum(lengths):.1f}s, voice {voice}")


# ---------- login ----------

def cmd_login(base: str) -> None:
    from playwright.sync_api import sync_playwright

    AUTH.parent.mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, channel=CHANNEL)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        page.goto(base)
        print("Sign in with the employee test account in the browser window (10 minutes).")
        page.wait_for_selector(".user-menu", timeout=600_000)
        ctx.storage_state(path=str(AUTH))
        user = ctx.request.get(base + "/api/me").json()["user"]
        browser.close()
    print(f"saved {AUTH} for {user['email']} ({user['role']})")


# ---------- record ----------

def locate(page, sel: dict):
    scope = page.locator(sel["within"]) if "within" in sel else page
    if "role" in sel:
        loc = scope.get_by_role(sel["role"], name=sel["name"], exact=sel.get("exact", True))
    elif "label" in sel:
        loc = scope.get_by_label(sel["label"], exact=sel.get("exact", True))
    elif "text" in sel:
        loc = scope.get_by_text(sel["text"], exact=sel.get("exact", False))
    else:
        loc = scope.locator(sel["css"])
    if "has_text" in sel:
        loc = loc.filter(has_text=sel["has_text"])
    return loc.nth(sel.get("nth", 0))


CARD_HTML = """<html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#11161c;
color:#e6ebf0;font-family:'Leelawadee UI',Tahoma,sans-serif"><div style="text-align:center">
<div style="font-size:30px;color:#6aa8f5;letter-spacing:.05em">{kicker}</div>
<div style="font-size:72px;font-weight:700;margin-top:16px">{title}</div>
<div style="font-size:34px;color:#98a5b3;margin-top:20px">{sub}</div></div></body></html>"""


class Runner:
    def __init__(self, page, ctx, base: str):
        self.page, self.ctx, self.base = page, ctx, base
        self.mouse = (WIDTH / 2, HEIGHT / 2)
        self.saved_cookies: list = []

    def point(self, sel: dict, ring: bool):
        loc = locate(self.page, sel)
        loc.wait_for(state="visible", timeout=15_000)
        loc.evaluate("el => el.scrollIntoView({block: 'center', behavior: 'smooth'})")
        time.sleep(0.7)
        box = loc.bounding_box()
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        self.page.mouse.move(x, y, steps=25)
        self.mouse = (x, y)
        if ring:
            self.page.evaluate("([x, y]) => window.__tvRing(x, y)", [x, y])
        return loc

    def settle(self) -> None:
        """Wait until <main> has rendered and its loading marks ("…") are gone, up to 10 s."""
        try:
            self.page.wait_for_function("() => { const m = document.querySelector('main'); return !!m && m.innerText.trim().length > 0 && !m.innerText.includes('…'); }", timeout=10_000)
        except Exception:
            print("  still loading after 10 s")
        time.sleep(0.4)

    def run(self, action: tuple) -> None:
        kind, *args = action
        page = self.page
        if kind == "goto":
            page.goto(self.base + args[0], wait_until="networkidle")
            self.settle()
        elif kind == "card":
            kicker, title, sub = (list(args) + ["", ""])[:3]
            page.set_content(CARD_HTML.format(kicker=kicker, title=title, sub=sub))
        elif kind == "click":
            self.point(args[0], ring=False)
            page.mouse.down()
            page.mouse.up()
            page.wait_for_load_state("networkidle")
            self.settle()
        elif kind == "point":
            self.point(args[0], ring=True)
        elif kind == "type":
            loc = self.point(args[0], ring=False)
            loc.click()
            loc.press_sequentially(args[1], delay=90)
        elif kind == "scroll":
            locate(page, args[0]).evaluate("el => el.scrollIntoView({block: 'start', behavior: 'smooth'})")
            time.sleep(0.9)
        elif kind == "select":
            self.point(args[0], ring=True)
            option = args[1]
            loc = locate(page, args[0])
            loc.select_option(**option) if isinstance(option, dict) else loc.select_option(option)
            page.wait_for_load_state("networkidle")
        elif kind == "wait":
            time.sleep(args[0])
        elif kind == "signed_out":
            self.saved_cookies = self.ctx.cookies()
            self.ctx.clear_cookies(name=re.compile("better-auth"))
            page.goto(self.base + "/", wait_until="networkidle")
        elif kind == "signed_in":
            self.ctx.add_cookies(self.saved_cookies)
        else:
            raise ValueError(f"unknown action {kind}")


def guard(route) -> None:
    if route.request.method in SAFE_METHODS or (route.request.method == "POST" and route.request.url.split("?")[0].endswith(SAFE_POSTS)):
        route.continue_()
    else:
        print(f"  blocked {route.request.method} {route.request.url}")
        route.abort()


def cmd_record(scene_id: str, base: str, headed: bool, allow_owner: bool = False) -> None:
    from playwright.sync_api import sync_playwright

    if not AUTH.exists():
        sys.exit("no .auth/state.json: run `python tv.py login` first")
    scene = load_scene(scene_id)
    d = scene_dir(scene_id)
    voice = json.loads((d / "voice.json").read_text())["lengths"]
    if len(voice) != len(scene["steps"]):
        sys.exit("voice.json is stale: run `python tv.py voice` again")
    overlay = (ROOT / "overlay.js").read_text(encoding="utf-8").replace("__MASK_SELECTORS__", json.dumps(MASK_SELECTORS, ensure_ascii=False)).replace("__MASK_TEXT__", json.dumps(MASK_TEXT_PREFIXES, ensure_ascii=False))
    raw = d / "raw"
    for old in raw.glob("*.webm"):
        old.unlink()
    timeline = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not headed, channel=CHANNEL)
        ctx = browser.new_context(
            viewport={"width": WIDTH, "height": HEIGHT}, record_video_dir=str(raw),
            record_video_size={"width": WIDTH, "height": HEIGHT}, storage_state=str(AUTH), locale="th-TH",
        )
        me = ctx.request.get(base + "/api/me")
        role = me.json()["user"]["role"] if me.ok else None
        if role != "employee" and not allow_owner:
            sys.exit(f"signed in as {role!r}: ops videos need an employee account. Run `python tv.py login` again, or pass --allow-owner.")
        ctx.add_init_script(overlay)
        ctx.route("**/*", guard)
        if "draft_stub" in scene:
            got = ctx.request.get(f"{base}/api/wizard/drafts/{scene['draft_stub']}")
            if not got.ok:
                sys.exit(f"draft {scene['draft_stub']} not readable ({got.status})")
            stub = DraftStub(got.json())
            ctx.route("**/api/brands/drafts", stub.handle)
            ctx.route("**/api/brands/*/draft", stub.handle)
        page = ctx.new_page()
        t0 = time.monotonic()
        # The screencast starts small and grows to the viewport; compose trims this warm-up away.
        page.set_content("<body style='margin:0;background:#11161c'></body>")
        time.sleep(1.2)
        runner = Runner(page, ctx, base)
        for i, step in enumerate(scene["steps"]):
            start = time.monotonic() - t0
            for action in step.get("do", []):
                runner.run(tuple(action))
            need = LEAD_IN + voice[i] + TAIL
            left = need - (time.monotonic() - t0 - start)
            if left > 0:
                time.sleep(left)
            timeline.append({"start": round(start, 3), "end": round(time.monotonic() - t0, 3)})
            print(f"step {i:02d}  {start:6.2f}s")
        page.close()
        video = Path(page.video.path())
        ctx.close()
        browser.close()
    video.replace(d / "screen.webm")
    (d / "timeline.json").write_text(json.dumps(timeline, indent=2))
    print(f"recorded {timeline[-1]['end']:.1f}s -> {d / 'screen.webm'}")


class DraftStub:
    """Answers the wizard's draft saves in the browser, so the wizard advances and nothing reaches the server.

    Starts from a real draft (GET /api/wizard/drafts/<id>), so the Review preview iframe has a real draft to render.
    POST /api/brands/drafts and PATCH /api/brands/<id>/draft get WizardDraft / UpdateBrandDraftResponse shapes.
    """

    def __init__(self, draft: dict):
        self.draft = draft

    def handle(self, route) -> None:
        req = route.request
        if req.method not in ("POST", "PATCH"):
            return route.fallback()
        body = req.post_data_json or {}
        d = self.draft
        changed = []
        if "name" in body:
            d["brand"]["name"] = body["name"]; changed.append("name")
        if "keyword_default" in body:
            d["brand"]["keyword_default"] = body["keyword_default"]; changed.append("keyword_default")
        if "template_version_id" in body:
            d["revision"]["template_version_id"] = body["template_version_id"]; changed.append("template_version_id")
        if "profile" in body:
            d["profile"] = body["profile"]; changed += [f"profile.{k}" for k in body["profile"]]
        payload = dict(d) if req.method == "POST" else {**d, "changed": changed}
        print(f"  stubbed {req.method} {req.url.split('/api/')[1]}")
        route.fulfill(status=200, content_type="application/json", body=json.dumps(payload, ensure_ascii=False))


# ---------- compose ----------

def ass_time(t: float) -> str:
    cs = int(round(t * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def chunks(text: str, limit: int = 48) -> list[str]:
    """Split narration at spaces into subtitle lines of at most `limit` characters."""
    lines, cur = [], ""
    for word in text.split():
        if cur and len(cur) + 1 + len(word) > limit:
            lines.append(cur)
            cur = word
        else:
            cur = f"{cur} {word}".strip()
    if cur:
        lines.append(cur)
    return lines


def subtitles(steps: list, timeline: list, lengths: list, offset: float) -> str:
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {WIDTH}
PlayResY: {HEIGHT}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Leelawadee UI,46,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,4,2,2,160,160,48,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    for step, span, length in zip(steps, timeline, lengths):
        lines = chunks(step["say"])
        total = sum(len(s) for s in lines)
        t = span["start"] - offset + LEAD_IN
        for line in lines:
            dur = length * len(line) / total
            events.append(f"Dialogue: 0,{ass_time(t)},{ass_time(t + dur)},Sub,,0,0,0,,{line}")
            t += dur
    return head + "\n".join(events) + "\n"


def cmd_compose(scene_id: str) -> None:
    scene = load_scene(scene_id)
    d = scene_dir(scene_id)
    timeline = json.loads((d / "timeline.json").read_text())
    lengths = json.loads((d / "voice.json").read_text())["lengths"]
    offset = timeline[0]["start"] + 0.15  # drop the blank frames before the first step paints
    end = timeline[-1]["end"] - offset
    (d / "subs.ass").write_text(subtitles(scene["steps"], timeline, lengths, offset), encoding="utf-8")
    inputs, filters, labels = ["-ss", f"{offset:.3f}", "-i", "screen.webm"], [], []
    for i, span in enumerate(timeline):
        inputs += ["-i", f"voice/{i:02d}.mp3"]
        ms = int((span["start"] - offset + LEAD_IN) * 1000)
        filters.append(f"[{i + 1}:a]adelay={ms}|{ms}[a{i}]")
        labels.append(f"[a{i}]")
    filters.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0,apad[aout]")
    filters.append("[0:v]fps=30,ass=subs.ass[vout]")
    out = OUT / f"{scene_id}.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *inputs, "-filter_complex", ";".join(filters),
         "-map", "[vout]", "-map", "[aout]", "-t", f"{end:.3f}", "-c:v", "libx264", "-crf", "20", "-preset", "medium",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(out)],
        check=True, cwd=d,
    )
    print(f"wrote {out} ({ffprobe_seconds(out):.1f}s)")


def cmd_stills(scene_id: str) -> None:
    d = scene_dir(scene_id)
    timeline = json.loads((d / "timeline.json").read_text())
    offset = timeline[0]["start"] + 0.15
    sdir = d / "stills"
    sdir.mkdir(exist_ok=True)
    for i, span in enumerate(timeline):
        t = (span["start"] + span["end"]) / 2 - offset
        subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", str(OUT / f"{scene_id}.mp4"),
                        "-frames:v", "1", str(sdir / f"{i:02d}.png")], check=True)
    print(f"wrote {len(timeline)} stills -> {sdir}")


def main(argv: list[str]) -> None:
    args = [a for a in argv if not a.startswith("--")]
    flags = {a.split("=")[0]: (a.split("=", 1)[1] if "=" in a else True) for a in argv if a.startswith("--")}
    base = flags.get("--base", DEFAULT_BASE)
    if not args:
        sys.exit(__doc__)
    cmd, rest = args[0], args[1:]
    if cmd == "login":
        return cmd_login(base)
    if not rest:
        sys.exit(f"usage: python tv.py {cmd} <scene id>")
    sid = rest[0]
    if cmd in ("voice", "all"):
        cmd_voice(sid)
    if cmd in ("record", "all"):
        cmd_record(sid, base, headed=bool(flags.get("--headed")), allow_owner=bool(flags.get("--allow-owner")))
    if cmd in ("compose", "all"):
        cmd_compose(sid)
    if cmd == "stills":
        cmd_stills(sid)


if __name__ == "__main__":
    main(sys.argv[1:])
