// Injected into every page before the panel's own scripts.
// 1. Blurs every element that can show PII or a secret (list from the panel map).
// 2. Draws a cursor dot, because headless recordings have no mouse pointer.
// 3. Draws a ring where the script clicks or points.
(() => {
  const MASK = __MASK_SELECTORS__;
  const css = `
${MASK.join(",\n")} { filter: blur(7px) !important; }
#tv-cursor { position: fixed; z-index: 2147483647; width: 22px; height: 22px; margin: -11px 0 0 -11px;
  border-radius: 50%; background: rgba(29,111,214,.35); border: 2px solid #1d6fd6; pointer-events: none;
  transition: transform .12s; left: -40px; top: -40px; }
#tv-cursor.down { transform: scale(.7); }
.tv-ring { position: fixed; z-index: 2147483646; width: 64px; height: 64px; margin: -32px 0 0 -32px;
  border-radius: 50%; border: 4px solid #f2a33a; pointer-events: none; animation: tv-ring 1.1s ease-out forwards; }
@keyframes tv-ring { from { transform: scale(.4); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }
html { scroll-behavior: smooth; }
`;
  const install = () => {
    if (document.getElementById("tv-style")) return;
    const style = document.createElement("style");
    style.id = "tv-style";
    style.textContent = css;
    document.documentElement.appendChild(style);
    const cursor = document.createElement("div");
    cursor.id = "tv-cursor";
    document.documentElement.appendChild(cursor);
    addEventListener("mousemove", (e) => { cursor.style.left = e.clientX + "px"; cursor.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", (e) => { cursor.classList.add("down"); window.__tvRing(e.clientX, e.clientY); }, true);
    addEventListener("mouseup", () => cursor.classList.remove("down"), true);
  };
  window.__tvRing = (x, y) => {
    const ring = document.createElement("div");
    ring.className = "tv-ring";
    ring.style.left = x + "px";
    ring.style.top = y + "px";
    document.documentElement.appendChild(ring);
    setTimeout(() => ring.remove(), 1200);
  };
  if (document.documentElement) install();
  document.addEventListener("DOMContentLoaded", install);
})();
