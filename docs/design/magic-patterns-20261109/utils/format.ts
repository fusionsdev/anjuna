export function thb(n: number | null): string {
  return n == null ? '—' : `฿${n.toLocaleString('en-US')}`
}

export function num(n: number | null): string {
  return n == null ? '—' : n.toLocaleString('en-US')
}
