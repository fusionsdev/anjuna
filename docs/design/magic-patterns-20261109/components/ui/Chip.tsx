import React from "react";
import { Icon } from "./Icon";
import { Tone } from "../../types/app";
import { BoxIcon } from "lucide-react";
const tones: Record<Tone, string> = {
  success: 'bg-ok-bg text-ok',
  warning: 'bg-warn-bg text-warn',
  danger: 'bg-bad-bg text-bad',
  info: 'bg-info-bg text-info',
  neutral: 'border border-line bg-canvas text-sub',
  accent: 'bg-brand-tint text-brand-ink'
};
interface ChipProps {
  tone?: Tone;
  children: React.ReactNode;
  dot?: boolean;
  icon?: BoxIcon;
  className?: string;
}
export function Chip({
  tone = 'neutral',
  children,
  dot,
  icon,
  className = ''
}: ChipProps) {
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[13px] font-medium leading-none ${tones[tone]} ${className}`}>{dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}{icon && <Icon icon={icon} tone="current" className="h-3.5 w-3.5" />}{children}</span>;
}