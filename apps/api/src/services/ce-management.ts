import { z } from 'zod';

export const ceOrigin = 'https://codex-everywhere.com';
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const usd = z.number().finite().nonnegative();
const token = z.string().min(16).max(4096).regex(/^\S+$/);

const accountSchema = z.object({ id, balance: usd });
const groupsSchema = z.array(z.object({ id, name: z.string(), subscription_type: z.string() }));
const keySchema = z.object({
  id, name: z.string(), group_id: id, key: token, quota: usd, quota_used: usd,
  status: z.string(),
});
const keyListSchema = z.object({
  items: z.array(z.object({ id, name: z.string() })),
  total: z.number().int().nonnegative(),
});
const date = z.string().refine(value => Number.isFinite(Date.parse(value))).nullable().optional();
const inventoryKeySchema = z.object({
  id, name: z.string(), group_id: id.nullable().optional(), key: token, quota: usd, quota_used: usd,
  status: z.string(), expires_at: date, last_used_at: date,
  group: z.object({ name: z.string() }).nullable().optional(),
});
const inventoryPageSchema = z.object({ items: z.array(inventoryKeySchema), total: z.number().int().nonnegative() });
export type CeInventoryKey = z.infer<typeof inventoryKeySchema>;
const sessionSchema = z.object({
  access_token: token, refresh_token: token,
  expires_in: z.number().int().positive().max(365 * 86400),
});

export class CeManagementError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
  }
}

export class CeManagement {
  constructor(private readonly fetchRequest: typeof fetch = fetch) {}

  private async request<T>(path: string, schema: z.ZodType<T>, accessToken?: string, payload?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const headers = new Headers({ accept: 'application/json', 'accept-language': 'en', 'x-user-ui-request': '1' });
    if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
    if (payload) headers.set('content-type', 'application/json');
    if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
    const signal = AbortSignal.timeout(10_000);
    let response: Response;
    try {
      response = await this.fetchRequest(`${ceOrigin}/api/v1${path}`, {
        method: payload ? 'POST' : 'GET', headers,
        ...(payload && { body: JSON.stringify(payload) }), redirect: 'error', signal,
      });
    } catch {
      throw new CeManagementError(signal.aborted ? 'CE_TIMEOUT' : 'CE_UNREACHABLE');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CeManagementError('CE_HTTP_ERROR', response.status);
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw new CeManagementError('CE_INVALID_RESPONSE'); }
    const envelope = z.object({ code: z.literal(0), data: schema }).safeParse(body);
    if (!envelope.success) throw new CeManagementError('CE_INVALID_RESPONSE');
    return envelope.data.data;
  }

  async refresh(refreshToken: string) {
    return this.request('/auth/refresh', sessionSchema, undefined, { refresh_token: refreshToken });
  }

  async login(email: string, password: string) {
    const session = await this.request('/auth/login', z.union([
      sessionSchema, z.object({ requires_2fa: z.literal(true) }),
    ]), undefined, { email, password });
    if ('requires_2fa' in session) throw new CeManagementError('CE_LOGIN_REQUIRES_2FA');
    return session;
  }

  async account(accessToken: string) {
    return this.request('/auth/me', accountSchema, accessToken);
  }

  async groups(accessToken: string) {
    return this.request('/groups/available', groupsSchema, accessToken);
  }

  async keys(accessToken: string): Promise<CeInventoryKey[]> {
    const result: CeInventoryKey[] = [];
    const seen = new Set<number>();
    let total: number | undefined;
    for (let page = 1; page <= 100; page++) {
      const query = new URLSearchParams({ page: String(page), page_size: '100', sort_by: 'created_at', sort_order: 'asc' });
      const batch = await this.request(`/keys?${query}`, inventoryPageSchema, accessToken);
      if (batch.total > 10_000) throw new CeManagementError('CE_KEY_LIST_TOO_LARGE');
      if (total !== undefined && batch.total !== total) throw new CeManagementError('CE_KEY_LIST_CHANGED');
      total = batch.total;
      for (const key of batch.items) {
        if (seen.has(key.id)) throw new CeManagementError('CE_KEY_LIST_CHANGED');
        seen.add(key.id);
        result.push(key);
      }
      if (result.length === total) return result;
      if (result.length > total || batch.items.length === 0) throw new CeManagementError('CE_KEY_LIST_CHANGED');
    }
    throw new CeManagementError('CE_KEY_LIST_TOO_LARGE');
  }

  async keyByName(accessToken: string, name: string) {
    const query = new URLSearchParams({ search: name, page: '1', page_size: '20' });
    const keys = await this.request(`/keys?${query}`, keyListSchema, accessToken);
    const matches = keys.items.filter(key => key.name === name);
    if (matches.length > 1 || keys.total > keys.items.length) throw new CeManagementError('CE_KEY_NOT_UNIQUE');
    return matches[0] ? this.request(`/keys/${matches[0].id}`, keySchema, accessToken) : undefined;
  }

  async createKey(accessToken: string, job: { id: string; name: string; groupId: number; key: string; quota: number }) {
    return this.request('/keys', keySchema, accessToken, {
      name: job.name, group_id: job.groupId, custom_key: job.key, quota: job.quota,
    }, job.id);
  }
}
