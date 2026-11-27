import { Check, Clock3, Copy, ShieldCheck, Wallet } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { usePreferences } from '../lib/preferences';
import { CopyButton } from './CodeBlock';

export function CryptoInvoice({ order, deadline, reload }: {
  order: { id: string; status: string; amount: string; paymentProvider: string; metadata: Record<string, unknown> };
  deadline: number; reload: () => Promise<unknown>;
}) {
  const { locale } = usePreferences();
  const ru = locale === 'ru';
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const meta = order.metadata;
  const direct = order.paymentProvider === 'ton';
  const txid = direct && meta.verification === 'txid';
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  const review = ['REVIEW', 'REJECTED'].includes(String(meta.tonPaymentStatus));
  const canPay = order.status === 'PENDING' && seconds > 0 && !review && !meta.paymentClaim && !sent;
  const countdown = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;

  async function submitClaim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const transactionHash = String(new FormData(event.currentTarget).get('hash') ?? '');
    try {
      await api(`/api/orders/${order.id}/payment-claim`, { method: 'POST', body: JSON.stringify({ transactionHash }) });
      setSent(true); await reload();
    } catch (cause) { setError(cause instanceof ApiError && cause.code === 'INVALID_TRANSACTION_HASH'
      ? (ru ? 'Введите хеш транзакции из кошелька, без ссылки.' : 'Enter the transaction hash from your wallet, without the URL.')
      : txid && cause instanceof ApiError && cause.status === 409
      ? (ru ? 'Перевод не подтверждён для этого счёта. Проверьте TXID и сумму. Если перевод ещё обрабатывается, повторите проверку позже.' : 'Transfer unconfirmed for this invoice. Check the TXID and amount. If pending, retry later.')
      : (ru ? 'Не удалось отправить заявку. Попробуйте ещё раз.' : 'Could not submit the request. Please try again.')); }
    finally { setBusy(false); }
  }

  return <section className="panel crypto-invoice payment-ticket">
    <div className="payment-ticket-heading"><span className="token-symbol">₮</span><div><small>{ru ? 'Перевод криптовалюты' : 'Crypto transfer'}</small><h2>USDT <span>/ TON</span></h2></div>
      <span className="network-chip">TON</span></div>
    <div className="payment-ticket-amount"><small>{ru ? 'К оплате' : 'Amount to send'}</small>
      <div><strong>{String(meta.payAmount ?? order.amount)}</strong><span>USDT</span>{canPay && <CopyButton value={String(meta.payAmount ?? order.amount)}/>}</div>
    </div>
    {canPay ? <>
      <div className="payment-countdown"><Clock3 size={16}/><span>{ru ? 'Счёт действует ещё' : 'Invoice expires in'}</span><b>{countdown}</b></div>
      <ol className="payment-instructions">
        <li><span>1</span><div><h3>{ru ? 'Выберите USDT и сеть TON' : 'Choose USDT on TON'}</h3>
          <p>{txid ? (ru ? 'Скопируйте полную сумму из счёта и отправьте одним переводом без комментария. В сумму входит небольшая доплата для идентификации платежа.' : 'Copy the exact amount shown and send it in one transfer without a comment. The amount includes a small surcharge to identify your payment.') : ru ? 'Отправьте точную сумму одним переводом. Для комиссии кошельку может понадобиться немного TON.' : 'Send the exact amount in one transfer. Your wallet may need a small TON balance for network fees.'}</p></div></li>
        <li><span>2</span><div><h3>{ru ? 'Скопируйте адрес получателя' : 'Copy the receiving address'}</h3>
          <div className="payment-copy-row"><code>{String(meta.payAddress)}</code><CopyButton value={String(meta.payAddress)}/></div>
          {!!meta.payinExtraId && <><h3>{ru ? 'Добавьте комментарий к переводу' : 'Include this transfer comment'}</h3>
            <div className="payment-copy-row memo"><code>{String(meta.payinExtraId)}</code><CopyButton value={String(meta.payinExtraId)}/></div>
            <p>{ru ? 'По нему мы найдём ваш заказ. Используйте кошелёк, который позволяет отправлять открытый комментарий.' : 'It identifies your order. Use a wallet that supports an unencrypted transfer comment.'}</p></>}
        </div></li>
        <li><span>3</span><div><h3>{txid ? (ru ? 'Отправьте TXID' : 'Submit your TXID') : ru ? 'Дождитесь подтверждения' : 'Wait for confirmation'}</h3>
          <p>{txid ? (ru ? 'Введите TXID из кошелька ниже. Баланс зачислится только после проверки перевода.' : 'Enter your wallet transaction ID below. Your balance is credited after verification.') : direct && meta.autoApprove === false
            ? (ru ? 'Перевод проверит администратор. Статус обновится на этой странице.' : 'An administrator will review the transfer. The status updates on this page.')
            : (ru ? 'Проверяем поступление автоматически. После подтверждения баланс зачислится, а статус обновится здесь.' : 'We check incoming transfers automatically. Your balance and this page update after confirmation.')}</p></div></li>
      </ol>
      <div className="payment-footnote"><ShieldCheck size={18}/>{ru ? 'Не отправляйте Toncoin или USDT в другой сети.' : 'Do not send Toncoin or USDT on another network.'}</div>
    </> : <div className="payment-waiting" role="status"><Wallet size={28}/><h3>{meta.tonPaymentStatus === 'REJECTED'
      ? (ru ? 'Перевод не зачислен' : 'Transfer not credited') : review
      ? (ru ? 'Платёж требует проверки' : 'Payment needs review')
      : meta.paymentClaim || sent ? (ru ? 'Заявка на проверку отправлена' : 'Review request submitted')
      : (ru ? 'Срок счёта истёк' : 'Invoice expired')}</h3>
      <p>{txid ? (ru ? 'Если перевод уже отправлен, не платите повторно.' : 'If you already paid, do not send another transfer.') : ru ? 'Если вы уже отправили перевод, не платите повторно. Мы проверим поступление. Поздние платежи и платежи без комментария рассматривает администратор.'
        : 'If you already sent a transfer, do not pay again. We will check it. Late transfers and transfers without a comment require administrator review.'}</p></div>}
    {txid && !sent && <form onSubmit={submitClaim}>
      <label className="field"><span>TXID</span><input name="hash" required minLength={43} maxLength={64} autoComplete="off"/></label>
      {error && <p role="alert">{error}</p>}
      <button className="button" disabled={busy}>{ru ? 'Проверить TXID' : 'Verify TXID'}</button>
    </form>}
    {direct && !txid && <details className="payment-help"><summary><Copy size={15}/>{ru ? 'Уже оплатили, но статус не изменился?' : 'Paid but the status has not changed?'}</summary>
      <p>{ru ? 'Подтверждение может занять несколько минут. Если комментарий не был добавлен или платёж не найден, пришлите хеш транзакции. Администратор сверит перевод; заявка сама по себе не зачисляет деньги.'
        : 'Confirmation can take a few minutes. If the comment is missing or the payment was not found, submit the transaction hash for review. Submitting a hash does not credit the balance.'}</p>
      <form onSubmit={event => void submitClaim(event)}><label className="field"><span>{ru ? 'Хеш транзакции' : 'Transaction hash'}</span>
        <input name="hash" required minLength={43} maxLength={64} autoComplete="off" placeholder="a1b2…"/></label>
        {error && <div className="form-error" role="alert">{error}</div>}
        {sent && <p role="status"><Check size={16}/>{ru ? 'Отправлено на проверку' : 'Submitted for review'}</p>}
        <button className="button ghost" disabled={busy}>{busy ? (ru ? 'Отправляем…' : 'Submitting…') : (ru ? 'Отправить на проверку' : 'Request review')}</button>
      </form></details>}
  </section>;
}
