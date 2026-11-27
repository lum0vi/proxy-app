import { Activity, ArrowUpRight, Check, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { usePreferences } from '../lib/preferences';
import { useRemote } from '../lib/useRemote';
import { money } from '../lib/store';

interface Receipt {
  id: string; orderId: string | null; transactionHash: string; amount: string; comment: string | null;
  transferredAt: string; status: string; reason: string; userEmail: string | null; expectedAmount: string | null; reviewNote: string | null;
}
interface PendingOrder { id: string; userEmail: string; amount: string; status: string; claim: { transactionHash: string } | null }
interface Overview {
  enabled: boolean; configured: boolean; autoApprove: boolean; receiver: string; master: string; receipts: Receipt[];
  scans: { checkedAt: string | null; scannedThrough: string; errorCode: string | null }[]; claims: PendingOrder[];
}

export function AdminPayments({ onChange }: { onChange: () => Promise<unknown> }) {
  const { locale } = usePreferences();
  const ru = locale === 'ru';
  const remote = useRemote(() => api<Overview>('/api/admin/payments/ton'));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [inspectOrder, setInspectOrder] = useState('');
  const [hash, setHash] = useState('');
  const { reload } = remote;
  useEffect(() => { const timer = window.setInterval(() => { if (!document.hidden) void reload(); }, 15_000); return () => window.clearInterval(timer); }, [reload]);
  const data = remote.data;
  const review = data?.receipts.filter(receipt => receipt.status === 'REVIEW') ?? [];
  const scanHealthy = !!data?.scans.length && data.scans.every(scan => !scan.errorCode && scan.checkedAt
    && Date.now() - Date.parse(scan.checkedAt) < 180_000 && Date.now() - Date.parse(scan.scannedThrough) < 600_000);
  const reasonLabels: Record<string, string> = ru ? {
    MANUAL_MODE: 'Ручной режим', PAYMENT_UNDERPAID: 'Сумма меньше счёта', OVERPAID: 'Переплата', LATE_PAYMENT: 'Поздний перевод',
    UNMATCHED: 'Заказ не найден по комментарию', PAYMENT_MISMATCH: 'Реквизиты не совпали', ORDER_ALREADY_SETTLED: 'Заказ уже оплачен', CONFIRMED: 'Подтверждено',
  } : { MANUAL_MODE: 'Manual review', PAYMENT_UNDERPAID: 'Underpaid', OVERPAID: 'Overpaid', LATE_PAYMENT: 'Late transfer',
    UNMATCHED: 'No matching invoice comment', PAYMENT_MISMATCH: 'Invoice mismatch', ORDER_ALREADY_SETTLED: 'Order already paid', CONFIRMED: 'Confirmed' };

  async function run(id: string, action: () => Promise<unknown>) {
    setBusy(id); setError(''); setNotice('');
    try { await action(); await reload(); await onChange(); setNotice(ru ? 'Данные обновлены.' : 'Updated.'); }
    catch (cause) {
      const messages: Record<string, string> = {
        PAYMENT_UNDERPAID: 'Сумма перевода меньше счёта. Зачисление запрещено; согласуйте возврат.',
        PAYMENT_MISMATCH: 'Этот перевод не соответствует выбранному счёту.', ORDER_ALREADY_SETTLED: 'Заказ уже оплачен.',
        PAYMENT_ALREADY_USED: 'Этот перевод уже зачислен.', TRANSFER_NOT_CONFIRMED: 'Подтверждённый перевод USDT на нужный кошелёк не найден.',
        TON_INDEXER_UNAVAILABLE: 'Блокчейн-проверка недоступна. Баланс не изменён; повторите позже.',
      };
      setError(cause instanceof ApiError && ru ? messages[cause.code] ?? cause.message : cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(''); }
  }
  async function reviewPayment(event: FormEvent<HTMLFormElement>, receipt: Receipt) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const decision = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value;
    if (!decision) return;
    await run(receipt.id, () => api(`/api/admin/payments/ton/${receipt.id}/review`, { method: 'POST', body: JSON.stringify({
      decision, note: form.get('note'), orderId: receipt.orderId ?? (form.get('orderId') || undefined),
    }) }));
  }
  if (remote.error && !data) return <div className="form-error">{remote.error}<button className="text-button" onClick={() => void reload()}>{ru ? 'Повторить' : 'Retry'}</button></div>;
  if (!data) return <p>{ru ? 'Загружаем платежи…' : 'Loading payments…'}</p>;

  return <section className="panel admin-payments">
    <div className="section-heading"><div><span className="checkout-kicker">PAYMENT DESK</span><h2>{ru ? 'Поступления USDT' : 'USDT deposits'}</h2></div>
      <button className="button small ghost" onClick={() => void reload()}><RefreshCw size={15}/>{ru ? 'Обновить' : 'Refresh'}</button></div>
    <div className="payment-health-grid">
      <div><Wallet/><small>{ru ? 'Приём переводов' : 'Direct payments'}</small><b>{data.enabled && data.configured ? (ru ? 'Настроен' : 'Configured') : (ru ? 'Нужна настройка' : 'Setup required')}</b></div>
      <div><Activity/><small>{ru ? 'Проверка блокчейна' : 'Blockchain checks'}</small><b className={scanHealthy ? 'accent-text' : 'warning-text'}>{scanHealthy ? (ru ? 'Работает' : 'Running') : (ru ? 'Не подтверждена' : 'Not confirmed')}</b></div>
      <div><ShieldCheck/><small>{ru ? 'Зачисление' : 'Approval'}</small><b>{data.autoApprove ? (ru ? 'Автоматическое' : 'Automatic') : (ru ? 'Вручную' : 'Manual')}</b></div>
      <div><Check/><small>{ru ? 'Требуют решения' : 'Need review'}</small><b>{review.length}</b></div>
    </div>
    {!data.configured && <p className="info-box">{ru ? 'Укажите TON_RECEIVER_ADDRESS и TONCENTER_API_KEY в .env, затем включите PAYMENT_METHODS=ton. Seed-фраза не нужна. Инструкция — в README.' : 'Set TON_RECEIVER_ADDRESS and TONCENTER_API_KEY in .env, then enable PAYMENT_METHODS=ton. No seed phrase is needed. See README.'}</p>}
    {data.receiver && <details className="payment-help"><summary>{ru ? 'Реквизиты и мониторинг' : 'Wallet and monitoring'}</summary><p>{ru ? 'Кошелёк' : 'Wallet'}: <code>{data.receiver}</code></p>
      <p>USDT master: <code>{data.master}</code></p>
      {data.scans.map((scan, i) => <p key={i}>{ru ? 'Последняя проверка' : 'Last check'}: {scan.checkedAt ? new Date(scan.checkedAt).toLocaleString(locale) : '—'} · {scan.errorCode ?? 'OK'}</p>)}</details>}
    {error && <div className="form-error" role="alert">{error}</div>}{notice && <p role="status">{notice}</p>}
    {data.claims.length > 0 && <details className="payment-help" open={data.claims.some(order => order.claim)}><summary>{ru ? 'Проверить транзакцию / заявки клиентов' : 'Inspect transaction / customer claims'}</summary>
      <p>{ru ? 'Хеш — только указатель на перевод. Для платежа без комментария подтвердите принадлежность клиенту по истории отправки из его кошелька. Публичная ссылка или скриншот не доказывают владение.' : 'A hash only identifies a transfer. For a missing comment, verify ownership using the customer’s sending wallet history. A public link or screenshot does not prove ownership.'}</p>
      <form className="payment-inspect-form" onSubmit={event => { event.preventDefault(); void run('inspect', () => api('/api/admin/payments/ton/inspect', {
        method: 'POST', body: JSON.stringify({ orderId: inspectOrder, transactionHash: hash }),
      })); }}>
        <label className="field"><span>{ru ? 'Заказ' : 'Order'}</span><select required value={inspectOrder} onChange={event => { setInspectOrder(event.target.value); setHash(data.claims.find(order => order.id === event.target.value)?.claim?.transactionHash ?? ''); }}>
          <option value="">{ru ? 'Выберите заказ' : 'Select order'}</option>{data.claims.map(order => <option key={order.id} value={order.id}>{order.userEmail} · {order.amount} USDT · {order.id.slice(0, 8)}{order.claim ? ' · TX' : ''}</option>)}</select></label>
        <label className="field"><span>{ru ? 'Хеш транзакции' : 'Transaction hash'}</span><input required minLength={43} maxLength={64} value={hash} onChange={event => setHash(event.target.value)}/></label>
        <button className="button ghost" disabled={!!busy}>{busy === 'inspect' ? '…' : (ru ? 'Сверить с блокчейном' : 'Verify on-chain')}</button>
      </form></details>}
    <div className="receipt-list">{data.receipts.length === 0 ? <div className="payment-empty"><Wallet/><h3>{ru ? 'Здесь появятся переводы' : 'Transfers will appear here'}</h3><p>{ru ? 'Подтверждённые поступления и платежи, которым нужна ваша помощь.' : 'Confirmed deposits and payments that need your attention.'}</p></div>
      : data.receipts.map(receipt => <article className="receipt-card" key={receipt.id}>
        <div className="receipt-heading"><div><strong>{money(receipt.amount, locale)}</strong><small>{receipt.userEmail ?? (ru ? 'Клиент не определён' : 'Customer not matched')}</small></div>
          <span className={`receipt-status ${receipt.status.toLowerCase()}`}>{receipt.status === 'APPROVED' ? (ru ? 'Зачислено' : 'Credited') : receipt.status === 'REJECTED' ? (ru ? 'Отклонено' : 'Rejected') : (ru ? 'На проверке' : 'Needs review')}</span></div>
        <p>{reasonLabels[receipt.reason] ?? receipt.reason} · {new Date(receipt.transferredAt).toLocaleString(locale)}</p>
        <div className="receipt-reference"><code>{receipt.comment ?? (ru ? 'Без комментария' : 'No comment')}</code><a target="_blank" rel="noreferrer" href={`https://tonviewer.com/transaction/${receipt.transactionHash}`}>TON Explorer <ArrowUpRight size={14}/></a></div>
        {receipt.expectedAmount && <p>{ru ? 'Сумма счёта / зачисления' : 'Invoice / credit amount'}: {money(receipt.expectedAmount, locale)}.
          {Number(receipt.amount) > Number(receipt.expectedAmount) && <span className="warning-text"> {ru ? 'Излишек' : 'Excess'}: {money(Number(receipt.amount) - Number(receipt.expectedAmount), locale)}.
            {ru ? ' Сверьте отдельный возврат; автоматического возврата нет.' : ' Reconcile a separate refund; refunds are not automatic.'}</span>}</p>}
        {receipt.status !== 'APPROVED' && <form onSubmit={event => void reviewPayment(event, receipt)}>
          {!receipt.orderId && <label className="field"><span>{ru ? 'Заказ для зачисления' : 'Order to credit'}</span><select name="orderId"><option value="">{ru ? 'Не выбран' : 'Not selected'}</option>{data.claims.map(order => <option key={order.id} value={order.id}>{order.userEmail} · {order.amount} USDT · {order.id.slice(0, 8)}</option>)}</select></label>}
          <label className="field"><span>{ru ? 'Основание решения (сохраняется в журнале)' : 'Decision evidence (saved to audit log)'}</span><input name="note" required minLength={10} maxLength={1000} placeholder={ru ? 'Как проверили перевод и принадлежность клиенту' : 'How the transfer and customer ownership were verified'}/></label>
          <div className="card-actions"><button className="button small" name="decision" value="approve" disabled={!!busy}>{ru ? 'Одобрить зачисление' : 'Approve credit'}</button>
            <button className="button small ghost" name="decision" value="reject" disabled={!!busy}>{ru ? 'Отклонить' : 'Reject'}</button></div>
          <small className="store-muted">{ru ? 'Отклонение не возвращает деньги отправителю.' : 'Rejecting does not send money back to the sender.'}</small>
        </form>}
        {receipt.reviewNote && <p className="receipt-note">{receipt.reviewNote}</p>}
      </article>)}</div>
  </section>;
}
