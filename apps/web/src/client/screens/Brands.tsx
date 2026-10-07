import type { Me } from "../api";
import { BrandLifecycle } from "./BrandLifecycle";

/** Backward-compatible screen entry point for the lifecycle-first brands view. */
export function BrandsScreen({ me }: { me: Me }) {
  return <BrandLifecycle me={me} />;
}
