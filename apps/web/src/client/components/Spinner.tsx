export function Spinner({ label = "กำลังโหลด…" }: { label?: string }) {
  return <div className="spinner" role="status"><span className="spinner-ring" aria-hidden="true" />{label}</div>;
}
