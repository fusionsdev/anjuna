import type { TrafficRealtimeResponse } from "@anjuna/contracts";
import { BOT_LABEL, clockIso } from "./live";

const count = (n: number) => n.toLocaleString("en-US");
const ORDER = ["googlebot", "adsbot", "other-bot"] as const;

/** บอท Google ตอนนี้: the bots of the current UTC hour, with the 24 hour count beside each. The counts cover every brand. */
export function BotsNow({ bots }: { bots: TrafficRealtimeResponse["bots_now"] }) {
  return (
    <section className="panel rt-bots" aria-label="บอท Google ตอนนี้">
      <h2>บอท Google ตอนนี้</h2>
      <div className="ledger">
        {ORDER.map((key) => (
          <div className="cell" key={key}>
            <p className="k">{BOT_LABEL[key]} ชั่วโมงนี้</p>
            <p className="v num">{count(bots[key].current_hour)}</p>
            <p className="hint">24 ชม. <span className="num">{count(bots[key]["24h"])}</span></p>
          </div>
        ))}
      </div>
    </section>
  );
}

type Hit = TrafficRealtimeResponse["adsbot_last"][number];

/** บอทของ Google 24 ชม.: the 24 hour counts and the latest AdsBot visits with the status each page answered. */
export function BotsDay({ bots, hits, labelOf }: { bots: TrafficRealtimeResponse["bots_now"]; hits: Hit[]; labelOf: (brandId: string) => string }) {
  return (
    <section className="panel rt-bots" aria-label="บอทของ Google 24 ชม.">
      <h2>บอทของ Google 24 ชม.</h2>
      <p className="hint">
        {ORDER.map((key, i) => <span key={key}>{i > 0 && " · "}{BOT_LABEL[key]} <b className="num">{count(bots[key]["24h"])}</b></span>)}
      </p>
      {hits.length === 0 ? (
        <p className="hint">ยังไม่มี AdsBot เข้าเว็บใน 24 ชั่วโมงที่ผ่านมา</p>
      ) : (
        <div className="data-table">
          <table>
            <thead><tr><th scope="col">เวลา (UTC)</th><th scope="col">แบรนด์</th><th scope="col">หน้า</th><th scope="col">สถานะ</th><th scope="col">ตอบกลับ</th><th scope="col">ด่านตรวจ</th></tr></thead>
            <tbody>
              {hits.map((hit, n) => (
                <tr key={`${hit.at}-${n}`}>
                  <td className="num">{clockIso(hit.at)}</td>
                  <td>{labelOf(hit.brand)}</td>
                  <td className="rt-mono">{hit.url}</td>
                  <td className={`num ${hit.http_status !== null && hit.http_status !== 200 ? "rt-bad" : ""}`}>{hit.http_status ?? "—"}</td>
                  <td className="num">{hit.response_ms === null ? "—" : `${Math.round(hit.response_ms)} ms`}</td>
                  <td>{hit.gate_passed === null ? "—" : hit.gate_passed ? "ผ่าน" : "ไม่ผ่าน"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
