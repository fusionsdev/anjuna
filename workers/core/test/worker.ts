import { BrandId } from "@anjuna/contracts";
import { ownsBrand } from "../src/auth.js";
import { AdminService, createCoreHandler } from "../src/index.js";
import { json } from "../src/http.js";

export { AdminService };
export class TestAdminService extends AdminService {
  protected override async handleAdmin(): Promise<Response> {
    return json({ reached: "service-binding" });
  }
}

export default createCoreHandler(new Map([
  ["/rpc/test", async (request, env, account) => {
    const body = await request.json<{ brand_id?: unknown }>();
    const parsed = BrandId.safeParse(body.brand_id);
    if (!parsed.success) return json({ error: "invalid" }, 400);
    if (!await ownsBrand(env, account, parsed.data)) return json({ error: "forbidden_brand" }, 403);
    return json({ ok: true, account });
  }],
]));
