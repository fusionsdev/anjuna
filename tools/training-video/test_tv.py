"""python -m pytest tools/training-video -q"""
import json
import pkgutil
import re

import pytest

import scenes
import tv

SCENE_IDS = [m.name for m in pkgutil.iter_modules(scenes.__path__)]
KNOWN = {"goto", "card", "click", "point", "type", "scroll", "select", "wait", "signed_out", "signed_in"}
# Labels of buttons that deploy, save, approve or delete. Scenes may point at them, never click.
EFFECT = re.compile(r"ติดตั้ง \(Install\)|สร้างเว็บไซต์|ลองใหม่|Rollback|Redeploy|Recover|Pause|Resume|หมุน|Revoke|ลบ|บันทึก|อนุมัติ|นำเข้า|สร้างคีย์|Approve|Delete|Save|Import|Upgrade")


def test_scene_ids_found():
    assert {"ep01_home", "ep03_install"} <= set(SCENE_IDS)


@pytest.mark.parametrize("sid", SCENE_IDS)
def test_scene_schema(sid):
    scene = tv.load_scene(sid)
    assert scene["title"]
    for step in scene["steps"]:
        assert step["say"].strip()
        for action in step.get("do", []):
            assert action[0] in KNOWN, action


@pytest.mark.parametrize("sid", SCENE_IDS)
def test_scenes_never_click_effect_buttons(sid):
    for step in tv.load_scene(sid)["steps"]:
        for action in step.get("do", []):
            if action[0] in ("click", "type", "select"):
                assert not EFFECT.search(json.dumps(action[1], ensure_ascii=False)), action


@pytest.mark.parametrize("sid", SCENE_IDS)
def test_signed_out_is_restored(sid):
    flat = [a[0] for s in tv.load_scene(sid)["steps"] for a in s.get("do", [])]
    assert flat.count("signed_out") == flat.count("signed_in")


class FakeRoute:
    def __init__(self, method):
        self.request = type("R", (), {"method": method, "url": "https://app.aduplift.ai/api/x"})()
        self.result = None

    def continue_(self):
        self.result = "continue"

    def abort(self):
        self.result = "abort"


@pytest.mark.parametrize("method,result", [("GET", "continue"), ("HEAD", "continue"), ("POST", "abort"), ("PUT", "abort"), ("PATCH", "abort"), ("DELETE", "abort")])
def test_guard_blocks_writes(method, result):
    route = FakeRoute(method)
    tv.guard(route)
    assert route.result == result


def test_mask_covers_secrets_and_pii():
    must = ["code.token", ".user-menu > .btn", 'td[data-label="Drain key"]', "#settings-drain",
            'table[aria-label="ผู้สมัคร (Applicant)"] td', 'input[aria-label="lead_id"]', ".toast", "form.signin input"]
    for sel in must:
        assert sel in tv.MASK_SELECTORS


def test_chunks_fit_and_keep_words():
    text = "ไปที่เมนู แบรนด์ หน้านี้รวมทุกแบรนด์ ปุ่มด้านบนใช้กรองตามสถานะ เช่น ใช้งาน หยุดชั่วคราว หรือ ติดตั้งล้มเหลว"
    lines = tv.chunks(text, 48)
    assert all(len(line) <= 48 for line in lines)
    assert " ".join(lines) == text


def test_ass_time():
    assert tv.ass_time(0) == "0:00:00.00"
    assert tv.ass_time(75.456) == "0:01:15.46"


def test_subtitles_follow_timeline():
    steps = [{"say": "หนึ่ง สอง"}, {"say": "สาม"}]
    ass = tv.subtitles(steps, [{"start": 1.0, "end": 4.0}, {"start": 4.0, "end": 6.0}], [2.0, 1.0], offset=1.0)
    events = [l for l in ass.splitlines() if l.startswith("Dialogue")]
    assert events[0].startswith(f"Dialogue: 0,{tv.ass_time(tv.LEAD_IN)}")
    assert events[1].startswith(f"Dialogue: 0,{tv.ass_time(3.0 + tv.LEAD_IN)}")
