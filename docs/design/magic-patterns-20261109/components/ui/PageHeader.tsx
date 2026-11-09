import React from "react";
import { Icon } from "./Icon";
import { BoxIcon } from "lucide-react";
interface PageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  icon?: BoxIcon;
}
export function PageHeader({
  title,
  subtitle,
  actions,
  icon
}: PageHeaderProps) {
  return <div className="flex flex-wrap items-end justify-between gap-4"><div className="flex items-start gap-3">{icon && <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-tint"><Icon icon={icon} tone="brand" /></span>}<div><h1 className="mb-1 text-[28px] font-semibold leading-[1.25] tracking-[-0.01em] text-ink">{title}</h1>{subtitle && <p className="text-[15px] leading-[1.5] text-sub">{subtitle}</p>}</div></div>{actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}</div>;
}