import { DurableObject } from "cloudflare:workers";
import { TrafficTailEvent } from "@anjuna/contracts";

const encode = (value: string) => new TextEncoder().encode(value);
const frame = (event: TrafficTailEvent) => `id: ${event.event_id}\nevent: event\ndata: ${JSON.stringify(event)}\n\n`;
type Client = { writer: WritableStreamDefaultWriter<Uint8Array>; brands: Set<string>; pending: number };

/** Ephemeral observation only. No visitor response reads this state. */
export class TrafficTail extends DurableObject {
  private ring: TrafficTailEvent[] = [];
  private ids = new Set<string>();
  private clients = new Set<Client>();

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (["/push", "/internal/traffic-tail/push"].includes(url.pathname) && request.method === "POST") {
      const parsed = TrafficTailEvent.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return new Response("invalid event", { status: 400 });
      const event = parsed.data;
      if (this.ids.has(event.event_id)) return Response.json({ status: "duplicate" });
      this.ids.add(event.event_id);
      this.ring.push(event);
      if (this.ring.length > 500) this.ids.delete(this.ring.shift()!.event_id);
      for (const client of this.clients) if (this.matches(client, event)) this.write(client, frame(event));
      return Response.json({ status: "ok" });
    }
    if (url.pathname !== "/sse" || request.method !== "GET") return new Response("not found", { status: 404 });
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const client: Client = { writer: stream.writable.getWriter(), brands: new Set(url.searchParams.getAll("brand").flatMap(b => b.split(",")).filter(Boolean)), pending: 0 };
    this.clients.add(client);
    const lastId = request.headers.get("last-event-id");
    const lastIndex = this.ring.findIndex(e => e.event_id === lastId);
    const replay = this.ring.slice(lastIndex + 1).filter(e => this.matches(client, e));
    this.write(client, "retry: 3000\n: connected\n\n" + replay.map(frame).join(""));
    request.signal.addEventListener("abort", () => this.drop(client), { once: true });
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 15_000);
    return new Response(stream.readable, { headers: {
      "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no",
    } });
  }

  private matches(client: Client, event: TrafficTailEvent): boolean { return !client.brands.size || client.brands.has(event.brand); }
  private write(client: Client, value: string): void {
    if (client.pending >= 50) { this.drop(client); return; }
    client.pending++;
    void client.writer.write(encode(value)).catch(() => this.drop(client)).finally(() => { client.pending--; });
  }
  private drop(client: Client): void {
    if (!this.clients.delete(client)) return;
    void client.writer.abort().catch(() => {});
  }
  /** Alarms continue after fetch returns; interval timers need an active request in production. */
  override async alarm(): Promise<void> {
    for (const client of this.clients) this.write(client, `event: ping\ndata: {"ts":${Date.now()}}\n\n`);
    if (this.clients.size) await this.ctx.storage.setAlarm(Date.now() + 15_000);
  }
}
