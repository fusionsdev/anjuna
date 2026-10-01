"""Drive the real AURUM form like a user (headless Chromium) on the deployed brand domain.

Usage: python ui_e2e.py <brand_base>
Stops at the prepop redirect (fake LeadsGate URL) and prints each step.
"""
import sys
import uuid
from playwright.sync_api import sync_playwright

BASE = sys.argv[1]
gclid = "UI-" + uuid.uuid4().hex[:8]

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge")
    page = browser.new_page()
    prepop = {}
    page.on("request", lambda r: prepop.setdefault("url", r.url) if "example.com/prepop" in r.url else None)
    page.on("response", lambda r: print("  [resp]", r.status, r.url.split("?")[0], (r.text()[:200] if "/api/leads" in r.url else "")) if ("/api/" in r.url or "/provider" in r.url) else None)

    page.goto(f"{BASE}/?keyword=bear%20cash%20loans&gclid={gclid}")
    print("1 landing H1:", page.inner_text("h1"))
    page.select_option("select[name=requested_amount]", "3250")
    page.fill("input[name=zip]", "90210")
    page.click("button[type=submit]")
    page.wait_for_url("**/request?**")
    print("2 form url:", page.url.split("?")[0], "| header:", page.inner_text("header h1"))

    page.click("button[type=submit]")                       # Step 1 -> 2 (amount + ZIP prefilled)
    page.wait_for_selector("text=Contact Details")
    print("3 step:", page.inner_text("h2"))
    page.locator("input").nth(0).fill("Test")
    page.locator("input").nth(1).fill("Spike")
    page.locator("input[type=tel], input[inputmode=tel], input[inputmode=numeric]").first.fill("2145550123")
    page.locator("input[type=email]").fill("ui-spike@example.com")
    page.click("button[type=submit]")                       # Step 2 -> 3
    page.wait_for_selector("text=Review & Agreement")
    print("4 step:", page.inner_text("h2"))
    for cb in page.locator("input[type=checkbox]").all():
        if not cb.is_checked():
            cb.check()
    try:
        # Final submit is a type="button" gated on the consent checkbox; click the last enabled one.
        page.locator("main button[type=button]:enabled").last.click()
        page.wait_for_url("https://example.com/**", timeout=20000)
    except Exception as e:
        print("submit wait:", type(e).__name__)
        print("  page text:", " | ".join(page.inner_text("main")[:400].splitlines()))
    url = page.url if "example.com" in page.url else prepop.get("url", "")
    print("5 landed on:", url.split("?")[0])
    q = url.split("?", 1)[1] if "?" in url else ""
    print("  prepop has amount/name/click_id:", "requested_amount=3250" in q, "first_name=Test" in q, "click_id=" in q)
    browser.close()
