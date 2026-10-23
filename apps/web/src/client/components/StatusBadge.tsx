export type Tone = "live" | "warn" | "bad" | "mute" | "blue";
const icon: Record<Tone, string> = { live: "●", warn: "▲", bad: "✕", mute: "○", blue: "◆" };

export function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  return <span className={`pill p-${tone} status-badge`}><span aria-hidden="true">{icon[tone]}</span>{label}</span>;
}
