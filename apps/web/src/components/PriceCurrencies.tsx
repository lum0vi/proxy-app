import { usePreferences } from '../lib/preferences';
import { money, type PriceRates } from '../lib/store';

export function PriceCurrencies({ usdt, rates }: { usdt: string | number; rates: PriceRates | null; loading: boolean }) {
  const { locale } = usePreferences();
  if (!rates) return null;
  return <div className="price-currencies">
    <span>≈ {money(Number(usdt) * Number(rates.usdtToRub), locale, 'RUB')}</span>
    <small>{locale === 'ru' ? 'Курс на ' : 'Rate as of '}{new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(rates.checkedAt))}</small>
  </div>;
}
