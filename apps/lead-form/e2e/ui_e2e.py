"""Spike UI smoke test adapted for a local brand Worker. Never contacts a buyer.

python e2e/ui_e2e.py http://127.0.0.1:8799 --runs 8 --channel msedge
"""
import argparse
import sys
import uuid
from urllib.parse import parse_qs, urlsplit

from playwright.sync_api import expect, sync_playwright


def submit_review(page):
    # The sticky step label can change while AnimatePresence still shows Contact
    # Details. Wait for the actual main screen, then consent and the named action.
    main = page.get_by_role("main")
    expect(main.get_by_role("heading", name="Review & Agreement", exact=True)).to_be_visible()
    consent = main.get_by_role("checkbox")
    expect(consent).to_be_visible()
    consent.check()
    expect(consent).to_be_checked()
    submit = main.get_by_role("button", name="Submit Secure Inquiry", exact=True)
    expect(submit).to_be_enabled()
    submit.click()


def run(browser, base, number, cpu_rate):
    context = browser.new_context(service_workers="block")
    unexpected = []
    observed = {}

    def route_request(route):
        url = urlsplit(route.request.url)
        if (url.scheme, url.netloc) != (urlsplit(base).scheme, urlsplit(base).netloc):
            unexpected.append(route.request.url)
            route.abort()
        elif url.path == "/request/provider":
            # Routing only intercepts the first request in a redirect chain.
            # Read the real Worker redirect without following it, then replace it.
            response = route.fetch(max_redirects=0)
            observed["provider_status"] = response.status
            observed["prepop"] = response.headers.get("location", "")
            route.fulfill(status=200, content_type="text/html", body="Local buyer stand-in")
        elif url.path == "/api/leads":
            response = route.fetch(max_redirects=0)
            observed["lead_status"] = response.status
            observed["lead"] = response.json()
            route.fulfill(response=response)
        else:
            route.continue_()

    context.route("**/*", route_request)
    page = context.new_page()
    main = page.get_by_role("main")
    if cpu_rate != 1:
        context.new_cdp_session(page).send("Emulation.setCPUThrottlingRate", {"rate": cpu_rate})
    try:
        gclid = "UI-" + uuid.uuid4().hex[:8]
        page.goto(f"{base}/?keyword=bear%20cash%20loans&gclid={gclid}")
        # The ad keyword is recorded, never shown: the landing H1 holds the brand name.
        expect(page.locator("h1")).to_have_text("Example Brand")
        expect(page.locator("body")).not_to_contain_text("Bear Cash Loans")
        page.select_option("select[name=requested_amount]", "3250")
        page.fill("input[name=zip]", "90210")
        page.get_by_role("button", name="Continue", exact=True).click()
        page.wait_for_url("**/request?**")
        # The local brand has no keyword_default, so the form header is the brand name.
        expect(page.locator("header h1")).to_have_text("Example Brand")
        expect(page.locator("body")).not_to_contain_text("Bear Cash Loans")
        expect(page.get_by_placeholder("e.g. 10001", exact=True)).to_have_value("90210")
        page.locator("button[type=submit]").click()

        expect(main.get_by_role("heading", name="Contact Details", exact=True)).to_be_visible()
        page.get_by_placeholder("e.g. John", exact=True).fill("Test")
        page.get_by_placeholder("e.g. Smith", exact=True).fill("Spike")
        page.get_by_placeholder("e.g. 555-123-4567", exact=True).fill("2145550123")
        page.get_by_placeholder("example@domain.com", exact=True).fill("ui-spike@example.com")
        page.locator("button[type=submit]").click()

        submit_review(page)
        page.wait_for_url("**/request/provider?c=**")
        expect(page.locator("body")).to_have_text("Local buyer stand-in")
        assert observed["lead_status"] == 201, observed
        payload = observed["lead"]
        assert payload["status"] == "accepted", payload
        assert payload["redirect_url"].startswith("/request/provider?c="), payload
        assert observed["provider_status"] == 302, observed
        prepop = urlsplit(observed["prepop"])
        assert (prepop.scheme, prepop.netloc, prepop.path) == ("https", "example.com", "/prepop"), prepop
        query = parse_qs(prepop.query)
        assert query.get("requested_amount") == ["3250"], query
        assert query.get("first_name") == ["Test"], query
        assert query.get("click_id", [""])[0], query
        assert not unexpected, f"Unexpected external requests: {unexpected}"
        print(f"PASS {number}: landing -> 3 steps -> lead accepted -> provider -> prepop", flush=True)
    except Exception:
        print(f"FAIL {number}: {page.url}\n{page.locator('body').inner_text()[:1200]}", flush=True)
        raise
    finally:
        context.close()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base")
    parser.add_argument("--runs", type=int, default=8)
    parser.add_argument("--channel", default=None, help="e.g. msedge; default is Playwright Chromium")
    parser.add_argument("--cpu-rate", type=float, default=1)
    args = parser.parse_args()
    base = args.base.rstrip("/")
    url = urlsplit(base)
    if (url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost", "::1")
            or url.username or url.password or url.path or url.query or url.fragment):
        parser.error("base must be a loopback HTTP origin")
    if args.runs < 1 or args.cpu_rate < 1:
        parser.error("runs and cpu-rate must be at least 1")
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=args.channel)
        try:
            for number in range(1, args.runs + 1):
                run(browser, base, number, args.cpu_rate)
        finally:
            browser.close()
    print(f"PASS: {args.runs}/{args.runs} runs", flush=True)


if __name__ == "__main__":
    main()
