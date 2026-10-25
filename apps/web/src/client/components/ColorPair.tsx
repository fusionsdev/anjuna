/** Two brand color rows (FUS-381): each row keeps a color swatch and a hex field in sync. Null means the template's own colors. */
import { useEffect, useState } from "react";
import { BrandTheme, HexColor } from "@anjuna/contracts";

const DEFAULT_PRIMARY = "#2563eb";
const DEFAULT_SECONDARY = "#1e293b";
const HEX_ERROR = "ใช้รูปแบบ #rrggbb (Use a #rrggbb hex color)";

export function ColorPair(props: { value: BrandTheme | null; onChange(next: BrandTheme | null): void; disabled?: boolean }) {
  const { value, onChange, disabled = false } = props;
  const shownPrimary = value?.primary ?? DEFAULT_PRIMARY;
  const shownSecondary = value?.secondary ?? DEFAULT_SECONDARY;

  // The text fields hold what the employee typed (possibly invalid); the swatch always shows the last valid value.
  const [primaryText, setPrimaryText] = useState(shownPrimary);
  const [secondaryText, setSecondaryText] = useState(shownSecondary);
  const [primaryError, setPrimaryError] = useState<string | null>(null);
  const [secondaryError, setSecondaryError] = useState<string | null>(null);

  // A change from outside (Settings load, template reset) replaces what is shown.
  useEffect(() => {
    setPrimaryText(shownPrimary);
    setPrimaryError(null);
  }, [shownPrimary]);
  useEffect(() => {
    setSecondaryText(shownSecondary);
    setSecondaryError(null);
  }, [shownSecondary]);

  const primaryParsed = HexColor.safeParse(primaryText);
  const secondaryParsed = HexColor.safeParse(secondaryText);

  const onPrimaryText = (raw: string) => {
    setPrimaryText(raw);
    const parsed = HexColor.safeParse(raw);
    if (parsed.success) {
      setPrimaryError(null);
      onChange({ primary: parsed.data, secondary: shownSecondary });
    } else {
      setPrimaryError(HEX_ERROR);
    }
  };

  const onSecondaryText = (raw: string) => {
    setSecondaryText(raw);
    const parsed = HexColor.safeParse(raw);
    if (parsed.success) {
      setSecondaryError(null);
      onChange({ primary: shownPrimary, secondary: parsed.data });
    } else {
      setSecondaryError(HEX_ERROR);
    }
  };

  const onPrimaryColor = (raw: string) => {
    const next = raw.toLowerCase();
    setPrimaryText(next);
    setPrimaryError(null);
    onChange({ primary: next, secondary: shownSecondary });
  };

  const onSecondaryColor = (raw: string) => {
    const next = raw.toLowerCase();
    setSecondaryText(next);
    setSecondaryError(null);
    onChange({ primary: shownPrimary, secondary: next });
  };

  // Leaving a field with invalid text puts the last valid color back, so the field never disagrees with what is saved.
  const onPrimaryBlur = () => {
    if (HexColor.safeParse(primaryText).success) return;
    setPrimaryText(shownPrimary);
    setPrimaryError(null);
  };

  const onSecondaryBlur = () => {
    if (HexColor.safeParse(secondaryText).success) return;
    setSecondaryText(shownSecondary);
    setSecondaryError(null);
  };

  // The shown colors may not change on reset, so the effects above would not clear typed text.
  const onReset = () => {
    setPrimaryText(DEFAULT_PRIMARY);
    setSecondaryText(DEFAULT_SECONDARY);
    setPrimaryError(null);
    setSecondaryError(null);
    onChange(null);
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ minWidth: 140 }}>สีหลัก (Primary)</span>
        <input type="color" aria-label="สีหลัก (Primary)" value={primaryParsed.success ? primaryParsed.data : shownPrimary} disabled={disabled} onChange={(e) => onPrimaryColor(e.target.value)} />
        <input type="text" aria-label="รหัสสีหลัก (Primary hex)" value={primaryText} placeholder="#rrggbb" spellCheck={false} disabled={disabled} onChange={(e) => onPrimaryText(e.target.value)} onBlur={onPrimaryBlur} />
      </div>
      {primaryError && <p className="neg" role="alert">{primaryError}</p>}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ minWidth: 140 }}>สีรอง (Secondary)</span>
        <input type="color" aria-label="สีรอง (Secondary)" value={secondaryParsed.success ? secondaryParsed.data : shownSecondary} disabled={disabled} onChange={(e) => onSecondaryColor(e.target.value)} />
        <input type="text" aria-label="รหัสสีรอง (Secondary hex)" value={secondaryText} placeholder="#rrggbb" spellCheck={false} disabled={disabled} onChange={(e) => onSecondaryText(e.target.value)} onBlur={onSecondaryBlur} />
      </div>
      {secondaryError && <p className="neg" role="alert">{secondaryError}</p>}
      <div>
        <button type="button" className="btn" disabled={disabled} onClick={onReset}>ใช้สีของเทมเพลต (Use template colors)</button>
      </div>
    </div>
  );
}
