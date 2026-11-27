import type postgres from 'postgres';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { config } from '../config.js';
import { sql } from '../db/index.js';
import { AppError, assertFound } from '../lib/errors.js';
import { tonAddress, tonHash, USDT_TON_MASTER } from '../lib/ton.js';
import { markOrderPaid, tryFulfillPaidOrder } from './orders.js';

const master = tonAddress(USDT_TON_MASTER);
const actionSchema = z.object({
  // The live API serializes "finalized"; its OpenAPI also documents enum value 2.
  type: z.literal('jetton_transfer'), success: z.literal(true), finality: z.union([z.literal('finalized'), z.literal(2)]),
  trace_mc_seqno_end: z.number().int().positive(),
  trace_id: z.string(), action_id: z.string(), transactions: z.array(z.string()).min(1),
  end_utime: z.number().int().positive(),
  details: z.object({ asset: z.string(), receiver: z.string(), sender: z.string(),
    amount: z.string().regex(/^[1-9]\d{0,77}$/), comment: z.string().max(4096).nullable().optional(),
    is_encrypted_comment: z.boolean().nullable().optional() }),
});

interface Receipt {
  id: string; orderId: string | null; receiver: string; master: string;
  amountUnits: string; status: string; comment: string | null; transferredAt: Date;
}
interface TonOrder {
  id: string; status: string; amount: string; currency: string; paymentProvider: string;
  metadata: Record<string, unknown>; createdAt: Date; reservedUntil: Date;
}

async function lockedOrder(tx: postgres.TransactionSql, id: string) {
  const [order] = await tx<TonOrder[]>`SELECT id, status, amount::text, currency, payment_provider,
    metadata, created_at, reserved_until FROM orders WHERE id = ${id} FOR UPDATE`;
  return assertFound(order, 'ORDER_NOT_FOUND', 'Order not found');
}

function validateOrder(receipt: Receipt, order: TonOrder) {
  if (order.paymentProvider !== 'ton' || order.currency !== 'USDT' || receipt.master !== master
    || order.metadata.receiverRaw !== receipt.receiver || (receipt.orderId && receipt.orderId !== order.id)
    || receipt.transferredAt.getTime() < order.createdAt.getTime() - 1000) {
    throw new AppError(409, 'PAYMENT_MISMATCH', 'Transfer does not belong to this invoice');
  }
  if (['PAID', 'FULFILLED', 'REFUNDED'].includes(order.status)) {
    throw new AppError(409, 'ORDER_ALREADY_SETTLED', 'This order has already been settled');
  }
  if (new Decimal(receipt.amountUnits).lt(new Decimal(order.amount).mul(1_000_000))) {
    throw new AppError(409, 'PAYMENT_UNDERPAID', 'The transfer is smaller than the invoice. Resolve or refund it before crediting.');
  }
}

async function approve(tx: postgres.TransactionSql, receipt: Receipt, order: TonOrder, actor: string | null, note: string) {
  validateOrder(receipt, order);
  await tx`UPDATE ton_payments SET status = 'APPROVED', order_id = ${order.id}, reason = 'CONFIRMED',
    reviewed_by = ${actor}, review_note = ${note}, reviewed_at = now() WHERE id = ${receipt.id}`;
  await tx`UPDATE orders SET metadata = metadata || ${tx.json({ tonPaymentStatus: 'APPROVED', tonReceiptId: receipt.id })}
    WHERE id = ${order.id}`;
  await markOrderPaid(order.id, tx);
}

/** Accepts only the indexer's finalized successful USDT actions, never a browser's transaction data. */
async function recordAction(input: unknown, expectedReceiver: string, claim?: { orderId: string; hash: string }): Promise<string | null> {
  const parsed = actionSchema.safeParse(input);
  if (!parsed.success) return null;
  const action = parsed.data;
  let receiver: string, sender: string, asset: string, traceId: string, actionId: string, txHash: string;
  try {
    receiver = tonAddress(action.details.receiver); sender = tonAddress(action.details.sender);
    asset = tonAddress(action.details.asset); traceId = tonHash(action.trace_id);
    actionId = tonHash(action.action_id); txHash = tonHash(action.transactions[0]!);
  } catch { return null; }
  if (asset !== master || receiver !== expectedReceiver || action.end_utime * 1000 > Date.now()) return null;
  const comment = action.details.is_encrypted_comment ? null : action.details.comment ?? null;
  const result = await sql.begin(async tx => {
    const [inserted] = await tx<Receipt[]>`INSERT INTO ton_payments
      (trace_id, action_id, transaction_hash, receiver, sender, master, amount_units, comment, transferred_at, reason)
      VALUES (${traceId}, ${actionId}, ${txHash}, ${receiver}, ${sender}, ${master}, ${action.details.amount},
        ${comment}, ${new Date(action.end_utime * 1000)}, 'UNMATCHED')
      ON CONFLICT (trace_id, action_id) DO NOTHING
      RETURNING id, order_id, receiver, master, amount_units::text, status, comment, transferred_at`;
    if (claim) {
      const receipt = inserted ?? (await tx<Receipt[]>`SELECT id, order_id, receiver, master, amount_units::text, status, comment, transferred_at
        FROM ton_payments WHERE trace_id = ${traceId} AND action_id = ${actionId} FOR UPDATE`)[0]!;
      const order = await lockedOrder(tx, claim.orderId);
      if (receipt.orderId === order.id && receipt.status === 'APPROVED') return { id: receipt.id, paid: null };
      if (receipt.status !== 'REVIEW' || order.metadata.verification !== 'txid' || !['PENDING', 'EXPIRED'].includes(order.status)
        || receipt.transferredAt > order.reservedUntil
        || !new Decimal(String(order.metadata.payAmount)).mul(1_000_000).eq(receipt.amountUnits)) {
        throw new AppError(409, 'PAYMENT_MISMATCH', 'Transfer does not match this invoice');
      }
      await tx`SELECT pg_advisory_xact_lock(hashtext('ton-claimed-txid'), hashtext(${claim.hash}))`;
      const [used] = await tx`SELECT id FROM orders WHERE payment_provider = 'ton' AND metadata->>'verifiedTxid' = ${claim.hash}`;
      if (used) throw new AppError(409, 'PAYMENT_ALREADY_USED', 'This transaction has already been credited');
      await tx`UPDATE orders SET metadata = metadata || ${tx.json({ verifiedTxid: claim.hash })} WHERE id = ${order.id}`;
      await approve(tx, receipt, order, null, 'Verified customer TXID ' + claim.hash);
      return { id: receipt.id, paid: order.id };
    }
    if (!inserted) return { id: null, paid: null };
    const [match] = comment ? await tx<{ id: string }[]>`SELECT id FROM orders
      WHERE payment_provider = 'ton' AND metadata->>'payinExtraId' = ${comment}` : [];
    if (!match) return { id: inserted.id, paid: null };
    const order = await lockedOrder(tx, match.id);
    let reason = 'MANUAL_MODE';
    try { validateOrder(inserted, order); }
    catch (error) { reason = error instanceof AppError ? error.code : 'PAYMENT_MISMATCH'; }
    if (reason === 'MANUAL_MODE') {
      if (inserted.transferredAt > order.reservedUntil) reason = 'LATE_PAYMENT';
      else if (!new Decimal(inserted.amountUnits).eq(new Decimal(order.amount).mul(1_000_000))) reason = 'OVERPAID';
      else if (config.TON_AUTO_APPROVE && order.metadata.autoApprove === true) {
        await approve(tx, inserted, order, null, 'Automatic: finalized, exact amount and invoice comment');
        return { id: inserted.id, paid: order.id };
      }
    }
    await tx`UPDATE ton_payments SET order_id = ${order.id}, reason = ${reason} WHERE id = ${inserted.id}`;
    if (!['PAID', 'FULFILLED', 'REFUNDED'].includes(order.status)) {
      await tx`UPDATE orders SET metadata = metadata || ${tx.json({ tonPaymentStatus: 'REVIEW' })} WHERE id = ${order.id}`;
    }
    return { id: inserted.id, paid: null };
  });
  if (result.paid) await tryFulfillPaidOrder(result.paid);
  return result.id;
}

async function getActions(params: URLSearchParams): Promise<{ actions: unknown[]; next_cursor?: string | null | undefined }> {
  try {
    const response = await fetch(`${config.TONCENTER_API_URL.replace(/\/$/, '')}/actions?${params}`, {
      headers: config.TONCENTER_API_KEY ? { 'X-API-Key': config.TONCENTER_API_KEY } : {},
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('Indexer unavailable');
    return z.object({ actions: z.array(z.unknown()).max(1000), next_cursor: z.string().max(8192).nullish() }).parse(await response.json());
  } catch { throw new AppError(503, 'TON_INDEXER_UNAVAILABLE', 'Blockchain verification is temporarily unavailable. No payment was credited.'); }
}

/** Worker-only polling. A session advisory lock prevents two workers moving the same cursor. */
export async function scanTonPayments(): Promise<void> {
  if (!config.paymentMethods.includes('ton')) return;
  const connection = await sql.reserve();
  let acquired = false;
  try {
    const [lock] = await connection<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('ton-payment-scan')) AS locked`;
    acquired = lock?.locked === true;
    if (!acquired) return;
    const historical = await sql<{ address: string }[]>`SELECT DISTINCT metadata->>'receiverRaw' AS address FROM orders
      WHERE payment_provider = 'ton' AND metadata->>'receiverRaw' IS NOT NULL`;
    const addresses = new Set(historical.map(row => row.address));
    if (config.TON_RECEIVER_ADDRESS) addresses.add(tonAddress(config.TON_RECEIVER_ADDRESS));
    for (const address of addresses) {
      await sql`INSERT INTO ton_payment_scans (address, scanned_through)
        VALUES (${address}, COALESCE((SELECT min(created_at) - interval '5 minutes' FROM orders
          WHERE payment_provider = 'ton' AND metadata->>'receiverRaw' = ${address}), now() - interval '1 hour'))
        ON CONFLICT DO NOTHING`;
      try {
        const [scan] = await sql<{ scannedThrough: Date; windowEnd: Date | null; pageCursor: string | null; pageOffset: number }[]>`
          UPDATE ton_payment_scans SET window_end = COALESCE(window_end, date_trunc('second', now() - interval '30 seconds'))
          WHERE address = ${address} RETURNING scanned_through, window_end, page_cursor, page_offset`;
        if (!scan?.windowEnd || scan.windowEnd <= scan.scannedThrough) continue;
        const params = new URLSearchParams({ account: address, action_type: 'jetton_transfer', limit: '100', sort: 'asc',
          start_utime: String(Math.floor(scan.scannedThrough.getTime() / 1000) - 300),
          end_utime: String(Math.floor(scan.windowEnd.getTime() / 1000)) });
        if (scan.pageCursor) params.set('cursor', scan.pageCursor);
        else params.set('offset', String(scan.pageOffset));
        const page = await getActions(params);
        for (const action of page.actions) await recordAction(action, address);
        if (page.next_cursor && page.next_cursor === scan.pageCursor) throw new Error('Indexer cursor did not advance');
        const more = Boolean(page.next_cursor) || page.actions.length === 100;
        await sql`UPDATE ton_payment_scans SET scanned_through = ${more ? scan.scannedThrough : scan.windowEnd},
          window_end = ${more ? scan.windowEnd : null}, page_cursor = ${more ? page.next_cursor ?? null : null},
          page_offset = ${more ? scan.pageOffset + page.actions.length : 0}, checked_at = now(), error_code = NULL
          WHERE address = ${address}`;
      } catch {
        await sql`UPDATE ton_payment_scans SET error_code = 'TON_SCAN_FAILED' WHERE address = ${address}`;
      }
    }
  } finally {
    try { if (acquired) await connection`SELECT pg_advisory_unlock(hashtext('ton-payment-scan'))`; }
    finally { connection.release(); }
  }
}

export async function inspectTonTransaction(orderId: string, transactionHash: string, customerClaim = false): Promise<void> {
  const [order] = await sql<{ metadata: Record<string, unknown> }[]>`SELECT metadata FROM orders WHERE id = ${orderId} AND payment_provider = 'ton'`;
  const receiver = assertFound(order, 'ORDER_NOT_FOUND', 'TON invoice not found').metadata.receiverRaw;
  if (typeof receiver !== 'string') throw new AppError(409, 'INVOICE_NOT_READY', 'Invoice is not ready');
  let hash: string;
  try { hash = tonHash(transactionHash); } catch { throw new AppError(400, 'INVALID_TRANSACTION_HASH', 'Enter a TON transaction hash'); }
  const page = await getActions(new URLSearchParams({ tx_hash: hash, action_type: 'jetton_transfer', limit: '100' }));
  let found = false;
  for (const action of page.actions) {
    // A submitted hash is only a search hint. Identity, token and finality are verified again.
    const parsed = actionSchema.safeParse(action);
    if (!parsed.success || !parsed.data.transactions.some(value => { try { return tonHash(value) === hash; } catch { return false; } })) continue;
    try {
      if (tonAddress(parsed.data.details.receiver) !== receiver || tonAddress(parsed.data.details.asset) !== master) continue;
    } catch { continue; }
    if (customerClaim && !new Decimal(parsed.data.details.amount).eq(new Decimal(String(order!.metadata.payAmount)).mul(1_000_000))) continue;
    const receipt = await recordAction(action, receiver, customerClaim ? { orderId, hash } : undefined);
    if (customerClaim && receipt) return;
    if (receipt || !customerClaim) found = true;
  }
  if (!found) throw new AppError(409, 'TRANSFER_NOT_CONFIRMED', 'No finalized USDT transfer to this invoice wallet was found');
}

export async function reviewTonPayment(input: { id: string; decision: 'approve' | 'reject'; orderId?: string | undefined; note: string; actorId: string }) {
  const paid = await sql.begin(async tx => {
    const [receipt] = await tx<Receipt[]>`SELECT id, order_id, receiver, master, amount_units::text, status, comment, transferred_at
      FROM ton_payments WHERE id = ${input.id} FOR UPDATE`;
    const row = assertFound(receipt, 'PAYMENT_NOT_FOUND', 'Payment not found');
    if (row.status === 'APPROVED') throw new AppError(409, 'PAYMENT_ALREADY_USED', 'This transfer has already been credited');
    const orderId = input.orderId ?? row.orderId;
    if (input.decision === 'approve' && !orderId) throw new AppError(400, 'ORDER_REQUIRED', 'Choose the verified customer order');
    if (input.decision === 'approve') {
      const order = await lockedOrder(tx, orderId!);
      if (order.metadata.verification === 'txid') throw new AppError(409, 'TXID_REQUIRED', 'Customer TXID verification required');
      await approve(tx, row, order, input.actorId, input.note);
    } else {
      await tx`UPDATE ton_payments SET status = 'REJECTED', reviewed_by = ${input.actorId}, review_note = ${input.note},
        reviewed_at = now() WHERE id = ${row.id}`;
      if (row.orderId) await tx`UPDATE orders SET metadata = metadata || ${tx.json({ tonPaymentStatus: 'REJECTED' })}
        WHERE id = ${row.orderId} AND status NOT IN ('PAID', 'FULFILLED', 'REFUNDED')`;
    }
    await tx`INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
      VALUES (${input.actorId}, ${input.decision === 'approve' ? 'APPROVE_PAYMENT' : 'REJECT_PAYMENT'}, 'TON_PAYMENT', ${row.id},
        ${tx.json({ orderId, note: input.note })})`;
    return input.decision === 'approve' ? orderId : null;
  });
  if (paid) await tryFulfillPaidOrder(paid);
}

export async function tonPaymentOverview() {
  const [receipts, scans, claims] = await Promise.all([
    sql`SELECT t.id, t.order_id, t.transaction_hash, t.receiver, t.sender, t.master,
      (t.amount_units / 1000000)::text AS amount, t.comment, t.transferred_at, t.status, t.reason, t.review_note,
      u.email AS user_email, o.amount::text AS expected_amount, o.status AS order_status
      FROM ton_payments t LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN users u ON u.id = o.user_id
      ORDER BY (t.status = 'REVIEW') DESC, t.created_at DESC LIMIT 200`,
    sql`SELECT address, checked_at, scanned_through, error_code FROM ton_payment_scans ORDER BY address`,
    sql`SELECT o.id, u.email AS user_email, o.amount::text, o.status, o.metadata->'paymentClaim' AS claim
      FROM orders o JOIN users u ON u.id = o.user_id WHERE payment_provider = 'ton'
      AND o.status NOT IN ('PAID', 'FULFILLED', 'REFUNDED') ORDER BY o.created_at DESC LIMIT 200`,
  ]);
  return { enabled: config.paymentMethods.includes('ton'), configured: Boolean(config.TON_RECEIVER_ADDRESS && config.TONCENTER_API_KEY),
    autoApprove: config.TON_AUTO_APPROVE, receiver: config.TON_RECEIVER_ADDRESS, master: USDT_TON_MASTER, receipts, scans, claims };
}
