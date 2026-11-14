import { usePreferences } from '../lib/preferences';
import { money, ton, type PriceRates } from '../lib/store';

export function PriceCurrencies({ usd, rates, loading }: { usd: string; rates: PriceRates | null; loading: boolean }) {
  const { locale } = usePreferences();
  return <div className="price-currencies">
    {rates ? <>
      <span>≈ {money(Number(usd) * Number(rates.usdToRub), locale, 'RUB')}</span>
      <span>≈ {ton(Number(usd) * Number(rates.usdToTon), locale)}</span>
    </> : <span>{loading ? (locale === 'ru' ? 'Загружаем курс ₽ и TON' : 'Loading RUB and TON rates')
      : (locale === 'ru' ? 'Курс ₽ и TON пока недоступен' : 'RUB and TON rates are unavailable')}</span>}
  </div>;
}
