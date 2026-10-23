import { isPlainLeftClick, navigate } from "../router";

export function NotFound({ title, hint }: { title: string; hint?: string }) {
  return (
    <section className="panel">
      <h1>{title}</h1>
      {hint && <p className="hint">{hint}</p>}
      <a href="/" onClick={(e) => { if (!isPlainLeftClick(e)) return; e.preventDefault(); navigate("/"); }}>กลับหน้าแรก (Back to Home)</a>
    </section>
  );
}
