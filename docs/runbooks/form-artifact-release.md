# Release a new form to live brands

A tagged form release reaches a live brand in five owner steps. Nothing in CI writes to D1 or touches a brand.

Why a ZIP: the install Workflow reads the form as one ZIP at the `r2_key` of its `form_artifacts` row
(`readZipFromR2` in `workers/factory/src/render.ts`). The `lead-form` workflow also keeps loose files under
`form@<sha>/`, but the factory never reads those.

## Names a release gets

For a commit `a3e15df…` (40 characters), `<sha7>` is `a3e15df`:

| Field | Value |
|---|---|
| `form_artifact_id` | `form-<sha7>` |
| R2 key of the ZIP (`r2_key`) | `forms/form-<sha7>` (set by the register route from the id) |
| `bundle_form_version` | `form@<sha7>`, stored in core `brand_runtime.form_version` |
| `payload_version` | `formVersion` in `apps/lead-form/src/App.tsx` (`2026-01`), which core compares with the lead's `form_version` |
| `manifest_sha256` | SHA-256 of the ZIP |

## 1. Tag

Push a `v*` tag. The `lead-form` workflow builds, scans, runs browser acceptance, then the `upload` job
(environment `r2-artifacts`) writes `form@<sha>/…` and `forms/form-<sha7>`.

To add the ZIP for a tag released before this change, run the `lead-form` workflow by hand from that tag
(Run workflow, "Use workflow from" the tag). The loose files are skipped as already published and only the
ZIP is written. The job stops with an error if `forms/form-<sha7>` already holds different bytes.

## 2. Read the ZIP hash

Open the `upload` job. The step summary "Form artifact form-<sha7>" lists the R2 key, the ZIP SHA-256 and the
registration request body. The step "Pack the verified dist into the factory ZIP" prints the same hash.

The ZIP is deterministic: the same commit always gives the same bytes and hash.

## 3. Register it (Owner)

Register only after the `upload` job is green. A row whose ZIP is missing makes the install fail at the
`render` step with `R2 object not found`.

Get a sealed template version id (any sealed one; it is recorded in the audit entry only):

```js
// In the browser console on the panel, signed in as Owner.
(await (await fetch("/api/templates/sealed")).json()).templates
```

Send the request body from the step summary, with that id in `template_version_id`:

```js
await (await fetch("/api/form-artifacts", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    form_artifact_id: "form-<sha7>",
    template_version_id: "<sealed template version id>",
    git_sha: "<40-character commit sha>",
    bundle_form_version: "form@<sha7>",
    payload_version: "2026-01",
    manifest_sha256: "<ZIP SHA-256 from the step summary>",
  }),
})).json()
```

Answers: `201` with the registered row, `409` if the id or `git_sha` is already registered, `422` if a field is
invalid (`manifest_sha256` must be 64 hex characters, `payload_version` must be `2026-01`), `403` for an
Employee. Leave `manifest_sha256` out only if the hash is not at hand; the row then holds the placeholder
`registered`.

From this moment every new draft uses the new form (drafts take the newest compatible artifact).

## 4. Confirm

- The register call returned `201`.
- Open a live brand in the panel. The actions row shows "ติดตั้งใหม่พร้อมฟอร์มล่าสุด (Redeploy with latest form)"
  and the confirm text names `form@<sha7>`. The button is absent while the brand already runs this artifact.
- Optional, hash of the stored object: `npx wrangler r2 object get <artifacts bucket>/forms/form-<sha7> --remote --file form.zip`,
  then `sha256sum form.zip` equals the registered `manifest_sha256`.

## 5. Move a brand to the new form (Owner)

In the brand detail press "ติดตั้งใหม่พร้อมฟอร์มล่าสุด (Redeploy with latest form)" and confirm. The panel sends
`POST /api/brands/<id>/redeploy` with `{ "form_artifact_id": "form-<sha7>" }`. The install Workflow renders the
new ZIP, uploads the brand Worker, runs the smoke test and syncs core's `form_version` to `form@<sha7>`.

- A failed step rolls the brand back automatically to the previous revision and its previous form.
- After a success, "ย้อนกลับ (Rollback)" returns the brand to the previous revision, which carries the previous
  form artifact; core's `form_version` goes back with it.
- Do one brand first, check its form page and a test lead, then repeat per brand. There is no fan-out.

Check on the brand: open its form page with the browser Network tab. A request to `/_t/static/array.js`
(404 before this release) is gone, because the form now bundles its own analytics SDK.
