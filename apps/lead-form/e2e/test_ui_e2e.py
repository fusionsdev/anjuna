"""Deterministic regression for the spike's sticky-label/consent race.

Run: python -m unittest discover -s e2e -p "test_*.py"
Optional: E2E_BROWSER_CHANNEL=msedge to use installed Edge.
"""
import os
import unittest

from playwright.sync_api import expect, sync_playwright

from ui_e2e import submit_review


class ReviewTransitionTest(unittest.TestCase):
    def test_submit_waits_for_consent_screen_and_never_goes_back(self):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=os.getenv("E2E_BROWSER_CHANNEL"))
            try:
                page = browser.new_page()
                # No server or network. Freeze the exact outgoing-screen state
                # until the old selectors have demonstrated the wrong target.
                page.set_content("""
                    <aside>Review &amp; Agreement</aside>
                    <main><h2>Contact Details</h2>
                      <button type="button" onclick="window.wentBack = true">
                        Previous Section
                      </button>
                    </main>
                    <script>
                      window.wentBack = false;
                      window.submitted = false;
                      window.showReview = () => {
                        document.querySelector('main').innerHTML = `
                          <h2>Review &amp; Agreement</h2>
                          <input type="checkbox" aria-label="Consent"
                            onchange="document.querySelector('#submit').disabled = !this.checked">
                          <button type="button" onclick="window.wentBack = true">Previous Section</button>
                          <button id="submit" type="button" disabled
                            onclick="window.submitted = true">Submit Secure Inquiry</button>`;
                      };
                    </script>
                """)
                page.wait_for_selector("text=Review & Agreement")
                self.assertEqual(page.locator("input[type=checkbox]").all(), [])
                expect(page.locator("main button[type=button]:enabled").last).to_have_text("Previous Section")

                # Simulate the delayed animation mount. The helper must wait for
                # DOM readiness; it has no sleep or retry of the whole scenario.
                page.evaluate("setTimeout(window.showReview, 300)")
                submit_review(page)
                self.assertTrue(page.evaluate("window.submitted"))
                self.assertFalse(page.evaluate("window.wentBack"))
                expect(page.get_by_role("checkbox")).to_be_checked()
            finally:
                browser.close()


if __name__ == "__main__":
    unittest.main()
