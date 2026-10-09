import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApplyRuntimeRequest,
  ApplyRuntimeResponse,
  RuntimeStateResponse,
  type FormLeadPayload,
} from "@anjuna/contracts";
import { createHarness, fixtureText, hash, type Harness } from "./helpers.js";

const token = "account-a-token";
const initialRuntime = {
  drain_key: "brand-a", aid: "10001", prepop_base: "https://prepop.example/apply",
  amount_buckets: [750, 1750], form_route: "/request",
  keyword_default: "Fast Cash Loans", form_version: "form@8ba11d3",
};
const artifacts = [
  { id: "form-original", sha: "8ba11d3", bundle: "form@8ba11d3" },
  { id: "form-upgraded", sha: "abcdef1", bundle: "form@abcdef1" },
] as const;

function jsonBody(value: unknown) {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

let h: Harness;
beforeAll(async () => {
  // Both production core and the brand Worker reject outbound network requests in this harness.
  h = await createHarness({ brand: true });
  await h.seedAccount("account-a", token);
  await h.factory.prepare(`INSERT INTO brands
    (brand_id, name, account, domain, status, created_by, created_at, updated_at)
    VALUES ('brand-a', 'Brand A', 'account-a', 'brand-a.example', 'draft',
      'usr_owner_01', '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z')`).run();
  // Register local artifact metadata explicitly: a bundle identity is not a payload version.
  for (const artifact of artifacts) {
    await h.factory.prepare(`INSERT INTO form_artifacts
      (form_artifact_id, git_sha, r2_key, manifest_sha256, created_at, payload_version, bundle_form_version)
      VALUES (?1, ?2, ?3, ?4, '2026-10-06T00:00:00.000Z', '2026-01', ?5)`)
      .bind(artifact.id, artifact.sha, `forms/${artifact.id}`, hash(artifact.id), artifact.bundle).run();
  }
  await h.db.prepare("INSERT OR IGNORE INTO zip_lookup VALUES ('60601', 'Chicago', 'IL')").run();
});
afterAll(async () => { await h?.mf.dispose(); });

describe("lifecycle fake-submit acceptance with local production core", () => {
  it("persists accepted leads after provision, during new-form/old-core, after upgrade, rollback and detach/reinstall", async () => {
    const brand = await h.mf.getWorker("brand");
    const stages = [
      { name: "first provision", artifact: artifacts[0], revision: "revision-1", previous: null, apply: true },
      { name: "new-form/old-core interval", artifact: artifacts[1], revision: "revision-1", previous: "revision-1", apply: false },
      { name: "upgrade apply", artifact: artifacts[1], revision: "revision-2", previous: "revision-1", apply: true },
      { name: "rollback apply", artifact: artifacts[0], revision: "revision-1", previous: "revision-2", apply: true },
      { name: "reinstall after lifecycle detach", artifact: artifacts[0], revision: "revision-1", previous: null, apply: true },
    ];
    expect(await h.db.prepare("SELECT brand_id FROM brand_runtime").first()).toBeNull();

    for (const [index, stage] of stages.entries()) {
      if (index === 4) {
        const detach = await h.factoryLifecycle("/runtime", token, jsonBody({
          install_id: "install-submit-detach", brand_id: "brand-a", account: "account-a",
          hostnames: ["brand-a.example", "www.brand-a.example"], expected_revision_id: "revision-1",
          target_revision_id: null, actor_id: "usr_owner_01", actor_role: "owner",
        }));
        expect(await detach.json()).toMatchObject({ state: "detached", paused: true });
        expect((await brand.fetch("https://brand-a.example/")).status).toBe(503);
      }
      const artifact = await h.factory.prepare(`SELECT payload_version, bundle_form_version
        FROM form_artifacts WHERE form_artifact_id = ?1`).bind(stage.artifact.id)
        .first<{ payload_version: string; bundle_form_version: string }>();
      expect(artifact, stage.name).toEqual({ payload_version: "2026-01", bundle_form_version: stage.artifact.bundle });

      if (stage.apply) {
        const request = ApplyRuntimeRequest.parse({
          install_id: `install-submit-${index}`, brand_id: "brand-a", account: "account-a",
          hostnames: ["brand-a.example", "www.brand-a.example"],
          expected_revision_id: stage.previous, target_revision_id: stage.revision,
          actor_id: "usr_owner_01", actor_role: "owner",
          ...(stage.previous === null ? { initial_runtime: initialRuntime } : { bundle_form_version: artifact!.bundle_form_version }),
        });
        const response = await h.factoryLifecycle("/runtime", token, jsonBody(request));
        expect(response.status, stage.name).toBe(200);
        expect(ApplyRuntimeResponse.parse(await response.json()), stage.name).toEqual({
          state: "applied", install_id: request.install_id, applied_revision_id: stage.revision, paused: false,
        });
      }

      const stateResponse = await h.factoryLifecycle("/runtime-state", token, jsonBody({ brand_id: "brand-a", account: "account-a" }));
      expect(stateResponse.status, stage.name).toBe(200);
      const state = RuntimeStateResponse.parse(await stateResponse.json());
      expect(state, stage.name).toMatchObject({
        state: "applied", applied_revision_id: stage.revision, paused: false,
        bundle_form_version: index === 1 ? artifacts[0].bundle : artifact!.bundle_form_version,
        last_lifecycle_install_id: `install-submit-${index === 1 ? 0 : index}`,
      });
      if (index === 1) {
        // Simulate the newly deployed form's compatible payload before applying its core revision.
        expect(state.state === "applied" && state.bundle_form_version).not.toBe(artifact!.bundle_form_version);
      }

      const payload = JSON.parse(fixtureText("form/lead.lite_v1.json")) as FormLeadPayload;
      payload.lead_id = randomUUID();
      payload.session_id = randomUUID();
      payload.site = { site_id: "form-default", brand: "Brand A", hostname: "brand-a.example" };
      payload.lead.email = `lifecycle-${payload.lead_id}@example.com`;
      payload.lead.home_phone = `312555010${index}`;
      payload.consent.page_url = "https://brand-a.example/request";
      payload.consent.accepted_at = new Date().toISOString();
      payload.metadata.hostname = "brand-a.example";
      payload.metadata.landing_page_url = "https://brand-a.example/request";
      payload.metadata.submitted_at = payload.consent.accepted_at;
      // Keep the real fixture's protocol value, independently checking registered metadata.
      expect(payload.form_version, stage.name).toBe(artifact!.payload_version);
      expect(payload.form_version, stage.name).not.toBe(artifact!.bundle_form_version);

      const response = await brand.fetch("https://brand-a.example/api/leads", jsonBody(payload));
      const accepted = await response.json() as { status: string; lead_id: string; redirect_url: string };
      expect([response.status, accepted.status], stage.name).toEqual([201, "accepted"]);
      expect(accepted.lead_id, stage.name).toBe(payload.lead_id);
      expect(accepted.redirect_url, stage.name).toMatch(/^\/request\/provider\?c=/);
      expect(await h.db.prepare(`SELECT lead_id, session_id, brand, hostname, status, form_version, email, home_phone
        FROM leads WHERE lead_id = ?1`).bind(payload.lead_id).first(), stage.name).toEqual({
        lead_id: payload.lead_id, session_id: payload.session_id, brand: "brand-a", hostname: "brand-a.example",
        status: "accepted", form_version: "2026-01", email: payload.lead.email, home_phone: payload.lead.home_phone,
      });
      expect(await h.db.prepare("SELECT form_version, hostname FROM consent_evidence WHERE lead_id = ?1")
        .bind(payload.lead_id).first(), stage.name).toEqual({ form_version: "2026-01", hostname: "brand-a.example" });
      expect(await h.db.prepare("SELECT brand, status FROM mailing_outbox WHERE lead_id = ?1")
        .bind(payload.lead_id).first(), stage.name).toEqual({ brand: "brand-a", status: "pending" });
      const continuation = new URL(accepted.redirect_url, "https://brand-a.example").searchParams.get("c")!;
      expect(await h.db.prepare("SELECT lead_id, brand_id, used_at FROM continuations WHERE token_hash = ?1")
        .bind(hash(continuation)).first(), stage.name).toEqual({ lead_id: payload.lead_id, brand_id: "brand-a", used_at: null });

      // A bundle ID must never replace the wire protocol version, even after runtime sync.
      const invalidId = randomUUID();
      const invalid = await brand.fetch("https://brand-a.example/api/leads", jsonBody({
        ...payload, lead_id: invalidId, session_id: randomUUID(), form_version: artifact!.bundle_form_version,
        lead: { ...payload.lead, email: `invalid-${invalidId}@example.com`, home_phone: `312555011${index}` },
      }));
      expect([invalid.status, await invalid.json()], stage.name).toEqual([
        400, { status: "invalid", message: "Unsupported form version" },
      ]);
      expect(await h.db.prepare("SELECT lead_id FROM leads WHERE lead_id = ?1").bind(invalidId).first(), stage.name).toBeNull();
      expect(await h.db.prepare("SELECT COUNT(*) AS n FROM leads").first(), stage.name).toEqual({ n: index + 1 });
    }
  });
});
