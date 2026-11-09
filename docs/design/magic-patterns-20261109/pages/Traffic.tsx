import React, { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, ArrowUpRight, Bot, Bug, DoorClosed, DoorOpen, Download, Eye, Filter, Globe, Hourglass, ListChecks, Monitor, MousePointerBan, Pause, PencilLine, Play, Plug, Radio, Send, ShieldAlert, Smartphone, Tablet, TriangleAlert, Unlink, Volume2, VolumeX, Wifi, WifiOff, BoxIcon } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Chip } from "../components/ui/Chip";
import { PageHeader } from "../components/ui/PageHeader";
import { ScopeSubtitle } from "../components/ui/ScopeSubtitle";
import { SourceChip } from "../components/ui/SourceChip";
import { adsbotVisits, botNow, botRows, breakdowns, liveSessions, recentEvents, trafficRows, trendBuckets, webErrors } from "../data/operations";
import { BrandScope, Tone } from "../types/app";
import { isDisplayBrandInScope } from "../utils/brandScope";
type Range = '24 ชม.' | '7 วัน' | '30 วัน';
type Tab = 'realtime' | 'traffic' | 'funnel' | 'errors';
type EventFilter = 'all' | 'landing' | 'form' | 'lead' | 'postback' | 'bot' | 'error';
type LiveEvent = {
  sessionRef: string;
  hostname: string;
  brand: string;
  device: string;
  browser: string;
  stage: string;
  time: string;
  bot?: string;
  http?: number;
  response?: string;
  error?: string;
};
type Session = {
  sessionRef: string;
  hostname: string;
  brand: string;
  device: string;
  browser: string;
  bot?: string;
  time: string;
  events: LiveEvent[];
};
const tabs: {
  id: Tab;
  label: string;
  icon: BoxIcon;
}[] = [{
  id: 'realtime',
  label: 'เรียลไทม์',
  icon: Radio
}, {
  id: 'traffic',
  label: 'ทราฟฟิก',
  icon: Activity
}, {
  id: 'funnel',
  label: 'ฟันเนล',
  icon: Filter
}, {
  id: 'errors',
  label: 'ข้อผิดพลาดฝั่งเว็บ',
  icon: Bug
}];
export function Traffic({
  scope,
  onEditScope
}: {
  scope: BrandScope;
  onEditScope: () => void;
  onOpenBrand: (id: string) => void;
}) {
  const [range, setRange] = useState<Range>('24 ชม.');
  const [tab, setTab] = useState<Tab>('realtime');
  const [connected, setConnected] = useState(true);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  useEffect(() => {
    if (!connected) return;
    let next = 0;
    const timer = window.setInterval(() => setEvents(current => current.length >= 30 ? current : [...current, {
      ...(liveSessions[next++ % liveSessions.length] as LiveEvent),
      time: new Date().toLocaleTimeString('en-GB')
    }]), 3000);
    return () => window.clearInterval(timer);
  }, [connected]);
  return <div className="space-y-6"><PageHeader icon={Activity} title={<span className="flex flex-wrap items-center gap-2">ทราฟฟิก {connected && <Chip tone="success" dot icon={Radio}>LIVE</Chip>}</span>} subtitle={<ScopeSubtitle scope={scope} onEdit={onEditScope}>ผู้เข้าเว็บ แหล่งที่มา และข้อผิดพลาดฝั่งเว็บ</ScopeSubtitle>} actions={<RangeToggle value={range} onChange={setRange} />} /><nav className="flex gap-6 overflow-x-auto border-b border-line" aria-label="มุมมองทราฟฟิก">{tabs.map(item => {
        const TabIcon = item.icon;
        return <button key={item.id} type="button" onClick={() => setTab(item.id)} className={`focus-ring inline-flex min-h-[44px] shrink-0 items-center gap-2 border-b-2 px-1 text-[15px] ${tab === item.id ? 'border-brand font-semibold text-brand-ink' : 'border-transparent text-sub'}`}><TabIcon aria-hidden="true" className="h-4 w-4" />{item.label}</button>;
      })}</nav>{tab === 'realtime' && <Realtime scope={scope} connected={connected} setConnected={setConnected} events={events.filter(event => isDisplayBrandInScope(event.brand, scope))} />} {tab === 'traffic' && <TrafficTable scope={scope} />} {tab === 'funnel' && <Funnels scope={scope} />} {tab === 'errors' && <Errors scope={scope} />}</div>;
}
function Realtime({
  scope,
  connected,
  setConnected,
  events
}: {
  scope: BrandScope;
  connected: boolean;
  setConnected: (value: boolean) => void;
  events: LiveEvent[];
}) {
  const [sound, setSound] = useState(false);
  const [brand, setBrand] = useState('all');
  const [filter, setFilter] = useState<EventFilter>('all');
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<LiveEvent[]>([]);
  const filtered = events.filter(event => (brand === 'all' || event.brand === brand) && (!onlyErrors || !!event.error) && matches(event, filter));
  const shown = paused ? frozen : filtered;
  const groups = useMemo(() => groupSessions(shown), [shown]);
  const brands = Array.from(new Set(events.map(event => event.brand)));
  const adsbot = events.find(event => event.bot === 'AdsBot');
  const pause = () => {
    if (!paused) setFrozen(filtered);
    setPaused(!paused);
  };
  return <div className="space-y-6"><Connection connected={connected} setConnected={setConnected} sound={sound} setSound={setSound} />{adsbot && <AdsbotBanner event={adsbot} onShow={() => setFilter('bot')} />}<Kpis /><BotNow scope={scope} /><LiveFeed events={events} groups={groups} brand={brand} brands={brands} setBrand={setBrand} filter={filter} setFilter={setFilter} onlyErrors={onlyErrors} setOnlyErrors={setOnlyErrors} paused={paused} onPause={pause} /><Trend /><Breakdowns scope={scope} /><BotHits scope={scope} /><Recent scope={scope} /></div>;
}
function Connection({
  connected,
  setConnected,
  sound,
  setSound
}: {
  connected: boolean;
  setConnected: (value: boolean) => void;
  sound: boolean;
  setSound: (value: boolean) => void;
}) {
  const Status = connected ? Wifi : WifiOff;
  return <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-card border border-line bg-white px-6 py-3 shadow-[0_1px_2px_rgba(17,17,17,0.04)]"><span className={`inline-flex items-center gap-2 text-[15px] font-semibold ${connected ? 'text-ok' : 'text-bad'}`}><span className={`h-2 w-2 rounded-full ${connected ? 'bg-ok' : 'bg-bad'}`} /><Status aria-hidden="true" className="h-4 w-4" />{connected ? 'เชื่อมต่อแล้ว' : 'หลุดการเชื่อมต่อ'}</span>{!connected && <Button size="sm" icon={<Plug aria-hidden="true" className="h-4 w-4" />} onClick={() => setConnected(true)}>เชื่อมใหม่</Button>}<span className="text-[13px] text-sub">เหตุการณ์ล่าสุด <span className="num">14:01:10</span></span><span className="num text-[15px] font-medium">3.2 เหตุการณ์/นาที</span><button type="button" onClick={() => setSound(!sound)} className="focus-ring ml-auto inline-flex min-h-[44px] items-center gap-2 rounded-xl px-3 text-[15px] hover:bg-canvas">{sound ? <Volume2 aria-hidden="true" className="h-4 w-4" /> : <VolumeX aria-hidden="true" className="h-4 w-4" />}เสียงเตือน</button></div>;
}
function AdsbotBanner({
  event,
  onShow
}: {
  event: LiveEvent;
  onShow: () => void;
}) {
  const good = event.http === 200;
  return <div role="alert" className={`flex flex-wrap items-center gap-3 rounded-card border px-6 py-4 ${good ? 'border-[#F2D49A] bg-warn-bg text-warn' : 'border-[#EFC0BC] bg-bad-bg text-bad'}`}><AlertTriangle aria-hidden="true" className="h-5 w-5 shrink-0" /><p className="flex-1 text-[15px] font-semibold">{good ? `AdsBot-Google เข้า petvetpay.co/go เมื่อ ${event.time} · HTTP 200 · 212 ms · ผ่าน gate` : 'หน้าไม่ตอบ 200 ขณะ Google ตรวจ'}</p><Button size="sm" onClick={onShow}>ดูเซสชัน</Button><Button size="sm">ดูหน้าใน Google Ads</Button></div>;
}
function Kpis() {
  const first: [string, string, string, BoxIcon][] = [['ผู้เข้าหน้าเว็บ', '24', 'text-ok', Eye], ['เริ่มกรอกฟอร์ม', '13', 'text-ok', PencilLine], ['ส่งลีด (client)', '4', 'text-ok', Send], ['ข้อผิดพลาดฟอร์ม', '2', 'text-bad', TriangleAlert], ['ข้อผิดพลาด redirect', '1', 'text-bad', Unlink], ['เซสชันน่าสงสัย', '—', '', ShieldAlert]];
  const second: [string, string, string, string, BoxIcon][] = [['คลิกที่จ่ายแต่ไม่มี gclid', '6 · 25%', 'text-warn', 'มากกว่า 20% ของ landing', MousePointerBan], ['หลุดที่ gate /go', '3', '', 'ไม่มีจำนวนเงิน + ZIP', DoorClosed], ['ทราฟฟิกนอกสหรัฐ', '8.3%', '', 'LeadsGate รับเฉพาะ US ZIP', Globe]];
  return <section className="space-y-3"><div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{first.map(([label, value, tone, icon]) => <Kpi key={label} label={label} value={value} tone={tone} icon={icon} delta="+12%" />)}</div><div className="grid gap-3 md:grid-cols-3">{second.map(([label, value, tone, sub, icon]) => <Kpi key={label} label={label} value={value} tone={tone} sub={sub} icon={icon} />)}</div></section>;
}
function Kpi({
  label,
  value,
  tone,
  delta,
  sub,
  icon: Icon
}: {
  label: string;
  value: string;
  tone?: string;
  delta?: string;
  sub?: string;
  icon: BoxIcon;
}) {
  return <div className="rounded-card border border-line bg-white p-5 shadow-[0_1px_2px_rgba(17,17,17,0.04)]"><p className="flex items-center gap-1.5 text-[13px] font-medium text-sub"><Icon aria-hidden="true" className="h-4 w-4" />{label}</p><p className={`num mt-2 text-[28px] font-semibold leading-none ${tone}`}>{value}</p>{delta && <p className="num mt-2 inline-flex items-center gap-0.5 text-[13px] text-ok"><ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />เทียบชั่วโมงเดียวกันเมื่อวาน {delta}</p>}{sub && <p className="mt-2 text-[13px] text-sub">{sub}</p>}</div>;
}
function BotNow({
  scope
}: {
  scope: BrandScope;
}) {
  const visits = adsbotVisits.filter(row => isDisplayBrandInScope(row.brand, scope));
  return <Card title="บอท Google ตอนนี้" source={<SourceChip>D1 · bot_hits</SourceChip>} bodyClassName="p-0"><div className="grid divide-y divide-line md:grid-cols-3 md:divide-x md:divide-y-0">{botNow.map(bot => <div key={bot.label} className="p-6"><p className="flex items-center gap-2 text-[15px] font-semibold"><Bot aria-hidden="true" className="h-4 w-4 text-sub" />{bot.label}</p><dl className="mt-4 grid grid-cols-3 gap-3"><Metric label="15 นาที" value={bot.fifteen} /><Metric label="1 ชม." value={bot.hour} /><Metric label="24 ชม." value={bot.day} /></dl></div>)}</div><div className="overflow-x-auto border-t border-line"><table className="min-w-[720px]"><caption className="px-6 py-4 text-left text-[15px] font-semibold">AdsBot เข้าล่าสุดต่อแบรนด์</caption><thead><tr>{['แบรนด์', 'URL', 'เวลา', 'HTTP', 'เวลาตอบ', 'gate'].map(head => <th key={head}>{head}</th>)}</tr></thead><tbody>{visits.map(row => <tr key={row.brand}><td className="font-semibold">{row.brand}</td><td className="font-mono text-[13px]">{row.url}</td><td className="num">{row.time}</td><td className={`num ${row.http === 200 ? 'text-ok' : 'text-bad'}`}>{row.http}</td><td className="num">{row.response}</td><td><Chip tone={row.gate === 'ผ่าน' ? 'success' : 'danger'} icon={row.gate === 'ผ่าน' ? Send : TriangleAlert}>{row.gate}</Chip></td></tr>)}</tbody></table></div></Card>;
}
function LiveFeed({
  events,
  groups,
  brand,
  brands,
  setBrand,
  filter,
  setFilter,
  onlyErrors,
  setOnlyErrors,
  paused,
  onPause
}: {
  events: LiveEvent[];
  groups: Session[];
  brand: string;
  brands: string[];
  setBrand: (value: string) => void;
  filter: EventFilter;
  setFilter: (value: EventFilter) => void;
  onlyErrors: boolean;
  setOnlyErrors: (value: boolean) => void;
  paused: boolean;
  onPause: () => void;
}) {
  const filters: [EventFilter, string][] = [['all', 'ทั้งหมด'], ['landing', 'landing'], ['form', 'ฟอร์ม'], ['lead', 'ลีด'], ['postback', 'postback'], ['bot', 'บอท'], ['error', 'ข้อผิดพลาด']];
  return <Card title={<span>ทราฟฟิกสด<span className="mt-1 block text-[13px] font-medium text-sub">เหตุการณ์ที่เข้ามาตั้งแต่เปิดหน้านี้</span></span>} source={<SourceChip>SSE · event-tail · แจ้งเตือนอย่างเดียว</SourceChip>} action={<span className="flex flex-wrap items-center gap-2"><Chip tone="neutral" icon={Hourglass}>รุ่นถัดไป: บันทึกและส่งออก</Chip><Chip tone={events.length ? 'success' : 'neutral'} dot={!!events.length}>{events.length ? `${events.length} เหตุการณ์` : 'ยังไม่มีเหตุการณ์'}</Chip></span>} bodyClassName="p-0"><div className="flex flex-wrap items-center gap-2 border-b border-line px-6 py-4"><select value={brand} onChange={event => setBrand(event.target.value)} className="focus-ring h-11 rounded-xl border border-line bg-white px-3 text-[15px]"><option value="all">ทุกแบรนด์</option>{brands.map(item => <option key={item}>{item}</option>)}</select>{filters.map(([id, label]) => <button key={id} type="button" onClick={() => setFilter(id)} className={`focus-ring min-h-[44px] rounded-full border px-3 text-[15px] ${filter === id ? 'border-brand-tint bg-brand-tint font-semibold text-brand-ink' : 'border-line bg-white text-ink'}`}>{label}</button>)}<label className="flex min-h-[44px] items-center gap-2 px-1 text-[15px]"><input type="checkbox" checked={onlyErrors} onChange={event => setOnlyErrors(event.target.checked)} className="focus-ring h-4 w-4 accent-[#F83808]" />เฉพาะข้อผิดพลาด</label><Button size="sm" className="ml-auto" icon={paused ? <Play aria-hidden="true" className="h-4 w-4" /> : <Pause aria-hidden="true" className="h-4 w-4" />} onClick={onPause}>{paused ? 'เลื่อนต่อ' : 'หยุดเลื่อน'}</Button></div>{groups.length ? <ul className="divide-y divide-line">{groups.map((group, index) => <li key={group.sessionRef} className={`relative px-6 py-4 ${index === 0 ? 'animate-[pulse_3s_ease-out_1] bg-brand-tint/25' : ''}`}>{index === 0 && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-brand" />}<div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="text-[16px] font-semibold text-ink">{group.hostname}</p><p className="mt-0.5 font-mono text-[13px] text-sub">{short(group.sessionRef)}</p><div className="mt-2 flex flex-wrap items-center gap-2"><Chip tone="neutral">{group.brand}</Chip>{group.bot && <Chip tone={group.bot === 'AdsBot' ? 'accent' : 'neutral'} icon={Bot}>{group.bot}</Chip>}<span className="inline-flex items-center gap-1.5 text-[13px] text-sub"><DeviceIcon device={group.device} />{group.device} · {group.browser}</span></div></div><time className="num text-[13px] text-sub">{group.time}</time></div><div className="mt-3 flex flex-wrap gap-2">{group.events.map((event, eventIndex) => <StageChip key={`${event.stage}-${eventIndex}`} event={event} />)}</div></li>)}</ul> : <div className="flex h-40 items-center justify-center gap-2 text-[15px] text-sub"><Radio aria-hidden="true" className="h-5 w-5" />รอทราฟฟิก…</div>}<p className="border-t border-line px-6 py-4 text-[13px] text-sub">แสดงเฉพาะเหตุการณ์ที่มาถึงระหว่างเปิดหน้า ไม่ย้อนหลัง ประวัติอยู่ใน “ทราฟฟิกล่าสุด” ด้านล่าง (D1) เซสชันจัดกลุ่มด้วย session_ref ทางเดียว ไม่มี PII</p></Card>;
}
function StageChip({
  event
}: {
  event: LiveEvent;
}) {
  const Icon = eventIcon(event.stage);
  return <Chip tone={stageTone(event.stage)} icon={Icon}>{event.error ? `error: ${event.error}` : event.stage}</Chip>;
}
function Trend() {
  const totals = trendBuckets.map(bucket => bucket.reduce((sum, value) => sum + value, 0));
  const max = Math.max(...totals);
  const maxIndex = totals.indexOf(max);
  return <Card title="แนวโน้ม รายชั่วโมง/รายวัน" source={<SourceChip>D1 · traffic_events</SourceChip>}><div className="flex flex-wrap gap-5 text-[14px]"><Legend color="bg-ink" label="ผู้เข้าหน้าเว็บ" /><Legend color="bg-info" label="เริ่มกรอกฟอร์ม" /><Legend color="bg-brand" label="ส่งลีด" /></div><div className="relative mt-7 flex h-48 items-end gap-0.5 border-b border-line">{trendBuckets.map(([views, forms, leads], index) => <div key={index} className="relative flex h-full min-w-[8px] flex-1 flex-col justify-end gap-0.5">{index === maxIndex && <span className="num absolute -top-6 left-1/2 -translate-x-1/2 text-[13px] font-semibold">{max}</span>}<span className="bg-brand" style={{
          height: `${leads / max * 100}%`
        }} /><span className="bg-info" style={{
          height: `${forms / max * 100}%`
        }} /><span className="bg-ink" style={{
          height: `${views / max * 100}%`
        }} /></div>)}</div><div className="mt-3 flex justify-between font-mono text-[13px] text-sub"><span>2026-11-08 20:00</span><span>2026-11-09 14:00</span></div></Card>;
}
function Breakdowns({
  scope
}: {
  scope: BrandScope;
}) {
  const sets = [['แหล่งที่มา', breakdowns.source], ['โฮสต์', breakdowns.host], ['อุปกรณ์', breakdowns.device], ['เบราว์เซอร์', breakdowns.browser], ['แบรนด์', breakdowns.brand.filter(row => isDisplayBrandInScope(row.label, scope))]];
  return <Card title="แยกตาม" source={<SourceChip>D1 · traffic_events</SourceChip>}><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">{sets.map(([title, data]) => <section key={title as string} className="rounded-xl bg-canvas/60 p-4"><h3 className="border-b-2 border-line pb-2 text-[15px] font-semibold text-ink">{title as string}</h3><ul className="mt-2 divide-y divide-line">{(data as {
            label: string;
            count: number;
            percent: string;
          }[]).map(row => <li key={row.label} className="flex min-h-[44px] items-center justify-between gap-2 py-2"><span className="truncate text-[15px]">{row.label}</span><span className="text-right"><span className="num block text-[16px] font-semibold">{row.count}</span><span className="num block text-[12px] text-sub">{row.percent}</span></span></li>)}</ul></section>)}</div></Card>;
}
function BotHits({
  scope
}: {
  scope: BrandScope;
}) {
  const rows = botRows.filter(row => isDisplayBrandInScope(row.brand, scope));
  return <Card title="บอทของ Google ใน 24 ชั่วโมง" source={<SourceChip>D1 · bot_hits</SourceChip>} bodyClassName="p-0"><div className="overflow-x-auto"><table className="min-w-[560px]"><thead><tr>{['แบรนด์', 'Googlebot', 'AdsBot', 'บอทอื่น'].map(head => <th key={head} className={head === 'แบรนด์' ? '' : 'text-right'}>{head}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.brand}><td className="font-semibold">{row.brand}</td><td className="num text-right">{row.googlebot}</td><td className="num text-right">{row.adsbot}</td><td className="num text-right">{row.other}</td></tr>)}</tbody></table></div></Card>;
}
function Recent({
  scope
}: {
  scope: BrandScope;
}) {
  const headers = ['เวลา', 'เซสชัน', 'เหตุการณ์', 'โฮสต์', 'แบรนด์', 'แหล่งที่มา', 'แคมเปญ', 'อุปกรณ์', 'เบราว์เซอร์', 'ขั้น', 'ข้อผิดพลาด', 'บิลด์'];
  const rows = recentEvents.filter(row => isDisplayBrandInScope(row[4], scope));
  return <Card title="ทราฟฟิกล่าสุด (200 รายการล่าสุดในช่วง)" source={<SourceChip>D1 · traffic_events</SourceChip>} action={<Button size="sm" variant="secondary" icon={<Download aria-hidden="true" className="h-4 w-4" />}>ดาวน์โหลด CSV</Button>} bodyClassName="p-0"><p className="border-b border-line px-6 py-4 text-[13px] text-sub">เหตุการณ์ย้อนหลังจาก D1</p>{rows.length ? <div className="overflow-x-auto"><table className="min-w-[1460px]"><thead className="sticky top-0 z-10 bg-canvas"><tr>{headers.map(head => <th key={head} className="whitespace-nowrap">{head}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.join()}>{row.map((cell, index) => <td key={index} className={`whitespace-nowrap ${[0, 9].includes(index) ? 'num' : [1, 5, 6, 10, 11].includes(index) ? 'font-mono text-[13px]' : ''} ${index === 10 && cell !== '—' ? 'text-bad' : ''}`}>{index === 2 ? <span className="inline-flex items-center gap-1.5"><EventIcon name={cell} />{cell}</span> : index === 7 ? <span className="inline-flex items-center gap-1.5"><DeviceIcon device={cell} />{cell}</span> : cell}</td>)}</tr>)}</tbody></table></div> : <Empty label="ยังไม่มีทราฟฟิกในช่วงนี้" icon={Radio} />}</Card>;
}
function TrafficTable({
  scope
}: {
  scope: BrandScope;
}) {
  const rows = trafficRows.filter(row => isDisplayBrandInScope(row.brand, scope));
  const max = Math.max(...rows.map(row => row.visits), 1);
  return <div className="space-y-6"><Card title="ทราฟฟิกตามแบรนด์" source={<SourceChip>D1 · traffic</SourceChip>} action={<Button size="sm" variant="secondary" icon={<Download aria-hidden="true" className="h-4 w-4" />}>ดาวน์โหลด CSV</Button>} bodyClassName="p-0"><div className="hidden overflow-x-auto md:block"><table className="min-w-[720px]"><thead><tr>{['แบรนด์', 'ผู้เข้าเว็บ', 'ถึง /go', 'เปิดฟอร์ม', 'ลีด', 'แปลง %'].map(head => <th key={head}>{head}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.brand}><td className="font-semibold">{row.brand}</td><td><div className="flex min-w-[150px] items-center gap-3"><span className="num">{row.visits}</span><span className="h-1.5 flex-1 bg-canvas"><span className="block h-full bg-ink" style={{
                      width: `${row.visits / max * 100}%`
                    }} /></span></div></td><td className="num">{row.go}</td><td className="num">{row.forms}</td><td className="num">{row.leads}</td><td className="num">{(row.leads / row.visits * 100).toFixed(1)}%</td></tr>)}</tbody></table></div><ul className="divide-y divide-line md:hidden">{rows.map(row => <li key={row.brand} className="space-y-3 p-5"><p className="text-[16px] font-semibold">{row.brand}</p><dl className="grid grid-cols-3 gap-3"><Metric label="เข้า" value={row.visits} /><Metric label="ลีด" value={row.leads} /><Metric label="แปลง" value={`${(row.leads / row.visits * 100).toFixed(1)}%`} /></dl></li>)}</ul></Card><BotHits scope={scope} /></div>;
}
function Funnels({
  scope
}: {
  scope: BrandScope;
}) {
  return <div className="space-y-6">{trafficRows.filter(row => isDisplayBrandInScope(row.brand, scope)).slice(0, 3).map(row => <Card key={row.brand} title={row.brand} source={<SourceChip>D1 · traffic funnel</SourceChip>}><div className="grid grid-cols-2 gap-5 sm:grid-cols-4">{[['ผู้เข้าเว็บ', row.visits], ['ถึง /go', row.go], ['เปิดฟอร์ม', row.forms], ['ลีด', row.leads]].map(([label, value]) => <div key={label as string}><p className="text-[13px] font-medium text-sub">{label}</p><p className="num mt-2 text-[28px] font-semibold leading-none">{value}</p></div>)}</div></Card>)}</div>;
}
function Errors({
  scope
}: {
  scope: BrandScope;
}) {
  const rows = webErrors.filter(row => isDisplayBrandInScope(row.brand, scope));
  return <Card title="ข้อผิดพลาดฝั่งเว็บ" source={<SourceChip>D1 · client_errors</SourceChip>} bodyClassName="p-0">{rows.length ? <ul className="divide-y divide-line">{rows.map(row => <li key={`${row.time}-${row.brand}`} className="flex flex-wrap items-center gap-3 px-6 py-4"><span className="num text-[15px]">{row.time}</span><span className="text-[15px] font-semibold">{row.brand}</span><span className="font-mono text-[13px]">{row.error}</span><Chip tone={row.tone}>{row.level}</Chip></li>)}</ul> : <Empty label="ไม่มีข้อผิดพลาดในขอบเขตนี้" icon={Activity} />}</Card>;
}
function RangeToggle({
  value,
  onChange
}: {
  value: Range;
  onChange: (value: Range) => void;
}) {
  return <div role="group" className="flex rounded-xl border border-line bg-white p-1">{(['24 ชม.', '7 วัน', '30 วัน'] as Range[]).map(item => <button key={item} type="button" onClick={() => onChange(item)} className={`focus-ring min-h-[44px] rounded-lg px-3 text-[15px] ${value === item ? 'bg-ink font-semibold text-white' : 'text-sub'}`}>{item}</button>)}</div>;
}
function Metric({
  label,
  value
}: {
  label: string;
  value: string | number;
}) {
  return <div><dt className="text-[13px] text-sub">{label}</dt><dd className="num mt-1 text-[16px] font-semibold">{value}</dd></div>;
}
function Legend({
  color,
  label
}: {
  color: string;
  label: string;
}) {
  return <span className="inline-flex items-center gap-2"><span className={`h-3 w-3 rounded-sm ${color}`} />{label}</span>;
}
function Empty({
  label,
  icon: Icon
}: {
  label: string;
  icon: BoxIcon;
}) {
  return <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-6 py-10 text-center"><span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-canvas"><Icon aria-hidden="true" className="h-5 w-5 text-sub" /></span><p className="text-[15px] text-sub">{label}</p></div>;
}
function DeviceIcon({
  device
}: {
  device: string;
}) {
  const Icon = device === 'mobile' ? Smartphone : device === 'tablet' ? Tablet : Monitor;
  return <Icon aria-hidden="true" className="h-3.5 w-3.5" />;
}
function EventIcon({
  name
}: {
  name: string;
}) {
  const Icon = eventIcon(name);
  return <Icon aria-hidden="true" className="h-3.5 w-3.5 text-sub" />;
}
function eventIcon(name: string): BoxIcon {
  if (name.includes('landing')) return Eye;
  if (name.includes('form_step')) return ListChecks;
  if (name.includes('form')) return PencilLine;
  if (name.includes('gate')) return DoorOpen;
  if (name.includes('lead') || name.includes('ขายได้')) return Send;
  if (name.includes('redirect') || name.includes('error') || name.includes('ปฏิเสธ')) return Unlink;
  if (name.includes('Bot')) return Bot;
  return Activity;
}
function stageTone(stage: string): Tone {
  if (stage.includes('ปฏิเสธ') || stage.includes('error')) return 'danger';
  if (stage.includes('ขายได้') || stage === 'lead_submitted') return 'success';
  if (stage.includes('step') || stage.includes('gate')) return 'neutral';
  return 'info';
}
function matches(event: LiveEvent, filter: EventFilter) {
  if (filter === 'all') return true;
  if (filter === 'landing') return event.stage.includes('landing');
  if (filter === 'form') return event.stage.includes('form');
  if (filter === 'lead') return event.stage === 'lead_submitted';
  if (filter === 'postback') return event.stage.includes('LeadsGate');
  if (filter === 'bot') return !!event.bot;
  return !!event.error;
}
function groupSessions(events: LiveEvent[]): Session[] {
  const map = new Map<string, Session>();
  events.forEach(event => {
    const current = map.get(event.sessionRef);
    if (current) {
      current.events.push(event);
      current.time = event.time;
    } else map.set(event.sessionRef, {
      sessionRef: event.sessionRef,
      hostname: event.hostname,
      brand: event.brand,
      device: event.device,
      browser: event.browser,
      bot: event.bot,
      time: event.time,
      events: [event]
    });
  });
  return Array.from(map.values()).reverse();
}
function short(value: string) {
  return `${value.slice(0, 12)}…`;
}