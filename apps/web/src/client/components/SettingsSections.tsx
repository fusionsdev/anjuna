import { Bell, History, KeyRound, Mail, MailX, Settings, Users, Wallet, type LucideIcon } from "lucide-react";
import { type View, isPlainLeftClick, viewPath } from "../router";
import "./SettingsSections.css";

type TabView = Exclude<View, "not-found">;

const ICONS: Partial<Record<TabView, LucideIcon>> = {
  settings: Settings, "notify-settings": Bell, "ad-allocation": Wallet, users: Users, mailing: Mail,
  suppressions: MailX, audit: History, "builder-keys": KeyRound,
};

/**
 * The sections of Settings as a list at the left (design round 6); under 1024px it is a row of chips.
 * Each section is a link to its own URL, so a reload or a new tab keeps the screen. A role sees only the sections it may open.
 */
export function SettingsSections({ tabs, active, onSelect }: {
  tabs: { id: TabView; label: string }[];
  active: View | null;
  onSelect: (id: TabView) => void;
}) {
  return (
    <nav className="settings-sections" aria-label="หมวดตั้งค่า">
      <ul>
        {tabs.map((tab) => {
          const Icon = ICONS[tab.id];
          return (
            <li key={tab.id}>
              <a
                href={viewPath(tab.id)}
                aria-current={active === tab.id ? "page" : undefined}
                onClick={(e) => {
                  if (!isPlainLeftClick(e)) return;
                  e.preventDefault();
                  onSelect(tab.id);
                }}
              >
                {Icon && <Icon aria-hidden="true" />}
                {tab.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
