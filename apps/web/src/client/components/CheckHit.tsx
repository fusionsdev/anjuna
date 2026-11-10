import type { InputHTMLAttributes } from "react";

/**
 * A checkbox inside a label that is at least 44 by 44 px, so a finger or a pointer has a real target while the box itself stays small.
 * Clicking anywhere on the label toggles the box. The accessible name stays on the input (pass `aria-label`).
 */
export function CheckHit(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <label className="check-hit">
      <input type="checkbox" {...props} />
    </label>
  );
}
