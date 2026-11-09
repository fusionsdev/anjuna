import { Home, Store, LayoutTemplate, Megaphone, Activity, Target, Bell, Terminal, Settings } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PageId } from '../types/app'

export interface NavItem {
  id: PageId
  label: string
  icon: LucideIcon
  badge?: number
  tag?: string
}

export const navItems: NavItem[] = [
  { id: 'home', label: 'หน้าแรก', icon: Home },
  { id: 'brands', label: 'แบรนด์', icon: Store, badge: 3 },
  { id: 'templates', label: 'เทมเพลต', icon: LayoutTemplate, badge: 4 },
  { id: 'campaigns', label: 'แคมเปญ', icon: Megaphone },
  { id: 'traffic', label: 'ทราฟฟิก', icon: Activity },
  { id: 'leads', label: 'ลีดและคอนเวอร์ชัน', icon: Target },
  { id: 'alerts', label: 'การแจ้งเตือน', icon: Bell, badge: 2 },
  { id: 'adkit', label: 'AdKit Terminal', icon: Terminal, tag: 'owner' },
  { id: 'settings', label: 'ตั้งค่า', icon: Settings }
]
