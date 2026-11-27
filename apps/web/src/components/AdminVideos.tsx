import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useRemote } from '../lib/useRemote';
import { usePreferences } from '../lib/preferences';
import { money } from '../lib/store';

interface Job { id: string; model: string; seconds: number; state: string; progress: number; lastError: string | null;
  createdAt: string; upstreamId: string | null; email: string; keyHint: string; reservedCost: string | null }

export function AdminVideos() {
  const { locale } = usePreferences(); const ru = locale === 'ru';
  const remote = useRemote(() => api<{ jobs: Job[] }>('/api/admin/videos'));
  const [selected, setSelected] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const job = remote.data?.jobs.find(item => item.id === selected);
  async function reconcile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!job) return;
    const form = new FormData(event.currentTarget); setBusy(true); setError('');
    try {
      await api(`/api/admin/videos/${job.id}/reconcile`, { method: 'POST', body: JSON.stringify({
        action: form.get('action'), reason: form.get('reason'), ...(form.get('upstreamId') ? { upstreamId: form.get('upstreamId') } : {}),
      }) });
      setSelected(''); await remote.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const states: Record<string, string> = ru ? { REVIEW: 'Нужна проверка', SUBMITTING: 'Отправляется', QUEUED: 'В очереди',
    IN_PROGRESS: 'Создаётся', COMPLETED: 'Готово', FAILED: 'Без списания' } : {};
  return <section className="panel">
    <div className="panel-head admin-panel-head"><h2>{ru ? 'Задачи генерации видео' : 'Video generation jobs'}</h2><button type="button" className="button ghost small" disabled={remote.loading} onClick={() => void remote.reload()}>{ru ? 'Обновить' : 'Refresh'}</button></div>
    <p className="form-hint">{ru ? 'Баланс резервируется до подтверждения результата. Задачи «Нужна проверка» удерживают резерв: проверьте их у поставщика и подтвердите результат либо освободите деньги без списания.' : 'Balance stays reserved until the result is confirmed. Review jobs retain their reservation: verify the provider result or release the funds without charging.'}</p>
    {error && <div className="form-error">{error}</div>}
    {remote.error && <div className="form-error" role="alert">{remote.error}</div>}
    {remote.loading && <p role="status">{ru ? 'Загружаем задачи…' : 'Loading video jobs…'}</p>}
    <div className="table-scroll"><table><thead><tr>{[ru ? 'Покупатель / ключ' : 'Buyer / key', ru ? 'Модель / время' : 'Model / duration', ru ? 'Статус' : 'Status', ru ? 'Резерв' : 'Reserved', ''].map((label, index) => <th key={index}>{label}</th>)}</tr></thead>
      <tbody>{remote.data?.jobs.map(item => <tr key={item.id}>
        <td>{item.email}<small className="catalog-status">{item.keyHint}</small></td>
        <td><code>{item.model}</code><small className="catalog-status">{item.seconds} s · video_{item.id}</small></td>
        <td>{states[item.state] ?? item.state}<small className="catalog-status">{item.lastError}</small></td>
        <td>{money(item.reservedCost ?? '0', locale, 'USDT', 8)}</td>
        <td>{!['COMPLETED', 'FAILED'].includes(item.state) && <button type="button" className="button ghost small" onClick={() => { setSelected(item.id); setError(''); }}>{ru ? 'Проверить' : 'Review'}</button>}</td>
      </tr>)}</tbody></table></div>
    {!remote.loading && !remote.error && !remote.data?.jobs.length && <p>{ru ? 'Задач пока нет.' : 'No video jobs yet.'}</p>}
    {job && <form className="compact-form" onSubmit={reconcile}>
      <strong>video_{job.id}</strong>
      {!job.upstreamId && <label className="field"><span>{ru ? 'Проверенный ID задачи у поставщика' : 'Verified provider job ID'}</span><input name="upstreamId" maxLength={200}/></label>}
      <label className="field"><span>{ru ? 'Действие' : 'Action'}</span><select name="action"><option value="refresh">{ru ? 'Запросить подтверждённый результат' : 'Fetch verified result'}</option>{job.state === 'REVIEW' && <option value="release">{ru ? 'Освободить резерв без списания' : 'Release without charging'}</option>}</select></label>
      <label className="field"><span>{ru ? 'Причина решения (для журнала)' : 'Reason (audit log)'}</span><textarea name="reason" required minLength={10} maxLength={1000}/></label>
      <button className="button" disabled={busy}>{ru ? 'Применить решение' : 'Apply decision'}</button>
    </form>}
  </section>;
}
