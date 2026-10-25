// spec traffic
import { TRAFFIC_LOG_PERIODS, type TrafficLogPeriod } from "@anjuna/contracts";

export const DEFAULT_TRAFFIC_LOG_PERIOD: TrafficLogPeriod = "24h";

export const TRAFFIC_LOG_PERIOD_LABEL: Record<TrafficLogPeriod, string> = { "24h": "24 ชม. (24h)", "7d": "7 วัน (7d)", "30d": "30 วัน (30d)" };

/** An unknown period reads as the default, so core never answers 422. */
export function readTrafficLogPeriod(value: string | null): TrafficLogPeriod {
  return TRAFFIC_LOG_PERIODS.find((period) => period === value) ?? DEFAULT_TRAFFIC_LOG_PERIOD;
}
