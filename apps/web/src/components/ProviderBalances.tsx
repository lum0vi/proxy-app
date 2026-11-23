import { RefreshCw } from 'lucide-react';
import { useEffect } from 'react';
import { api } from '../lib/api';
import { usePreferences } from '../lib/preferences';
import { money } from '../lib/store';
import { useRemote } from '../lib/useRemote';

interface Balance {
  provider: string;
  balanceUsd: string | null;
  lowThresholdUsd: string;
  checkedAt: string | null;
  lastError: string | null;
  enabled: boolean;
  lowBalance: boolean;
  stale: boolean;
  notificationStatus: 'PENDING' | 'SENT' | 'CANCELLED' | null;
  notificationError: string | null;
}

export function ProviderBalances() {
  const { locale } = usePreferences();
  const ru = locale === 'ru';
  const remote = useRemote(() => api<{
    monitoring: { ceEnabled: boolean; smtpConfigured: boolean; intervalMs: number; lowThresholdUsd: string };
    balances: Balance[];
  }>('/api/admin/provider-balances'), []);
  const { reload } = remote;
  useEffect(() => {
    const timer = window.setInterval(() => void reload(), 60_000);
    return () => window.clearInterval(timer);
  }, [reload]);
  const settings = remote.data?.monitoring;

  return <section className="panel">
    <div className="panel-head"><h2>{ru ? 'Баланс аккаунта провайдера' : 'Provider account balance'}</h2>
      <button className="button ghost small" disabled={remote.loading} onClick={() => void reload()}><RefreshCw size={15}/>{ru ? 'Обновить' : 'Refresh'}</button>
    </div>
    {remote.error && <div className="form-error" role="alert">{remote.error}</div>}
    {settings && <p className="form-hint">{settings.ceEnabled
      ? (ru ? `Проверка каждые ${settings.intervalMs / 60_000} мин. Письмо при остатке ${money(settings.lowThresholdUsd, locale, 'USD')} или меньше.`
        : `Checked every ${settings.intervalMs / 60_000} minutes. Email at ${money(settings.lowThresholdUsd, locale, 'USD')} or below.`)
      : (ru ? 'Мониторинг выключен. Укажите доступ к аккаунту в .env.ce и включите CE_BALANCE_MONITOR_ENABLED или CE_AUTO_PROVISION_KEYS.'
        : 'Monitoring is off. Set account credentials in .env.ce and enable CE_BALANCE_MONITOR_ENABLED or CE_AUTO_PROVISION_KEYS.')}</p>}
    {settings?.ceEnabled && !settings.smtpConfigured && <div className="form-error" role="alert">{ru
      ? 'SMTP не настроен. Предупреждение появится здесь, а письмо останется в очереди. Настройте SMTP и ADMIN_ALERT_EMAIL.'
      : 'SMTP is not configured. Warnings appear here and emails remain queued. Configure SMTP and ADMIN_ALERT_EMAIL.'}</div>}
    <div className="table-scroll"><table><thead><tr>
      {[ru ? 'Провайдер' : 'Provider', ru ? 'Остаток, USD' : 'Balance, USD', ru ? 'Состояние' : 'Status',
        ru ? 'Последняя проверка' : 'Last checked', ru ? 'Уведомление' : 'Notification'].map(label => <th key={label}>{label}</th>)}
    </tr></thead><tbody>{remote.data?.balances.map(balance => {
      const unknown = balance.stale || Boolean(balance.lastError);
      const status = !balance.enabled ? (ru ? 'Выключен' : 'Disabled') : unknown ? (ru ? 'Нет свежих данных' : 'No recent data')
        : balance.lowBalance ? (ru ? 'Пополните аккаунт' : 'Top up account') : (ru ? 'Достаточно средств' : 'Balance OK');
      const notification = balance.notificationStatus === 'SENT' ? (ru ? 'Отправлено' : 'Sent')
        : balance.notificationStatus === 'PENDING' ? (ru ? 'В очереди' : 'Queued') : '—';
      return <tr key={balance.provider}>
        <td>{balance.provider}</td><td>{balance.balanceUsd === null ? '—' : money(balance.balanceUsd, locale, 'USD')}</td>
        <td><span className={`status-pill ${!balance.enabled ? 'disabled' : unknown || balance.lowBalance ? 'degraded' : 'active'}`}><i/>{status}</span>
          {balance.lastError && <div><small className="catalog-status">{balance.lastError}</small></div>}</td>
        <td>{balance.checkedAt ? new Date(balance.checkedAt).toLocaleString(locale) : '—'}</td>
        <td>{notification}{balance.notificationError && <div><small className="catalog-status">{balance.notificationError}</small></div>}</td>
      </tr>;
    })}</tbody></table></div>
    {settings?.ceEnabled && !remote.data?.balances.length && <p>{ru ? 'Ожидаем первую проверку worker.' : 'Waiting for the worker’s first check.'}</p>}
  </section>;
}
