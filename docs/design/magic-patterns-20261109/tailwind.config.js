export default {
  darkMode: 'selector',
  theme: {
    container: { center: true, padding: '2rem', screens: { '2xl': '1400px' } },
    extend: {
      colors: {
        background: 'var(--background)', foreground: 'var(--foreground)', card: 'var(--card)', 'card-foreground': 'var(--card-foreground)',
        popover: 'var(--popover)', 'popover-foreground': 'var(--popover-foreground)', primary: 'var(--primary)', 'primary-foreground': 'var(--primary-foreground)',
        secondary: 'var(--secondary)', 'secondary-foreground': 'var(--secondary-foreground)', muted: 'var(--muted)', 'muted-foreground': 'var(--muted-foreground)',
        accent: 'var(--accent)', 'accent-foreground': 'var(--accent-foreground)', destructive: 'var(--destructive)', border: 'var(--border)', input: 'var(--input)', ring: 'var(--ring)',
        'chart-1': 'var(--chart-1)', 'chart-2': 'var(--chart-2)', 'chart-3': 'var(--chart-3)', 'chart-4': 'var(--chart-4)', 'chart-5': 'var(--chart-5)',
        sidebar: 'var(--sidebar)', 'sidebar-foreground': 'var(--sidebar-foreground)', 'sidebar-primary': 'var(--sidebar-primary)', 'sidebar-primary-foreground': 'var(--sidebar-primary-foreground)',
        'sidebar-accent': 'var(--sidebar-accent)', 'sidebar-accent-foreground': 'var(--sidebar-accent-foreground)', 'sidebar-border': 'var(--sidebar-border)', 'sidebar-ring': 'var(--sidebar-ring)',
        'destructive-foreground': 'var(--destructive-foreground)', canvas: '#F6F6F4', ink: '#111111', sub: '#46464C', line: '#D9D9D4',
        brand: { DEFAULT: '#F83808', hover: '#E03206', tint: '#FFE9E2', ink: '#C42A03' }, ok: { DEFAULT: '#0E7A4F', bg: '#E6F5EE' },
        warn: { DEFAULT: '#805000', bg: '#FFF3DC' }, bad: { DEFAULT: '#B42318', bg: '#FDECEA' }, info: { DEFAULT: '#244D91', bg: '#E8F0FC' }
      },
      borderRadius: { card: '16px' },
      fontFamily: { sans: ['"IBM Plex Sans Thai"', 'Inter', 'system-ui', 'sans-serif'], heading: ['"IBM Plex Sans Thai"', 'Inter', 'system-ui', 'sans-serif'], mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'] }, fontSize: { body: ['15px', { lineHeight: '1.65' }], secondary: ['13px', { lineHeight: '1.55' }] }
    }
  }
}
