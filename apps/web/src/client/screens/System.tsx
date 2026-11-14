import { roleAtLeast } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { PANEL_ROLE_TABLE } from "../../server/panel-roles";
import { api, type Me } from "../api";
import { Chip } from "../components/Chip";
import { visibleSystemCards } from "../nav-groups";
import { type View, isPlainLeftClick, viewPath } from "../router";
import "./System.css";

type CardView = Exclude<View, "not-found">;
/** A card's status: a short tag, a warning tone when the owner should act, and an optional line that replaces the card text. */
type CardStatus = { tag: string; warn: boolean; desc?: string };

/**
 * Status tags read from the screens' own endpoints. A read that fails, or a role that may not read it, leaves the card without a tag.
 * Each read is separate, so one slow or failing endpoint does not hold back the other tags.
 */
function useCardStatus(role: Me["role"]): Partial<Record<CardView, CardStatus>> {
  const [status, setStatus] = useState<Partial<Record<CardView, CardStatus>>>({});
  useEffect(() => {
    let cancelled = false;
    const put = (view: CardView, value: CardStatus | null) => {
      if (!cancelled && value) setStatus((prev) => ({ ...prev, [view]: value }));
    };
    const ignore = () => undefined;
    api.templates().then((body) => {
      const live = new Set(body.templates.filter((t) => !t.archived).map((t) => t.template_id));
      put("templates", { tag: String(live.size), warn: false });
    }, ignore);
    api.builderKeys().then((body) => {
      put("builder-keys", { tag: String(body.keys.filter((k) => k.revoked_at === null).length), warn: false });
    }, ignore);
    // Mail waits in the queue while listmonk is not set up, so the owner sees how much is stuck.
    api.mailing().then((body) => {
      const stuck = body.counts.pending;
      put("mailing", body.external_sync === "not_configured" && stuck > 0
        ? { tag: `ค้าง ${stuck}`, warn: true, desc: `ยังไม่ได้ตั้งค่า listmonk เลยมีอีเมลค้างส่ง ${stuck} ฉบับ` }
        : null);
    }, ignore);
    if (roleAtLeast(role, PANEL_ROLE_TABLE.viewSettings)) {
      api.notifySettings().then((body) => put("notify-settings", body.telegram.enabled ? null : { tag: "Telegram ปิด", warn: true }), ignore);
    }
    return () => { cancelled = true; };
  }, [role]);
  return status;
}

/** The ระบบ page: one card per screen the owner does not open every day. A card the role may not open is left out. */
export function SystemScreen({ me, onOpen }: { me: Me; onOpen: (id: CardView) => void }) {
  const status = useCardStatus(me.role);
  return (
    <>
      <div className="head">
        <div>
          <h1>ระบบ</h1>
          <p className="sub">หน้าที่ไม่ได้ใช้ทุกวัน ถ้ามีอะไรต้องทำ จะขึ้นที่ "งานรอทำ" ให้เอง</p>
        </div>
      </div>
      <ul className="system-grid" aria-label="หน้าในระบบ">
        {visibleSystemCards(me.role).map((card) => {
          const known = status[card.id];
          const tag = known?.tag ?? card.tag;
          return (
            <li key={card.id}>
              <a
                className="system-card"
                href={viewPath(card.id)}
                onClick={(e) => {
                  if (!isPlainLeftClick(e)) return;
                  e.preventDefault();
                  onOpen(card.id);
                }}
              >
                <span className="system-card-head">
                  <span className="system-card-name">{card.label}</span>
                  {tag && <Chip tone={known?.warn ? "warning" : "neutral"}>{tag}</Chip>}
                </span>
                <span className="system-card-desc">{known?.desc ?? card.desc}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </>
  );
}
