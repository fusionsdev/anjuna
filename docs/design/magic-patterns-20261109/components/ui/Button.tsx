import React from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: Variant; size?: 'md' | 'sm'; icon?: React.ReactNode }
const variants: Record<Variant, string> = { primary: 'bg-brand text-white border border-brand hover:bg-brand-hover hover:border-brand-hover', secondary: 'bg-white text-ink border border-line hover:bg-canvas', ghost: 'bg-transparent text-ink border border-transparent hover:bg-canvas', danger: 'bg-white text-bad border border-line hover:bg-bad-bg' }
export function Button({ variant = 'secondary', size = 'md', icon, className = '', children, type = 'button', ...rest }: ButtonProps) { return <button type={type} className={`focus-ring inline-flex min-h-[44px] items-center justify-center gap-1.5 whitespace-nowrap rounded-xl font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${size === 'sm' ? 'px-3 text-sm' : 'px-4 text-sm'} ${variants[variant]} ${className}`} {...rest}>{icon}{children}</button> }
