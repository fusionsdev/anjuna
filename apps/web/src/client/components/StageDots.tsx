import { STAGE_LABELS, STAGE_STATUS_TEXT, type StageStatus } from "../brand-stages";

/** Seven dots, one per stage. The whole strip is one image with a Thai label that names every stage and its state. */
export function StageDots({ stages }: { stages: StageStatus[] }) {
  const label = stages.map((status, i) => `${STAGE_LABELS[i]}: ${STAGE_STATUS_TEXT[status]}`).join(", ");
  return (
    <span className="stage-dots" role="img" aria-label={label}>
      {stages.map((status, i) => (
        <span key={STAGE_LABELS[i]} className={`stage-dot stage-${status}`} title={`${STAGE_LABELS[i]} · ${STAGE_STATUS_TEXT[status]}`} data-stage={STAGE_LABELS[i]} data-status={status} />
      ))}
    </span>
  );
}
