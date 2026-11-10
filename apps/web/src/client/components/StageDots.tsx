import { STAGE_LABELS, STAGE_STATUS_TEXT, type StageStatus } from "../brand-stages";

/** Seven dots, one per stage. The whole strip is one image with a Thai label that names every stage and its state. */
export function StageDots({ stages, unknown = [] }: { stages: StageStatus[]; unknown?: boolean[] }) {
  // A stage whose source did not answer is "ไม่ทราบ", so a pending dot never claims "not started" for something nobody could read.
  const text = (status: StageStatus, i: number) => (unknown[i] && status === "pending" ? "ไม่ทราบ" : STAGE_STATUS_TEXT[status]);
  const label = stages.map((status, i) => `${STAGE_LABELS[i]}: ${text(status, i)}`).join(", ");
  return (
    <span className="stage-dots" role="img" aria-label={label}>
      {stages.map((status, i) => (
        <span key={STAGE_LABELS[i]} className={`stage-dot stage-${status}`} title={`${STAGE_LABELS[i]} · ${text(status, i)}`} data-stage={STAGE_LABELS[i]} data-status={status} data-unknown={unknown[i] && status === "pending" ? "true" : undefined} />
      ))}
    </span>
  );
}
