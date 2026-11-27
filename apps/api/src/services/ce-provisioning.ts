import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type postgres from 'postgres';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { decryptSecret, encryptSecret, keyHint, sha256, upstreamKeyFingerprint } from '../lib/crypto.js';
import { CeManagement, CeManagementError, ceOrigin } from './ce-management.js';
import { refreshUpstreamCatalog } from './upstream-catalog.js';
import { ceBalanceProvider, recordProviderBalance, recordProviderBalanceFailure } from './provider-balances.js';
import { beginProviderKeySync, recordProviderKeyFailure, recordProviderKeys } from './provider-keys.js';

type Connection = postgres.ReservedSql;

interface Target {
  slug: string;
  groupId: number;
}

interface Pool {
  id: string;
  slug: string;
  baseUrl: string;
  freeSlots: number;
  quota: string | null;
}

type PricedPool = Pool & { quota: string };

interface Job {
  id: string;
  name: string;
  accountId: string;
  groupId: string;
  quota: string;
  encryptedKey: string;
  credentialId: string | null;
  attempts: number;
  retryAt: Date;
}

interface SessionRow {
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  expiresAt: Date;
}

type CeLogin = { email: string; password: string } | { refreshToken: string };

export interface CeProvisioningSettings {
  targets: Target[];
  freeSlots: number;
  login: CeLogin;
}

export function ceLogin(env = process.env): CeLogin {
  const email = env.CE_PROVISION_EMAIL?.trim();
  const password = env.CE_PROVISION_PASSWORD;
  const refreshToken = env.CE_PROVISION_REFRESH_TOKEN?.trim();
  if (email || password) {
    if (refreshToken || !email || !password) throw new Error('Set CE_PROVISION_EMAIL and CE_PROVISION_PASSWORD, or only CE_PROVISION_REFRESH_TOKEN');
    return { email, password };
  }
  if (refreshToken && /^\S{16,4096}$/.test(refreshToken)) return { refreshToken };
  throw new Error('Set CE_PROVISION_EMAIL and CE_PROVISION_PASSWORD in the worker environment');
}

export function ceProvisioningSettings(): CeProvisioningSettings | undefined {
  if (!config.CE_AUTO_PROVISION_KEYS) return;
  const targets = config.CE_PROVISION_GROUPS.split(',').map(entry => {
    const match = /^([a-z0-9-]{1,80}):(\d+)$/.exec(entry.trim());
    if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1) {
      throw new Error('CE_PROVISION_GROUPS must contain pool-slug:CE-group-id pairs');
    }
    return { slug: match[1]!, groupId: Number(match[2]) };
  });
  if (new Set(targets.map(target => target.slug)).size !== targets.length) {
    throw new Error('Set one CE group per pool in CE_PROVISION_GROUPS');
  }
  return { login: ceLogin(), targets, freeSlots: config.CE_PROVISION_FREE_SLOTS };
}

function ceSessionFingerprint(login: CeLogin): string {
  return 'refreshToken' in login ? sha256(login.refreshToken)
    : createHmac('sha256', Buffer.from(config.KEY_ENCRYPTION_SECRET, 'hex'))
      .update('ce-management\0').update(login.email.toLowerCase()).update('\0').update(login.password).digest('hex');
}

async function accessToken(db: Connection, ce: CeManagement, login: CeLogin, renew = false) {
  const fingerprint = ceSessionFingerprint(login);
  const [stored] = await db<SessionRow[]>`
    SELECT encrypted_access_token, encrypted_refresh_token, expires_at FROM ce_management_session WHERE bootstrap_hash = ${fingerprint}
  `;
  if (!renew && stored && stored.expiresAt.getTime() > Date.now() + 30_000) {
    return decryptSecret(stored.encryptedAccessToken);
  }
  let session;
  try {
    if (stored) session = await ce.refresh(decryptSecret(stored.encryptedRefreshToken));
    else if ('refreshToken' in login) session = await ce.refresh(login.refreshToken);
    else session = await ce.login(login.email, login.password);
  } catch (error) {
    if (!stored || !('email' in login) || !(error instanceof CeManagementError) || ![400, 401].includes(error.status ?? 0)) throw error;
    session = await ce.login(login.email, login.password);
  }
  await db`
    INSERT INTO ce_management_session (bootstrap_hash, encrypted_access_token, encrypted_refresh_token, expires_at)
    VALUES (${fingerprint}, ${encryptSecret(session.access_token)}, ${encryptSecret(session.refresh_token)},
      ${new Date(Date.now() + session.expires_in * 1000)})
    ON CONFLICT (bootstrap_hash) DO UPDATE SET encrypted_access_token = EXCLUDED.encrypted_access_token,
      encrypted_refresh_token = EXCLUDED.encrypted_refresh_token, expires_at = EXCLUDED.expires_at
  `;
  return session.access_token;
}

async function eligiblePools(db: Connection, slugs: string[], freeSlotsTarget: number) {
  return db<Pool[]>`
    SELECT pool.id, pool.slug, pool.base_url,
      COALESCE((SELECT sum(COALESCE(slot.free_slots, ${freeSlotsTarget}::int))
        FROM sellable_upstream_slots slot JOIN upstream_credentials uc ON uc.id = slot.id
        WHERE slot.pool_id = pool.id AND NOT slot.test_only
          AND (uc.spend_limit IS NULL OR uc.spend_limit - uc.spend_used - COALESCE((
            SELECT sum(lease.reserved_cost) FROM request_leases lease
            WHERE lease.upstream_credential_id = uc.id AND lease.expires_at > now()
          ), 0) >= (SELECT max(product.wholesale_credits) FROM pool_channels channels
            JOIN products product ON product.pool_id = channels.root_pool_id WHERE channels.pool_id = pool.id AND product.active))
      ), 0)::int AS free_slots,
      (SELECT (max(product.wholesale_credits) * pool.credential_capacity)::text
        FROM pool_channels channels JOIN products product ON product.pool_id = channels.root_pool_id
      WHERE channels.pool_id = pool.id AND product.active) AS quota
    FROM upstream_pools pool WHERE pool.active AND pool.slug IN ${db(slugs)}
      AND EXISTS (SELECT 1 FROM priced_pool_models rate WHERE rate.pool_id = pool.id)
  `;
}

async function prepareJob(db: Connection, pool: PricedPool, accountId: number, groupId: number): Promise<Job> {
  // Persist the label and secret before sending the create request. Recovery reuses both.
  const jobId = randomUUID();
  const name = `ksapi-${pool.slug.slice(0, 38)}-${jobId}`;
  const key = `sk-${randomBytes(32).toString('hex')}`;
  const [job] = await db<Job[]>`
    INSERT INTO ce_key_provisioning_jobs (pool_id, id, name, account_id, group_id, quota, encrypted_key)
    VALUES (${pool.id}, ${jobId}, ${name}, ${accountId}, ${groupId}, ${pool.quota}, ${encryptSecret(key)})
    RETURNING id, name, account_id, group_id, quota::text, encrypted_key, credential_id, attempts, retry_at
  `;
  if (!job) throw new Error('Could not save the CE key provisioning job');
  return job;
}

async function retryJob(db: Connection, job: Job, code: string) {
  const delaySeconds = Math.min(3600, 60 * 2 ** Math.min(job.attempts, 6));
  await db`UPDATE ce_key_provisioning_jobs SET attempts = attempts + 1,
    last_error = ${code}, retry_at = now() + make_interval(secs => ${delaySeconds}) WHERE id = ${job.id}`;
}

async function addCredential(db: Connection, pool: Pool, job: Job, key: string, used: number) {
  const fingerprint = upstreamKeyFingerprint(key);
  const [inserted] = await db<{ id: string }[]>`
    INSERT INTO upstream_credentials (pool_id, label, encrypted_key, key_hint, key_fingerprint, spend_limit, spend_used)
    VALUES (${pool.id}, ${job.name}, ${job.encryptedKey}, ${keyHint(key)}, ${fingerprint}, ${job.quota}, ${String(used)})
    ON CONFLICT (key_fingerprint) WHERE key_fingerprint IS NOT NULL DO NOTHING RETURNING id
  `;
  const [existing] = inserted ? [inserted] : await db<{ id: string }[]>`
    SELECT id FROM upstream_credentials WHERE pool_id = ${pool.id} AND key_fingerprint = ${fingerprint} AND NOT test_only
  `;
  if (!existing) throw new CeManagementError('CE_KEY_POOL_CONFLICT');
  await db`UPDATE ce_key_provisioning_jobs SET credential_id = ${existing.id} WHERE id = ${job.id}`;
  return existing.id;
}

async function runJob(db: Connection, ce: CeManagement, access: string, pool: PricedPool, job: Job, canCreate: boolean,
  checkCatalog: typeof refreshUpstreamCatalog) {
  let credentialId = job.credentialId;
  if (!credentialId) {
    const key = decryptSecret(job.encryptedKey);
    let remote = await ce.keyByName(access, job.name);
    if (!remote) {
      if (!canCreate) return 'CE_LOW_BALANCE';
      remote = await ce.createKey(access, { id: job.id, name: job.name, groupId: Number(job.groupId), key, quota: Number(job.quota) });
    }
    if (remote.name !== job.name || remote.key !== key || remote.group_id !== Number(job.groupId)
      || !new Decimal(remote.quota).eq(job.quota) || remote.status !== 'active' || remote.quota_used >= remote.quota) {
      throw new CeManagementError('CE_KEY_RESPONSE_MISMATCH');
    }
    credentialId = await addCredential(db, pool, job, key, remote.quota_used);
  }
  await checkCatalog(credentialId);
  const [status] = await db<{ available: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM sellable_upstream_slots WHERE id = ${credentialId} AND NOT test_only) AS available
  `;
  if (!status?.available) return 'CE_CATALOG_NOT_READY';
  await db`DELETE FROM ce_key_provisioning_jobs WHERE id = ${job.id}`;
}

async function withCeLock<T>(run: (db: Connection) => Promise<T>): Promise<T | undefined> {
  const db = await sql.reserve();
  const lock = 0x4345504b;
  let acquired = false;
  try {
    const [row] = await db<{ acquired: boolean }[]>`SELECT pg_try_advisory_lock(${lock}) AS acquired`;
    acquired = Boolean(row?.acquired);
    if (!acquired) return;
    return await run(db);
  } finally {
    try { if (acquired) await db`SELECT pg_advisory_unlock(${lock})`; }
    finally { db.release(); }
  }
}

async function openCeAccount(db: Connection, ce: CeManagement, login: CeLogin) {
  let access = await accessToken(db, ce, login);
  const account = await ce.account(access).catch(async error => {
    if (!(error instanceof CeManagementError) || error.status !== 401) throw error;
    access = await accessToken(db, ce, login, true);
    return ce.account(access);
  });
  return { access, account };
}

async function openCeSession(db: Connection, ce: CeManagement, login: CeLogin) {
  const { access, account } = await openCeAccount(db, ce, login);
  return { access, account, groups: await ce.groups(access) };
}

export async function checkCeBalance(login: CeLogin, request: typeof fetch = fetch): Promise<void> {
  await withCeLock(async db => {
    try {
      const { account } = await openCeAccount(db, new CeManagement(request), login);
      await recordProviderBalance(ceBalanceProvider, account.balance);
    } catch (error) {
      await recordProviderBalanceFailure(ceBalanceProvider, ceProvisioningErrorCode(error));
    }
  });
}

export async function syncCeKeys(login: CeLogin, request: typeof fetch = fetch): Promise<void> {
  await withCeLock(async db => {
    const startedAt = await beginProviderKeySync();
    try {
      const ce = new CeManagement(request);
      const { access, account } = await openCeAccount(db, ce, login);
      const keys = await ce.keys(access);
      await recordProviderKeys(account.id, keys, startedAt);
      await recordProviderBalance(ceBalanceProvider, account.balance);
    } catch (error) {
      await recordProviderKeyFailure(ceProvisioningErrorCode(error), startedAt);
    }
  });
}

export async function listCeGroups(login: CeLogin) {
  const ce = new CeManagement();
  return withCeLock(async (db) => {
    const { account, groups } = await openCeSession(db, ce, login);
    return { balanceUsd: account.balance, groups: groups.map(group => ({ id: group.id, name: group.name, paygo: group.subscription_type === 'standard' })) };
  });
}

export async function provisionCeKeys(settings: CeProvisioningSettings, request: typeof fetch = fetch): Promise<void> {
  if (!settings.targets.length) return;
  const ce = new CeManagement(request);
  await withCeLock(async (db) => {
    const poolRows = await eligiblePools(db, settings.targets.map(target => target.slug), settings.freeSlots);
    const jobs = await db<(Job & { poolId: string })[]>`
      SELECT pool_id, id, name, account_id, group_id, quota::text, encrypted_key, credential_id, attempts, retry_at
      FROM ce_key_provisioning_jobs
    `;
    const needed = settings.targets.flatMap(target => {
      const pool = poolRows.find(row => row.slug === target.slug);
      if (!pool || !pool.quota || pool.baseUrl.replace(/\/+$/, '') !== ceOrigin) {
        console.warn(`CE key provisioning skipped for ${target.slug}: CE_POOL_NOT_READY`);
        return [];
      }
      const job = jobs.find(row => row.poolId === pool.id);
      if (job && Number(job.groupId) !== target.groupId) {
        console.warn(`CE key provisioning skipped for ${pool.slug}: CE_PENDING_GROUP_MISMATCH`);
        return [];
      }
      if (job && job.retryAt.getTime() > Date.now()) return [];
      return job || pool.freeSlots < settings.freeSlots ? [{ target, pool: { ...pool, quota: pool.quota }, job }] : [];
    });
    if (!needed.length) return;

    const { access, account, groups } = await openCeSession(db, ce, settings.login);
    for (const item of needed) {
      if (item.job && Number(item.job.accountId) !== account.id) {
        console.warn(`CE key provisioning skipped for ${item.pool.slug}: CE_PENDING_ACCOUNT_MISMATCH`);
        continue;
      }
      const group = groups.find(group => group.id === item.target.groupId);
      if (!group || group.subscription_type !== 'standard') {
        console.warn(`CE key provisioning skipped for ${item.pool.slug}: CE_PAYGO_GROUP_UNAVAILABLE`);
        continue;
      }
      const quota = item.job?.quota ?? item.pool.quota;
      const canCreate = new Decimal(account.balance).gte(quota);
      if (!item.job && !canCreate) {
        console.warn(`CE key provisioning skipped for ${item.pool.slug}: CE_LOW_BALANCE`);
        continue;
      }
      const job = item.job ?? await prepareJob(db, item.pool, account.id, item.target.groupId);
      let issue: string | undefined;
      try { issue = await runJob(db, ce, access, item.pool, job, canCreate, (id) => refreshUpstreamCatalog(id, request)); }
      catch (error) { issue = ceProvisioningErrorCode(error); }
      if (issue) {
        await retryJob(db, job, issue);
        console.warn(`CE key provisioning delayed for ${item.pool.slug}: ${issue}`);
      }
    }
  });
}

export function ceProvisioningErrorCode(error: unknown) {
  if (!(error instanceof CeManagementError)) return 'CE_PROVISIONING_FAILED';
  return error.status ? `${error.code}_${error.status}` : error.code;
}
