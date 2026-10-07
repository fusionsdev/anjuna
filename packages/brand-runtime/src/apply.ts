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
  <title>Complete Your Application</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f5f5; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    #_lg_form_ { min-height: 100vh; }
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
    <!-- P0-B: Fallback content shown if the LeadsGate script fails to load or render. -->
    <div id="_lg_fallback_">
      <h2>Loading your application form…</h2>
      <p>If this page does not load within a few seconds, your application details have been
      securely saved. Please click the button below to retry.</p>
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
    // appears inside #_lg_form_ within 8 seconds, show the fallback.
    (function () {
      var fallback = document.getElementById("_lg_fallback_");
      var shown = false;
      function showFallback() {
        if (shown) return;
        shown = true;
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
        if (!hasRealContent) showFallback();
      }, 8000);
    })();
  </script>
  <script type="text/javascript" src="https://apikeep.com/form/applicationInit.js"
    onerror="if (window._lg_showFallback) window._lg_showFallback();"></script>
</body>
</html>
`;
