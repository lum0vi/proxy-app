import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usePreferences } from '../lib/preferences';
import { money } from '../lib/store';
import { useRemote } from '../lib/useRemote';

interface ProviderKey {
  externalId: string; name: string; keyHint: string; groupId: string | null; groupName: string | null;
  status: string; active: boolean; present: boolean; quotaUsd: string | null; quotaUsedUsd: string; remainingUsd: string | null;
  checkedAt: string; expiresAt: string | null; credentialId: string | null; credentialLabel: string | null;
  customerKeys: { keyId: string; keyHint: string; label: string; userId: string; email: string; remainingUsdt: string }[];
}
interface Inventory {
  keys: ProviderKey[]; total: number; page: number; pageSize: number;
  sync: { enabled: boolean; requested: boolean; stale: boolean; checkedAt: string | null; lastError: string | null; intervalMs: number };
}

function Pages({ page, total, size, busy, change }: { page: number; total: number; size: number; busy: boolean; change(page: number): void }) {
  const { locale } = usePreferences();
  return <div className="card-actions">
    <button className="button ghost small" disabled={busy || page <= 1} onClick={() => change(page - 1)}>{locale === 'ru' ? 'Назад' : 'Previous'}</button>
    <span>{page} / {Math.max(1, Math.ceil(total / size))}</span>
    <button className="button ghost small" disabled={busy || page * size >= total} onClick={() => change(page + 1)}>{locale === 'ru' ? 'Далее' : 'Next'}</button>
  </div>;
}

export function ProviderKeys() {
  const { locale } = usePreferences(), ru = locale === 'ru';
  const [activeOnly, setActiveOnly] = useState(true), [page, setPage] = useState(1);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const remote = useRemote(() => api<Inventory>(`/api/admin/provider-keys?activeOnly=${activeOnly}&page=${page}`), [activeOnly, page]);
  const { reload } = remote;
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) void reload(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [reload]);
  const data = remote.data;
  async function sync() {
    setBusy(true); setError('');
    try { await api('/api/admin/provider-keys/refresh', { method: 'POST' }); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <section className="panel">
    <div className="panel-head"><h2>{ru ? 'Ключи в аккаунте CE' : 'Keys in the CE account'}</h2>
      <button className="button ghost small" disabled={busy || !data?.sync.enabled || data.sync.requested} onClick={() => void sync()}><RefreshCw size={15}/>{ru ? 'Синхронизировать с CE' : 'Sync from CE'}</button>
    </div>
    <p className="form-hint">{ru ? 'Остаток CE общий для привязанных клиентских ключей. Баланс покупателя в USDT показан отдельно. Здесь нет полных секретов ключей.' : 'The CE balance is shared by linked customer keys. Each customer balance in USDT is shown separately. Full key secrets are not displayed here.'}</p>
    {data && !data.sync.enabled && <p className="form-hint">{ru ? 'Включите CE_KEY_SYNC_ENABLED и укажите доступ к аккаунту в .env.ce. Автовыпуск CE также включает синхронизацию.' : 'Enable CE_KEY_SYNC_ENABLED and set account credentials in .env.ce. Automatic CE provisioning also enables sync.'}</p>}
    {data?.sync.requested && <p role="status">{ru ? 'Обновление в очереди worker. Обычно начинается в течение минуты.' : 'Refresh queued for the worker. It normally starts within a minute.'}</p>}
    {data?.sync.checkedAt && <p className="form-hint">{ru ? 'Проверено: ' : 'Checked: '}{new Date(data.sync.checkedAt).toLocaleString(locale)}</p>}
    {data?.sync.stale && <div className="info-box"><p>{ru ? 'Нет свежего подтверждения CE. Ниже — последний сохранённый снимок, если он есть.' : 'There is no fresh CE confirmation. The last saved snapshot is shown when available.'}{data.sync.lastError && ` (${data.sync.lastError})`}</p></div>}
    {(error || remote.error) && <p className="form-error" role="alert">{error || remote.error}</p>}
    <label className="inventory-filter"><input type="checkbox" checked={activeOnly} onChange={event => { setActiveOnly(event.target.checked); setPage(1); }}/>{ru ? 'Только активные с неиспользованным лимитом' : 'Only active keys with remaining allowance'}</label>
    <div className="table-scroll"><table><thead><tr>{(ru
      ? ['Ключ CE', 'Статус', 'Использовано / лимит, USD', 'Осталось, USD', 'Привязанные активные ключи клиентов']
      : ['CE key', 'Status', 'Used / limit, USD', 'Remaining, USD', 'Linked active customer keys']).map(label => <th key={label}>{label}</th>)}</tr></thead>
      <tbody>{data?.keys.map(key => <tr key={key.externalId + key.checkedAt}>
        <td><b>{key.name}</b><small className="catalog-status">#{key.externalId} · {key.groupName ?? key.groupId ?? '—'}</small><code>{key.keyHint}</code></td>
        <td><span className={`status-pill ${key.active ? 'active' : 'disabled'}`}><i/>{key.present ? key.status : ru ? 'Нет в аккаунте' : 'No longer listed'}</span>
          {key.expiresAt && <small className="catalog-status">{new Date(key.expiresAt).toLocaleString(locale)}</small>}</td>
        <td>{money(key.quotaUsedUsd, locale, 'USD', 4)} / {key.quotaUsd === null ? (ru ? 'Без лимита ключа' : 'No key limit') : money(key.quotaUsd, locale, 'USD')}</td>
        <td>{key.remainingUsd === null ? (ru ? 'Общий счёт / подписка' : 'Account / subscription') : money(key.remainingUsd, locale, 'USD', 4)}</td>
        <td>{key.customerKeys.map(customer => <div className="provider-key-customer" key={customer.keyId}><Link to={`/admin/users/${customer.userId}/keys`}>{customer.email}</Link><small>{customer.keyHint} · {money(customer.remainingUsdt, locale, 'USDT', 4)}</small></div>)}
          {!key.customerKeys.length && (key.credentialId ? (ru ? 'Нет активных клиентских ключей' : 'No active customer keys') : (ru ? 'Не подключён к Ksapi' : 'Not connected to Ksapi'))}</td>
      </tr>)}</tbody></table></div>
    {data && !data.keys.length && <p>{ru ? 'Ключей по этому фильтру пока нет.' : 'No keys match this filter.'}</p>}
    <Pages page={page} total={data?.total ?? 0} size={data?.pageSize ?? 25} busy={remote.loading} change={setPage}/>
  </section>;
}

interface UserKey {
  id: string; label: string; keyHint: string; status: string; active: boolean; creditsTotal: string; creditsUsed: string;
  remainingUsdt: string; expiresAt: string | null;
  upstreams: { id: string; label: string; keyHint: string; status: string; providerName: string;
    localRemainingUsd: string | null; externalId: string | null; remoteStatus: string | null; remotePresent: boolean | null;
    remoteQuotaUsd: string | null; remoteRemainingUsd: string | null; remoteStale: boolean; remoteCheckedAt: string | null; sharedKeyCount: number }[];
}
interface UserKeys { user: { id: string; email: string; name: string | null }; keys: UserKey[]; total: number; pageSize: number }

export function AdminUserKeys() {
  const { id } = useParams();
  const { locale } = usePreferences(), ru = locale === 'ru';
  const [activeOnly, setActiveOnly] = useState(true), [page, setPage] = useState(1);
  const remote = useRemote(() => api<UserKeys>(`/api/admin/users/${id}/keys?activeOnly=${activeOnly}&page=${page}`), [id, activeOnly, page]);
  const data = remote.data?.user.id === id ? remote.data : null;
  return <>
    <div className="page-title"><div><p>{data?.user.email}</p><h1>{ru ? 'Ключи пользователя' : 'User keys'}</h1></div><Link className="button ghost" to="/admin/users">{ru ? 'Пользователи' : 'Users'}</Link></div>
    <section className="panel">
      <div className="panel-head"><label className="inventory-filter"><input type="checkbox" checked={activeOnly} onChange={event => { setActiveOnly(event.target.checked); setPage(1); }}/>{ru ? 'Только активные с остатком' : 'Only active keys with a balance'}</label>
        <button className="button ghost small" disabled={remote.loading} onClick={() => void remote.reload()}><RefreshCw size={15}/>{ru ? 'Обновить' : 'Refresh'}</button></div>
      {remote.error && <p className="form-error" role="alert">{remote.error}</p>}
      <p className="form-hint">{ru ? 'Баланс клиента — в USDT. Остатки поставщика — в его исходных USD и могут быть общими для нескольких клиентов.' : 'Customer balances are in USDT. Provider balances are in native USD and may be shared by several customers.'}</p>
      <div className="table-scroll"><table><thead><tr>{(ru ? ['Ключ', 'Статус', 'Зачислено', 'Потрачено', 'Осталось', 'Ключи провайдера']
        : ['Key', 'Status', 'Credited', 'Used', 'Remaining', 'Provider keys']).map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{data?.keys.map(key => <tr key={key.id}>
          <td><b>{key.label}</b><small className="catalog-status"><code>{key.keyHint}</code></small>{key.expiresAt && <small>{new Date(key.expiresAt).toLocaleString(locale)}</small>}</td>
          <td><span className={`status-pill ${key.active ? 'active' : 'disabled'}`}><i/>{key.status}</span></td>
          <td>{money(key.creditsTotal, locale)}</td><td>{money(key.creditsUsed, locale, 'USDT', 8)}</td><td>{money(key.remainingUsdt, locale, 'USDT', 8)}</td>
          <td>{key.upstreams.map(upstream => <div className="provider-key-customer" key={upstream.id}>
            <b>{upstream.providerName} · {upstream.label}</b><code>{upstream.keyHint}</code>
            <small>{upstream.externalId ? `CE #${upstream.externalId} · ${upstream.remotePresent ? upstream.remoteStatus : ru ? 'нет в аккаунте' : 'no longer listed'}` : upstream.status}</small>
            {upstream.externalId ? <small>{ru ? 'Остаток CE: ' : 'CE remaining: '}{upstream.remoteRemainingUsd === null ? (ru ? 'нет индивидуального лимита' : 'no individual limit') : money(upstream.remoteRemainingUsd, locale, 'USD', 4)}
              {upstream.remoteStale && (ru ? ' · устаревшие данные' : ' · stale data')}{upstream.remoteCheckedAt && ` · ${new Date(upstream.remoteCheckedAt).toLocaleString(locale)}`}</small>
              : <small>{ru ? 'По учёту Ksapi: ' : 'Ksapi accounting: '}{upstream.localRemainingUsd === null ? (ru ? 'лимит не задан' : 'no limit set') : money(upstream.localRemainingUsd, locale, 'USD', 4)}</small>}
            <small>{ru ? 'Активных клиентских ключей на этом ключе провайдера: ' : 'Active customer keys sharing this provider key: '}{upstream.sharedKeyCount}</small>
          </div>)}</td>
        </tr>)}</tbody></table></div>
      {data && !data.keys.length && <p>{ru ? 'У пользователя нет ключей по выбранному фильтру.' : 'This user has no keys matching this filter.'}</p>}
      <Pages page={page} total={data?.total ?? 0} size={data?.pageSize ?? 25} busy={remote.loading} change={setPage}/>
    </section>
  </>;
}
