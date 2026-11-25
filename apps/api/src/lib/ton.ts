import { Address } from '@ton/core';

// Mainnet USD₮ master, not a token name supplied by the sender.
// https://docs.ton.org/applications/payments/jettons
export const USDT_TON_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

export function tonAddress(value: string): string {
  if (!Address.isRaw(value) && Address.parseFriendly(value).isTestOnly) throw new Error('Testnet address is not accepted');
  const address = Address.parse(value);
  if (address.workChain !== 0) throw new Error('Use a mainnet basechain wallet');
  return address.toRawString();
}

export function tonHash(value: string): string {
  if (/^[a-f\d]{64}$/i.test(value)) return value.toLowerCase();
  if (!/^[A-Za-z\d+/_-]{43}=?$/.test(value)) throw new Error('Invalid TON hash');
  const hash = Buffer.from(value, 'base64url');
  if (hash.length !== 32) throw new Error('Invalid TON hash');
  return hash.toString('hex');
}
