export interface ListmonkSubscriber {
  id: number;
  email: string;
  name: string;
  status: string; // 'enabled' | 'blocklisted' | etc.
  attribs?: Record<string, any>;
}

export interface ListmonkList {
  id: number;
  name: string;
  tags?: string[];
}

/** The two list calls the install workflow needs; tests pass a fake. */
export type ListmonkLists = Pick<ListmonkClient, "findLists" | "createList">;

export class ListmonkClient {
  constructor(
    private readonly url: string,
    private readonly user: string,
    private readonly token: string
  ) {}

  private get authHeader(): string {
    return "Basic " + btoa(`${this.user}:${this.token}`);
  }

  private async fetchApi(path: string, init?: RequestInit): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.url}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
    return res;
  }

  async findByEmail(email: string): Promise<ListmonkSubscriber | null> {
    const q = `subscribers.email='${email.replace(/'/g, "''")}'`;
    const res = await this.fetchApi(`/api/subscribers?per_page=1&query=${encodeURIComponent(q)}`);
    if (!res.ok) {
      if (res.status === 404) return null; // Just in case
      throw new Error(`listmonk query by email failed: ${res.status} ${await res.text()}`);
    }
    const json = await res.json() as any;
    return json?.data?.results?.[0] || null;
  }

  async createSubscriber(payload: {
    email: string;
    name: string;
    lists: number[];
    attribs: Record<string, any>;
  }): Promise<ListmonkSubscriber> {
    const res = await this.fetchApi(`/api/subscribers`, {
      method: "POST",
      body: JSON.stringify({
        email: payload.email,
        name: payload.name,
        status: "enabled",
        lists: payload.lists,
        attribs: payload.attribs,
        preconfirm_subscriptions: true, // We have consent, they are confirmed
      }),
    });
    if (!res.ok) {
      throw new Error(`listmonk POST failed: ${res.status} ${await res.text()}`);
    }
    const json = await res.json() as any;
    return json.data;
  }

  async updateSubscriber(id: number, payload: {
    name: string;
    attribs: Record<string, any>;
  }): Promise<ListmonkSubscriber> {
    const res = await this.fetchApi(`/api/subscribers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: payload.name,
        attribs: payload.attribs,
      }),
    });
    if (!res.ok) {
      throw new Error(`listmonk PATCH failed: ${res.status} ${await res.text()}`);
    }
    const json = await res.json() as any;
    return json.data;
  }

  /** Lists whose name matches `name` exactly. listmonk's `query` is a substring search, so the exact match is done here. */
  async findLists(name: string): Promise<ListmonkList[]> {
    const params = new URLSearchParams({ query: name, per_page: "100" });
    const res = await this.fetchApi(`/api/lists?${params.toString()}`);
    if (!res.ok) throw new Error(`listmonk GET lists failed: ${res.status}`);
    const json = await res.json() as { data?: { results?: ListmonkList[] } };
    return (json?.data?.results ?? []).filter((list) => list.name === name);
  }

  /** A private, single opt-in list: subscribers come from the lead form with recorded consent. */
  async createList(payload: { name: string; tags: string[] }): Promise<ListmonkList> {
    const res = await this.fetchApi(`/api/lists`, {
      method: "POST",
      body: JSON.stringify({ name: payload.name, type: "private", optin: "single", tags: payload.tags }),
    });
    if (!res.ok) throw new Error(`listmonk POST list failed: ${res.status}`);
    const json = await res.json() as { data?: ListmonkList };
    if (!json?.data || !Number.isInteger(json.data.id) || json.data.id <= 0) throw new Error("listmonk POST list returned no list id");
    return json.data;
  }

  async getSuppressions(page: number, perPage: number, reason: 'blocklisted' | 'unsubscribed', listId?: number): Promise<{ emails: string[], total: number }> {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("per_page", String(perPage));
    
    if (reason === 'blocklisted') {
      params.set("query", "subscribers.status='blocklisted'");
    } else if (reason === 'unsubscribed') {
      params.set("subscription_status", "unsubscribed");
      if (listId) params.set("list_id", String(listId));
    }

    const res = await this.fetchApi(`/api/subscribers?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`listmonk GET suppressions failed: ${res.status} ${await res.text()}`);
    }
    
    const json = await res.json() as any;
    const emails = (json?.data?.results || []).map((s: any) => s.email.toLowerCase());
    return { emails, total: json?.data?.total || 0 };
  }
}
