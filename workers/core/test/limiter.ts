import { WorkerEntrypoint } from "cloudflare:workers";

// Stand-in for a Workers Rate Limiting binding with the same `limit({ key })` shape. It counts per
// key with no clock, so tests do not depend on when the wall-clock minute rolls over. The limit and
// binding name arrive as service binding props; `fail` makes every call throw.
interface Props { name: string; limit: number; fail?: boolean }
const counts = new Map<string, number>();
const calls: Array<{ binding: string; key: string }> = [];

export class Limiter extends WorkerEntrypoint<Record<string, never>, Props> {
  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const { name, limit, fail } = this.ctx.props;
    if (fail) throw new Error("limiter unavailable");
    calls.push({ binding: name, key });
    const count = (counts.get(`${name}\n${key}`) ?? 0) + 1;
    counts.set(`${name}\n${key}`, count);
    return { success: count <= limit };
  }
}

/** GET /calls lists every limit() call; POST /reset clears counts and calls. */
export default {
  fetch(request: Request): Response {
    if (request.method === "POST") { counts.clear(); calls.length = 0; return new Response(null, { status: 204 }); }
    return Response.json(calls);
  },
};
