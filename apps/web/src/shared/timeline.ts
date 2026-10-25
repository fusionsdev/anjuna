/**
 * Shapes of the brand timeline routes (src/server/timeline.ts) shared with the SPA. Panel-only: not a core admin contract.
 */
import { BrandId, DeployEvent, DeployUnavailableSource, FormVersion } from "@anjuna/contracts";
import { z } from "zod";

// contracts does not export these three base schemas; reuse the ones DeployEvent is built from.
const Id = DeployEvent.shape.event_id;
const ActorId = DeployEvent.shape.started_by;
const Timestamp = DeployEvent.shape.started_at;

export const ADS_EVENT_TYPES = ["ad_disapproved", "account_suspended", "account_reinstated", "policy_warning", "bot_visit_observed", "other"] as const;
export const AdsEventType = z.enum(ADS_EVENT_TYPES);
export type AdsEventType = z.infer<typeof AdsEventType>;

export const CHANGE_CATEGORIES = ["config", "pause_resume", "deploy", "factory_edit"] as const;
export const ChangeCategory = z.enum(CHANGE_CATEGORIES);
export type ChangeCategory = z.infer<typeof ChangeCategory>;

/** A filter id: a change category or an Ads event type. The two sets share no id. */
export const TimelineType = z.union([ChangeCategory, AdsEventType]);
export type TimelineType = z.infer<typeof TimelineType>;

/** A manually entered Ads account event (table `ads_account_events`). */
export const AdsAccountEvent = z.strictObject({
  event_id: Id,
  brand_id: BrandId,
  type: AdsEventType,
  occurred_at: Timestamp,
  note: z.string().max(500),
  created_by: ActorId,
  created_role: z.enum(["owner", "employee"]),
  created_at: Timestamp,
});
export type AdsAccountEvent = z.infer<typeof AdsAccountEvent>;

/** The revision an install row moved from or to, with the template and form version it carried. */
export const RevisionRef = z.strictObject({
  revision: z.number().int().positive(),
  template_version_id: Id,
  bundle_form_version: FormVersion.nullable(),
});
export type RevisionRef = z.infer<typeof RevisionRef>;

export const TimelineItem = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("change"),
    item_id: z.string(),
    at: Timestamp,
    category: ChangeCategory,
    change: DeployEvent,
    from_revision: RevisionRef.nullable(),
    to_revision: RevisionRef.nullable(),
  }),
  z.strictObject({
    kind: z.literal("ads_event"),
    item_id: z.string(),
    at: Timestamp,
    event: AdsAccountEvent,
  }),
]);
export type TimelineItem = z.infer<typeof TimelineItem>;

export const TimelineResponse = z.strictObject({
  brand_id: BrandId,
  items: z.array(TimelineItem),
  has_more: z.boolean(),
  unavailable: z.array(DeployUnavailableSource),
  actor_scope: z.enum(["all", "own"]),
});
export type TimelineResponse = z.infer<typeof TimelineResponse>;

/** Body of POST /api/brands/:id/ads-events. The 500-character note limit is checked after trim in the route. */
export const CreateAdsEventRequest = z.strictObject({
  type: AdsEventType,
  occurred_at: Timestamp,
  note: z.string().max(2000),
});
export type CreateAdsEventRequest = z.infer<typeof CreateAdsEventRequest>;

/** Query of GET /api/brands/:id/timeline. `types` is a comma list; empty or absent means every type. */
export const TimelineQuery = z
  .strictObject({
    from: Timestamp.optional(),
    to: Timestamp.optional(),
    types: z
      .string()
      .transform((raw, ctx): TimelineType[] | undefined => {
        if (raw === "") return undefined;
        const out: TimelineType[] = [];
        for (const id of raw.split(",")) {
          const parsed = TimelineType.safeParse(id);
          if (!parsed.success) {
            ctx.issues.push({ code: "custom", message: `Unknown timeline type: ${id}`, input: raw });
            return z.NEVER;
          }
          if (!out.includes(parsed.data)) out.push(parsed.data);
        }
        return out;
      })
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .superRefine((q, ctx) => {
    if (q.from !== undefined && q.to !== undefined && Date.parse(q.from) > Date.parse(q.to)) {
      ctx.addIssue({ code: "custom", path: ["from"], message: "from must not be after to" });
    }
  });
export type TimelineQuery = z.infer<typeof TimelineQuery>;

/** Spec D5 table: every install row is a deploy; core brand.update is config; pause and resume share a category; any other audit action is a factory edit. */
export function changeCategory(event: DeployEvent): ChangeCategory {
  if (event.source === "install") return "deploy";
  if (event.action === "brand.update") return "config";
  if (event.action === "brand.pause" || event.action === "brand.resume") return "pause_resume";
  return "factory_edit";
}
