"""Full-loop check for the AURUM v3 spike.

Usage: python e2e.py <brand_base> <core_base> <postback_token> <drain_token>
Prints one PASS/FAIL line per check; exit code 1 if anything failed.
"""
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

BRAND, CORE, PB_TOKEN, DRAIN_TOKEN = sys.argv[1:5]
results = []


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


opener = urllib.request.build_opener(NoRedirect)


def req(method, url, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"content-type": "application/json", "user-agent": "spike-e2e"} if data else {"user-agent": "spike-e2e"}
    h.update(headers or {})
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        resp = opener.open(r, timeout=20)
        return resp.status, dict(resp.headers), resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8", "replace")


def check(name, ok, detail=""):
    ok = bool(ok)
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))


def wait(url):
    for _ in range(40):
        try:
            if req("GET", url)[0] == 200:
                return True
        except Exception:
            time.sleep(2)
            continue
        time.sleep(2)
    return False


check("core health", wait(CORE + "/api/health"))
check("brand health", wait(BRAND + "/api/health"))

gclid = "SPIKE-" + uuid.uuid4().hex[:10]
q = urllib.parse.urlencode({"keyword": "fast cash loans", "gclid": gclid, "utm_source": "google"})

# 1. Landing with keyword + gclid
s, h, b = req("GET", f"{BRAND}/?{q}")
h1 = re.search(r"<h1>(.*?)</h1>", b, re.S)
check("landing 200", s == 200, str(s))
check("H1 keyword inserted", bool(h1) and "<span data-kw>Fast Cash Loans</span>" in h1.group(1), h1.group(1) if h1 else "no h1")
check("CTA carries gclid+keyword", f'name="gclid" value="{gclid}"' in b and 'name="keyword" value="fast cash loans"' in b)
cookie = (h.get("Set-Cookie") or h.get("set-cookie") or "").split(";")[0]
check("click cookie set", cookie.startswith("_vc="), cookie)

# 2. No keyword -> default text
s, _, b = req("GET", f"{BRAND}/")
check("H1 default without keyword", "<span data-kw>Funding Options</span>" in b)

# 3. XSS attempt is neutralised
s, _, b = req("GET", f"{BRAND}/?keyword=" + urllib.parse.quote("<script>alert(1)</script>"))
h1 = re.search(r"<h1>(.*?)</h1>", b, re.S)
check("keyword XSS stripped", bool(h1) and "<script" not in h1.group(1), h1.group(1) if h1 else "")

# 4. Flow gate
s, h, _ = req("GET", f"{BRAND}/request")
check("formRoute direct w/o params -> 302 /", s == 302 and h.get("Location", h.get("location", "")).startswith("/"), str(s))
s, h, _ = req("GET", f"{BRAND}/go?requested_amount=999&zip=90210&gclid={gclid}")
loc = h.get("Location", h.get("location", ""))
check("/go invalid amount -> 302 / keeps gclid", s == 302 and loc.startswith("/?") and gclid in loc, loc)
s, h, _ = req("GET", f"{BRAND}/go?" + urllib.parse.urlencode({"requested_amount": 3250, "zip": "90210", "keyword": "fast cash loans", "gclid": gclid}), headers={"cookie": cookie})
loc = h.get("Location", h.get("location", ""))
check("/go valid -> 302 formRoute", s == 302 and loc.startswith("/request?") and "keyword=" in loc and gclid in loc, loc)

# 5. Form page
s, _, b = req("GET", BRAND + loc, headers={"cookie": cookie})
check("form 200", s == 200, str(s))
check("form is AURUM SPA (root + /_f/ asset)", 'id="root"' in b and "/_f/assets/" in b)
asset = re.search(r'src="(/_f/assets/[^"]+\.js)"', b)
sa, _, _ = req("GET", BRAND + asset.group(1)) if asset else (0, None, None)
check("form JS asset 200", sa == 200, str(sa))
m = re.search(r'<script type="application/json" id="cfg">(.*?)</script>', b, re.S)
cfg = json.loads(m.group(1)) if m else {}
check("form cfg injected (amount, zip, keyword, brand)", cfg.get("amount") == 3250 and cfg.get("zip") == "90210" and cfg.get("keyword") == "Fast Cash Loans" and cfg.get("brand"), str(cfg))

# 6. UA parity (anti-cloaking): AdsBot gets identical HTML
_, _, b1 = req("GET", BRAND + loc, headers={"user-agent": "Mozilla/5.0"})
_, _, b2 = req("GET", BRAND + loc, headers={"user-agent": "AdsBot-Google (+http://www.google.com/adsbot.html)"})
check("same HTML for AdsBot and browser", b1 == b2)

# 7. Submit + idempotent replay
lead_id = str(uuid.uuid4())
lead = {"lead_id": lead_id, "requested_amount": 3250, "zip": "90210", "first_name": "Test", "last_name": "Spike",
        "email": "spike@example.com", "home_phone": "2145550123", "consent": True, "keyword": "Fast Cash Loans"}
s, _, b = req("POST", BRAND + "/api/leads", lead, {"cookie": cookie})
d = json.loads(b) if b.startswith("{") else {}
check("submit accepted", s == 200 and d.get("status") == "accepted" and d.get("redirect_url"), f"{s} {b[:120]}")
d["continuation"] = urllib.parse.parse_qs(urllib.parse.urlparse(d.get("redirect_url", "")).query).get("c", [""])[0]
s2, _, b2 = req("POST", BRAND + "/api/leads", lead, {"cookie": cookie})
d2 = json.loads(b2) if b2.startswith("{") else {}
check("replay same lead_id -> duplicate (no 2nd lead)", s2 == 200 and d2.get("status") == "duplicate", b2[:120])

v1_id = str(uuid.uuid4())
v1 = {"lead_id": v1_id, "session_id": "s", "form_version": "2026-01", "form_variant": "lite_v1",
      "site": {"site_id": "x", "brand": "ignored", "hostname": "ignored"},
      "lead": {"requested_amount": "3250", "first_name": "Real", "last_name": "Form", "email": "realform@example.com",
               "home_phone": "2145550199", "zip": "90210"},
      "consent": {"application_consent": True, "consent_version": "consent-2026-02"}, "tracking": {"keyword": "fast cash loans", "gclid": gclid}}
s3, _, b3 = req("POST", BRAND + "/api/leads", v1, {"cookie": cookie})
d3 = json.loads(b3) if b3.startswith("{") else {}
check("V1-shape submit -> redirect_url to provider", s3 == 200 and d3.get("status") == "accepted" and str(d3.get("redirect_url", "")).startswith("/request/provider?c="), b3[:160])

# 8. Provider hop -> prepop
s, h, _ = req("GET", f"{BRAND}/request/provider?c={d.get('continuation', '')}")
prepop = h.get("Location", h.get("location", ""))
check("provider -> prepop 302", s == 302 and prepop.startswith("https://example.com/prepop?") and lead_id.replace("-", "") in prepop and "requested_amount=3250" in prepop, prepop[:140])
s, h, _ = req("GET", f"{BRAND}/request/provider?c=bogus")
check("bogus continuation -> 302 /", s == 302 and h.get("Location", h.get("location", "")) == "/")

# 9. Postback (LeadsGate S2S) -> conversion queue
cid = lead_id.replace("-", "")
s, _, b = req("GET", f"{CORE}/api/postback?" + urllib.parse.urlencode({"token": "wrong", "cid": cid, "payout": 25, "type": "soldLead"}))
check("postback bad token -> 401", s == 401, str(s))
s, _, b = req("GET", f"{CORE}/api/postback?" + urllib.parse.urlencode({"token": PB_TOKEN, "cid": cid, "payout": 25, "lead_id": "LG-1", "type": "soldLead"}))
check("postback soldLead ok", s == 200 and '"ok"' in b, f"{s} {b}")

# 10. Drain pending/ack
s, _, b = req("GET", f"{CORE}/api/conversions/pending?limit=50", headers={"authorization": f"Bearer {DRAIN_TOKEN}"})
conv = [c for c in json.loads(b).get("conversions", []) if c.get("lead_id") == lead_id] if s == 200 else []
check("pending returns conversion w/ gclid+brand+hostname", len(conv) == 1 and conv[0].get("gclid") == gclid and conv[0].get("brand") == "spike-brand" and conv[0].get("hostname") and conv[0].get("value") == 25, b[:200])
s, _, b = req("POST", f"{CORE}/api/conversions/ack", {"results": [{"lead_id": lead_id, "status": "uploaded"}]}, {"authorization": f"Bearer {DRAIN_TOKEN}"})
check("ack uploaded", s == 200 and '"acked":1' in b.replace(" ", ""), b)
s, _, b = req("GET", f"{CORE}/api/conversions/pending?limit=50", headers={"authorization": f"Bearer {DRAIN_TOKEN}"})
check("pending empty after ack", s == 200 and lead_id not in b)

# 11. Brand domain exposes no back-office routes
for p in ["/admin", "/api/postback?token=x", "/api/conversions/pending", "/random-path"]:
    s, _, _ = req("GET", BRAND + p)
    check(f"brand {p} -> 404", s == 404, str(s))

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
