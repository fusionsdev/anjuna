import type { BrandSummary, LifecycleBrandSummary } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { api } from "./api";

type Source = Pick<LifecycleBrandSummary, "brand_id" | "hostnames">[] | null;

export function buildBrandLabels(lifecycle: Source, runtime: Pick<BrandSummary, "brand_id" | "hostnames">[] | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const b of runtime ?? []) if (b.hostnames[0]) map.set(b.brand_id, b.hostnames[0]);
  // The factory domain wins over the runtime hostname.
  for (const b of lifecycle ?? []) if (b.hostnames[0]) map.set(b.brand_id, b.hostnames[0]);
  return map;
}

/** brand_id to domain. Unknown ids, and ids asked before the lists load, read as the id itself. `enabled: false` skips the fetch. */
export function useBrandLabels(enabled = true): (brandId: string) => string {
  const [map, setMap] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void Promise.allSettled([api.lifecycleBrands(), api.brands()]).then(([lifecycle, runtime]) => {
      if (!active) return;
      setMap(buildBrandLabels(lifecycle.status === "fulfilled" ? lifecycle.value.brands : null, runtime.status === "fulfilled" ? runtime.value.brands : null));
    });
    return () => { active = false; };
  }, [enabled]);
  return (brandId) => map.get(brandId) ?? brandId;
}

export function BrandLabel({ brandId, domain }: { brandId: string; domain?: string | null }) {
  // A caller that already holds the domain (one useBrandLabels() per screen) must not trigger a fetch per row.
  const labelOf = useBrandLabels(!domain);
  const shown = domain || labelOf(brandId);
  return <span className="brand-label" title={brandId}>{shown}{shown !== brandId && <code className="brand-id">{brandId}</code>}</span>;
}
