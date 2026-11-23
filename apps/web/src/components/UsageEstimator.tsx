import { ArrowRight, Calculator } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { usePreferences } from '../lib/preferences';
import { money, type PriceRates, type Product } from '../lib/store';
import { defaultModel } from '../lib/setup';

interface Estimate {
  cost: string;
  requestsPerKey: string | null;
  longContextApplied: boolean;
  peakApplied: boolean;
}

function family(model: string, protocol: string) {
  if (protocol === 'IMAGES') return 'GPT Image';
  if (protocol === 'GEMINI') return 'Gemini';
  if (model.startsWith('claude-')) return 'Claude';
  if (model.startsWith('grok-')) return 'Grok';
  if (model.startsWith('deepseek-')) return 'DeepSeek';
  return model.startsWith('gpt-') || model.startsWith('codex-') ? 'GPT' : 'API';
}

const examples = [
  { label: ['Короткий вопрос', 'Quick question'], input: 1500, cached: 0, output: 400 },
  { label: ['Правка кода', 'Code edit'], input: 12000, cached: 4000, output: 1500 },
  { label: ['Большой контекст', 'Long context'], input: 300000, cached: 120000, output: 3000 },
];

export function UsageEstimator({ products, exchange }: { products: Product[]; exchange: PriceRates | null }) {
  const { locale } = usePreferences();
  const ru = locale === 'ru';
  const [selectedProduct, setSelectedProduct] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [tokens, setTokens] = useState({ input: '12000', cached: '4000', output: '1500', write5m: '0', write1h: '0' });
  const [imageCount, setImageCount] = useState('1');
  const [quote, setQuote] = useState<{ url: string; value?: Estimate }>({ url: '' });
  const [attempt, setAttempt] = useState(0);
  const product = products.find(({ id }) => id === selectedProduct) ?? products[0];
  const models = product?.models ?? [];
  const model = models.find(({ model }) => model === selectedModel) ?? models.find(({ model }) => model === defaultModel) ?? models[0];
  const images = model?.protocol === 'IMAGES';
  const anthropic = model?.protocol === 'ANTHROPIC';
  const write5m = anthropic ? tokens.write5m : '0';
  const write1h = anthropic ? tokens.write1h : '0';
  const input = Number(tokens.input), cached = Number(tokens.cached), output = Number(tokens.output);
  const valid = images ? /^([1-9]|10)$/.test(imageCount) : [tokens.input, tokens.cached, tokens.output, write5m, write1h].every((value) => /^\d+$/.test(value))
    && input + output > 0 && input <= 1_100_000 && cached + Number(write5m) + Number(write1h) <= input && output <= 128_000;
  const query = new URLSearchParams(images ? { model: model.model, inputTokens: '0', outputTokens: '0', imageCount }
    : { model: model?.model ?? '', inputTokens: tokens.input, cachedInputTokens: tokens.cached, outputTokens: tokens.output, cacheWrite5mTokens: write5m, cacheWrite1hTokens: write1h });
  const url = valid && model && product ? `/api/products/${product.id}/estimate?${query}` : '';

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<Estimate>(url, { signal: controller.signal })
        .then((value) => { if (!controller.signal.aborted) setQuote({ url, value }); })
        .catch(() => { if (!controller.signal.aborted) setQuote({ url }); });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [url, attempt]);

  if (!product) return <p className="store-muted">{ru ? 'Калькулятор появится после добавления пакетов.' : 'The calculator will be available when packages are added.'}</p>;
  const result = quote.url === url ? quote.value : undefined;
  const inputs: [keyof typeof tokens, string, number, number][] = [
    ['input', ru ? 'Вход, токены' : 'Input tokens', 0, 1_100_000],
    ['cached', ru ? 'Из них из кэша' : 'Cached input tokens', 0, input || 0],
    ['output', ru ? 'Ответ, токены' : 'Output tokens', 0, 128_000],
  ];
  if (anthropic) inputs.push(['write5m', ru ? 'Запись в кэш, 5 мин' : 'Cache writes, 5 min', 0, input],
    ['write1h', ru ? 'Запись в кэш, 1 ч' : 'Cache writes, 1 h', 0, input]);
  const families = [...new Set(models.map((item) => family(item.model, item.protocol)))];
  return <div className="estimate-panel">
    <div className="estimate-form">
      <div className="estimate-selects">
        <label className="field"><span>{ru ? 'Пакет' : 'Package'}</span><select value={product.id} onChange={(event) => setSelectedProduct(event.target.value)}>
          {products.map((item) => <option key={item.id} value={item.id}>{item.name} · {money(item.retailPrice, locale)}</option>)}
        </select></label>
        <label className="field"><span>{ru ? 'Модель' : 'Model'}</span><select value={model?.model ?? ''} disabled={!model} onChange={(event) => setSelectedModel(event.target.value)}>
          {!model && <option value="">{ru ? 'Тарифы пока не заданы' : 'Rates are unavailable'}</option>}
          {families.map((name) => <optgroup key={name} label={name}>{models.filter((item) => family(item.model, item.protocol) === name).map((item) => <option key={item.model}>{item.model}</option>)}</optgroup>)}
        </select></label>
      </div>
      {images ? <label className="field estimate-presets"><span>{ru ? 'Изображений за запрос' : 'Images per request'}</span><input type="number" min={1} max={10} value={imageCount} onChange={(event) => setImageCount(event.target.value)}/></label> : <>
      <div className="estimate-presets" aria-label={ru ? 'Примеры запросов' : 'Request examples'}>
        {examples.map((preset) => <button type="button" key={preset.input}
          aria-pressed={input === preset.input && cached === preset.cached && output === preset.output}
          onClick={() => setTokens({ input: String(preset.input), cached: String(preset.cached), output: String(preset.output), write5m: '0', write1h: '0' })}>{preset.label[ru ? 0 : 1]}</button>)}
      </div>
      <div className="estimate-tokens">
        {inputs.map(([key, label, min, max]) => <label key={key} className="field"><span>{label}</span><input type="number" inputMode="numeric" min={min} max={max} step={1} value={tokens[key]}
          onChange={(event) => setTokens({ ...tokens, [key]: event.target.value })}/></label>)}
      </div>
      {!valid && <p role="status" className="estimator-message">{ru ? 'Укажите целые числа в допустимом диапазоне. Кэш входит в общий объём входа.' : 'Enter whole numbers in range. Cached tokens are a subset of input tokens.'}</p>}
      <p className="estimate-note">{ru ? 'Во вход входят инструкции, история диалога, чтение и запись кэша. Фактические списания видны в разделе «Расход». На одну задачу агент может отправить несколько запросов.' : 'Total input includes instructions, conversation history, and cache reads and writes. See actual charges in Usage. An agent can make several requests per task.'}</p>
      </>}
    </div>
    <div className="estimate-result">
      <span className="estimate-icon"><Calculator size={22}/></span>
      <div aria-live="polite">
        <span>{ru ? 'Примерно запросов на пакет' : 'Estimated requests per package'}</span>
        <strong>{result?.requestsPerKey != null ? new Intl.NumberFormat(locale).format(BigInt(result.requestsPerKey)) : '—'}</strong>
        <p>{ru ? 'Расход на запрос' : 'Cost per request'} {result ? money(result.cost, locale, 'USDT', 8) : '—'}</p>
        {result && exchange && <p>≈ {money(Number(result.cost) * Number(exchange.usdtToRub), locale, 'RUB', 4)}</p>}
        {result?.longContextApplied && <p>{ru ? 'Учтена ставка для длинного контекста' : 'Long-context rate applied'}</p>}
        {result?.peakApplied && <p>{ru ? 'Применена ставка часов пик' : 'Peak-hour rate applied'}</p>}
        {url && quote.url === url && !result && <button type="button" className="text-button" onClick={() => { setQuote({ url: '' }); setAttempt(attempt + 1); }}>{ru ? 'Повторить расчёт' : 'Retry estimate'}</button>}
      </div>
      {product.inventory > 0 && <Link className="button small" to={`/dashboard/buy?product=${product.id}`}>{ru ? 'Выбрать пакет' : 'Choose package'} <ArrowRight size={16}/></Link>}
    </div>
  </div>;
}

export function ModelCatalog({ products, exchange }: { products: Product[]; exchange: PriceRates | null }) {
  const { locale } = usePreferences();
  const ru = locale === 'ru';
  const [productId, setProductId] = useState('');
  const [currency, setCurrency] = useState<'USDT' | 'RUB'>('USDT');
  const displayCurrency = exchange ? currency : 'USDT';
  const ratePrice = (value: string) => money(Number(value) * (displayCurrency === 'RUB' ? Number(exchange!.usdtToRub) : 1), locale, displayCurrency, 8);
  const [selectedFamily, setSelectedFamily] = useState('');
  const withRates = products.filter(({ models, unpricedModels }) => models.length + unpricedModels.length > 0);
  const product = withRates.find(({ id }) => id === productId) ?? withRates[0];
  if (!product) return <p className="store-muted">{ru ? 'Тарифы моделей пока не опубликованы.' : 'Model rates have not been published yet.'}</p>;
  const families = [...new Set<string>([...product.models, ...product.unpricedModels].map((rate) => family(rate.model, rate.protocol)))];
  const visible = (rate: { model: string; protocol: string }) => !families.includes(selectedFamily) || family(rate.model, rate.protocol) === selectedFamily;
  const rates = product.models.filter(visible);
  return <div className="model-catalog">
      <div className="model-catalog-head">
        <label className="field"><span>{ru ? 'Пакет' : 'Package'}</span><select value={product.id} onChange={(event) => setProductId(event.target.value)}>
          {withRates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label className="field"><span>{ru ? 'Семейство' : 'Family'}</span><select value={families.includes(selectedFamily) ? selectedFamily : ''} onChange={(event) => setSelectedFamily(event.target.value)}>
          <option value="">{ru ? 'Все семейства' : 'All families'}</option>{families.map((name) => <option key={name}>{name}</option>)}
        </select></label>
      </div>
      {exchange && <div className="segmented" aria-label={ru ? 'Валюта ставок' : 'Rate currency'}>
        {(['USDT', 'RUB'] as const).map(value => <button type="button" key={value} disabled={value === 'RUB' && !exchange} aria-pressed={displayCurrency === value} className={displayCurrency === value ? 'active' : ''} onClick={() => setCurrency(value)}>{value === 'RUB' ? '₽' : 'USDT'}</button>)}
      </div>}
      {displayCurrency === 'RUB' && <p className="form-hint">{ru ? 'Справочный эквивалент по текущему курсу. Списание с баланса — в USDT.' : 'Indicative equivalent at the current exchange rate. Usage is charged in USDT.'}</p>}
      <div className="table-scroll"><table>
        <thead><tr>{[ru ? 'Модель' : 'Model', ru ? 'Вход' : 'Input', ru ? 'Кэш' : 'Cache', ru ? 'Ответ' : 'Output', ru ? 'За запрос' : 'Per request', ru ? 'Доступ' : 'Access'].map((label) => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{rates.map((rate) => <tr key={rate.model}>
          <td><code>{rate.model}</code>{rate.longContextThreshold && <small className="catalog-status">{Number(rate.longContextMultiplier)}× &gt; {new Intl.NumberFormat(locale).format(rate.longContextThreshold)}</small>}{Number(rate.peakMultiplier) > 1 && <small className="catalog-status">{Number(rate.peakMultiplier)}× {ru ? 'в часы пик' : 'at peak times'}</small>}</td>
          {[rate.inputPerMillion, rate.cachedInputPerMillion, rate.outputPerMillion].map((value, index) => <td key={index}>{rate.protocol === 'IMAGES' ? '—' : ratePrice(value)}</td>)}
          <td>{Number(rate.perRequest) > 0 ? ratePrice(rate.perRequest) : '—'}</td>
          <td><span className={`catalog-status${rate.available ? ' available' : ''}`}>{rate.available ? (ru ? 'Доступна' : 'Available') : (ru ? 'Недоступна' : 'Unavailable')}</span></td>
        </tr>)}{product.unpricedModels.filter(visible).map((rate) => <tr key={rate.model}>
          <td><code>{rate.model}</code></td><td colSpan={4}>—</td><td><span className="catalog-status">{ru ? 'Ставка не задана' : 'Rate pending'}</span></td>
        </tr>)}</tbody>
      </table></div>
  </div>;
}
