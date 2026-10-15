import { BUYER_FIELDS } from "@anjuna/contracts";

/**
 * V1 apply.html, with the C-02 allowlist derived from the shared buyer contract.
 * Public BrandSettings/RuntimeConfig do not expose aid. Core buildUserRedirect sets
 * the URL aid from trusted brand_runtime.aid; accept digits only here. This is
 * format validation, not authentication: another numeric URL aid is still accepted.
 * URL values are read only in the browser, never interpolated into these HTML bytes.
 */
export const APPLY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <meta name="referrer" content="no-referrer" />
  <!-- apikeep.com serves classic (no-CORS) scripts, so its preconnect has no crossorigin; moneyfor.com is called with CORS fetches. -->
  <link rel="preconnect" href="https://apikeep.com">
  <link rel="dns-prefetch" href="https://apikeep.com">
  <link rel="preconnect" href="https://moneyfor.com" crossorigin>
  <title>Complete Your Application</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f5f5; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    #_lg_form_ { min-height: 100vh; }
    /* Neutral loading state, visible until the form renders or the fallback fires. */
    #_lg_loading_ { text-align: center; padding: 60px 24px; color: #52525b; font-size: 15px; }
    #_lg_loading_ .lg-spin { width: 32px; height: 32px; margin: 0 auto 16px; border: 3px solid #d4d4d8; border-top-color: #059669; border-radius: 50%; animation: lg-spin 0.9s linear infinite; }
    @keyframes lg-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { #_lg_loading_ .lg-spin { animation-duration: 3s; } }
    /* P0-B: fallback shown only if the LeadsGate script never loads or renders nothing. */
    #_lg_fallback_ { display: none; text-align: center; padding: 60px 24px; max-width: 480px; margin: 0 auto; }
    #_lg_fallback_ h2 { font-size: 20px; color: #18181b; margin: 0 0 12px; }
    #_lg_fallback_ p { font-size: 15px; color: #52525b; line-height: 1.6; margin: 0 0 20px; }
    #_lg_fallback_ a { display: inline-block; padding: 12px 28px; background: #059669; color: #fff; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; }
    #_lg_fallback_ a:hover { background: #047857; }
  </style>
</head>
<body>
  <div id="_lg_form_">
    <div id="_lg_loading_" role="status" aria-live="polite">
      <div class="lg-spin" aria-hidden="true"></div>
      <div>Loading your application form…</div>
    </div>
    <!-- P0-B: Fallback content shown if the LeadsGate script fails to load or render. -->
    <div id="_lg_fallback_">
      <h2>We could not load the form</h2>
      <p>Your application details have been securely saved.
      Please click the button below to retry.</p>
      <a id="_lg_retry_" href="#">Retry Application</a>
    </div>
  </div>

  <script>
    var params = Object.fromEntries(new URLSearchParams(window.location.search));
    var p = {};
    ${JSON.stringify([...BUYER_FIELDS, "lead_id", "ref", "click_id", "clickid"])}.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(params, key)) p[key] = params[key];
    });
    var aid = params.aid || "";
    var _lg_form_init_ = Object.assign({}, p, {
      aid: aid && !/[^0-9]/.test(aid) ? aid : "",
      template: "fresh",
      click_id: p.click_id || p.clickid || "",
      ref: p.ref || p.lead_id || "",
    });

    // P0-B: Preserve all original query parameters on retry. The retry link reloads
    // the same URL (including lead_id, ref, and all prepop fields) so the LeadsGate
    // form can still be pre-filled on the second attempt.
    (function () {
      var retry = document.getElementById("_lg_retry_");
      if (retry) retry.setAttribute("href", window.location.pathname + window.location.search);
    })();

    // P0-B: Detect script load failure via onerror (fires before the timeout below).
    // Detect "loaded but rendered nothing" via a timeout: if no form/iframe/canvas
    // appears inside #_lg_form_ within 20 seconds (applicationForm.js took 10 to 16 s in production tests), show the fallback.
    (function () {
      var fallback = document.getElementById("_lg_fallback_");
      var loading = document.getElementById("_lg_loading_");
      var shown = false;
      function hideLoading() {
        if (loading) loading.style.display = "none";
      }
      function showFallback() {
        if (shown) return;
        shown = true;
        hideLoading();
        if (fallback) fallback.style.display = "block";
      }
      // Expose for the script onerror handler below.
      window._lg_showFallback = showFallback;
      // Timeout: check whether LeadsGate rendered anything real.
      setTimeout(function () {
        var container = document.getElementById("_lg_form_");
        if (!container) return;
        // Look for any element LeadsGate typically injects: form, iframe, canvas, or a div
        // with a class containing "lg" or "leadsgate". The fallback div itself doesn't count.
        var hasRealContent = container.querySelector("form, iframe, canvas, input, select");
        if (hasRealContent) hideLoading();
        else showFallback();
      }, 20000);
      // Hide the spinner as soon as LeadsGate injects real content.
      var container0 = document.getElementById("_lg_form_");
      if (container0 && typeof MutationObserver === "function") {
        new MutationObserver(function () {
          if (container0.querySelector("form, iframe, canvas, input, select")) hideLoading();
        }).observe(container0, { childList: true, subtree: true });
      }
    })();
  </script>
  <script type="text/javascript" src="https://apikeep.com/form/applicationInit.js"
    onerror="if (window._lg_showFallback) window._lg_showFallback();"></script>
</body>
</html>
`;
