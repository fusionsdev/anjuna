import React from "react";
import { BoxIcon } from "lucide-react";
type IconSize = 'text' | 'nav' | 'banner';
type IconTone = 'sub' | 'brand' | 'current';
interface IconProps {
  icon: BoxIcon;
  size?: IconSize;
  tone?: IconTone;
  className?: string;
}
const sizes: Record<IconSize, string> = {
  text: 'h-4 w-4',
  nav: 'h-[18px] w-[18px]',
  banner: 'h-5 w-5'
};
const tones: Record<IconTone, string> = {
  sub: 'text-sub',
  brand: 'text-brand-ink',
  current: 'text-current'
};
export function Icon({
  icon: Lucide,
  size = 'text',
  tone = 'sub',
  className = ''
}: IconProps) {
  return <Lucide aria-hidden="true" className={`${sizes[size]} ${tones[tone]} ${className}`} />;
}