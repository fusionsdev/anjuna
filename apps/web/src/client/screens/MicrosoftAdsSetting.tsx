/**
 * The global Microsoft Ads account on the Settings screen (GET and PUT /api/settings/microsoft-ads, owner only).
 * It left the brand wizard: one account serves every brand. An empty field saves null.
 */
import { MicrosoftAdsAccount } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { ApiError, api } from "../api";

const LABEL = "บัญชี Microsoft Ads (Microsoft Ads account)";

export function MicrosoftAdsSetting() {
  // undefined while loading, then the saved account or null.
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let active = true;
    api.microsoftAdsSetting().then(
      (r) => { if (active) { setSaved(r.microsoft_ads_account); setValue(r.microsoft_ads_account ?? ""); } },
      (e: unknown) => { if (active) setError(e instanceof ApiError ? e.thai : "โหลดบัญชี Microsoft Ads ไม่สำเร็จ (Could not load the Microsoft Ads account)"); },
    );
    return () => { active = false; };
  }, []);

  const next = value.trim() === "" ? null : value.trim();
  const invalid = next !== null && !MicrosoftAdsAccount.safeParse(next).success;
  const unchanged = next === saved;

  async function save() {
    setSaving(true);
    setError(null);
    setDone(false);
    try {
      const r = await api.putMicrosoftAdsSetting(next);
      setSaved(r.microsoft_ads_account);
      setValue(r.microsoft_ads_account ?? "");
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.thai : "บันทึกไม่สำเร็จ (Could not save)");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel" aria-label={LABEL} style={{ display: "grid", gap: 8 }}>
      <h2>บัญชี Microsoft Ads</h2>
      <p className="hint">บัญชีเดียวใช้กับทุกแบรนด์ เว้นว่าง = ไม่ตั้งค่า (One account for every brand, blank clears it)</p>
      <label>
        บัญชี Microsoft Ads
        <input aria-label={LABEL} inputMode="numeric" maxLength={12} value={value} disabled={saved === undefined || saving}
          aria-invalid={invalid ? true : undefined} onChange={(e) => { setValue(e.target.value); setDone(false); }} />
      </label>
      {invalid && <p className="neg" role="alert">ต้องเป็นเลข 6 ถึง 12 หลัก (6 to 12 digits)</p>}
      <div className="row">
        <button type="button" className="btn pri" disabled={saved === undefined || saving || invalid || unchanged} onClick={() => void save()}>บันทึก (Save)</button>
      </div>
      {done && <p role="status" className="hint">บันทึกแล้ว (Saved)</p>}
      {error && <p className="neg" role="alert">{error}</p>}
    </section>
  );
}
