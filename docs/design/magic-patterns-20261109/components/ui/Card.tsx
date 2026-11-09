import React from 'react'

interface CardProps { title?: React.ReactNode; source?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; bodyClassName?: string }

export function Card({ title, source, action, children, className = '', bodyClassName = 'p-6' }: CardProps) {
  return <section className={`rounded-card border border-line bg-white shadow-[0_1px_2px_rgba(17,17,17,0.04)] ${className}`}>{(title || source || action) && <header className="relative flex flex-wrap items-center gap-3 border-b border-line px-6 py-4">{title && <><span aria-hidden="true" className="h-6 w-[3px] shrink-0 rounded-full bg-brand"/><h2 className="min-w-0 text-lg font-semibold text-ink">{title}</h2></>}{source && <span className="ml-auto">{source}</span>}{action && <span className="flex shrink-0 items-center gap-2">{action}</span>}</header>}<div className={bodyClassName}>{children}</div></section>
}
