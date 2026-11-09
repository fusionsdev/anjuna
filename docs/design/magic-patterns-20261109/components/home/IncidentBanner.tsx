import React from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '../ui/Button'

interface IncidentBannerProps {
  onQueue: () => void
  onAlerts: () => void
}

export function IncidentBanner({ onQueue, onAlerts }: IncidentBannerProps) {
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-card border border-[#F2D49A] bg-warn-bg px-5 py-3.5 md:flex-row md:items-center">
      <div className="flex flex-1 items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden="true" />
        <p className="text-sm font-medium text-warn">
          คอนเวอร์ชันส่งไม่ได้ <span className="num">4</span> รายการ และ <span className="num">3</span> ลีดรอผล LeadsGate เกิน 24 ชั่วโมง
        </p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={onQueue}>
          ดูคิว
        </Button>
        <Button size="sm" onClick={onAlerts}>
          การแจ้งเตือน
        </Button>
      </div>
    </div>
  )
}
