// spec polish
import type { ReactElement } from "react";

/** The shared paging control of spec D3.1: a Load more button under the cap, the max note at the cap, nothing when the list is complete. */
export function LoadMore({ shown, hasMore, atMax, loading, onMore, narrowHint }: {
  shown: number;
  hasMore: boolean;
  atMax: boolean;
  loading: boolean;
  onMore: () => void;
  narrowHint: string;
}): ReactElement | null {
  if (!hasMore) return null;
  if (atMax) return <p className="hint">แสดง {shown} รายการ ซึ่งเป็นจำนวนสูงสุด {narrowHint}</p>;
  return (
    <button type="button" className="btn" disabled={loading} onClick={onMore}>
      {loading ? "กำลังโหลด…" : "โหลดเพิ่ม (Load more)"}
    </button>
  );
}
