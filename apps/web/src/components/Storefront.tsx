import { ArrowDown, ArrowRight, BarChart3, Cable, ChevronDown, Clock3, Code2, CreditCard, KeyRound, Terminal, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { usePreferences } from '../lib/preferences';
import { concurrentRequestSummary, money, type PriceRates, type Product, type StoreCatalog } from '../lib/store';
import { useRemote } from '../lib/useRemote';
import { PriceCurrencies } from './PriceCurrencies';
import { ModelCatalog, UsageEstimator } from './UsageEstimator';

const faq = [
  ['Что входит в пакет?', 'Персональный API-ключ с балансом на сумму покупки. Один баланс используется для всех доступных моделей.', 'What comes with a package?', 'A personal API key with a balance equal to the purchase price. All available models use that balance.'],
  ['Как считается расход?', 'У каждой модели свои ставки за входные токены, кэш и ответ. При включённом тарифе для длинного контекста он тоже учитывается. В кабинете видны списания по запросам.', 'How is usage calculated?', 'Each model has its own rates for input, cached input, and output. A long-context rate applies when configured. The dashboard shows charges by request.'],
  ['Что значит «запросы одновременно»?', 'Пока модель отвечает, запрос считается активным. При лимите 2 на один ключ третий запрос вернёт ошибку 429, если первые два ещё выполняются. Повторите его, когда один из них завершится.', 'What does “requests at once” mean?', 'A model request counts as active until it finishes. With a limit of two per key, a third request returns a 429 error while the first two are still running. Retry after one of them finishes.'],
  ['Что делать, если баланс закончится?', 'Оформите новый ключ и замените его в настройках клиента. Письма о низком остатке и сроке приходят на почту аккаунта.', 'What happens when my balance runs out?', 'Buy a new key and replace it in your client configuration. Low-balance and expiration notices go to your account email.'],
  ['Где посмотреть модели моего ключа?', 'Откройте «API-ключи → Подключить» в кабинете или вызовите GET /v1/models с вашим ключом.', 'Where can I see models for my key?', 'Open API Keys → Connect in your dashboard or call GET /v1/models with your key.'],
] as const;

function PackageCard({ product, rates, loadingRates }: { product: Product; rates: PriceRates | null; loadingRates: boolean }) {
  const { t, locale } = usePreferences();
  const ru = locale === 'ru';
  const highlight = product.slug === 'developer-key';
  const available = product.inventory > 0;
  return <article className={`store-package${highlight ? ' featured' : ''}`}>
    <div className="package-heading"><h3>{product.name}</h3>{highlight && <span>{ru ? 'Для работы' : 'For daily work'}</span>}</div>
    <div className="package-price">{money(product.retailPrice, locale, product.currency)}</div>
    <PriceCurrencies usd={product.retailPrice} rates={rates} loading={loadingRates}/>
    <ul className="package-details">
      <li><Clock3 size={17}/>{product.durationDays ? `${product.durationDays} ${t('days')}` : t('noExpiry')}</li>
      <li><Zap size={17}/><span>{concurrentRequestSummary(product.concurrencyLimit, locale)}</span></li>
    </ul>
    {available ? <Link className={`button wide${highlight ? '' : ' ghost'}`} to={`/dashboard/buy?product=${product.id}`}>{t('buy')} <ArrowRight size={16}/></Link>
      : <button type="button" className="button wide ghost" disabled>{ru ? 'Продажи недоступны' : 'Sales unavailable'}</button>}
  </article>;
}

export function Storefront() {
  const { user } = useAuth();
  const { locale } = usePreferences();
  const ru = locale === 'ru';
  const catalog = useRemote(() => api<StoreCatalog>('/api/products'));
  const exchange = useRemote(() => api<{ rates: PriceRates | null }>('/api/price-rates'));
  const products = catalog.data?.products ?? [];
  const rates = exchange.data?.rates ?? null;
  const available = products.some((product) => product.inventory > 0);
  const copy = ru
    ? { headline: 'AI-модели', accent: 'для разработки', description: 'Один API-ключ для доступных моделей GPT, Claude, Gemini, Grok, DeepSeek и GPT Image. Подключите Codex, Claude Code, OpenCode или своё приложение.', choose: 'Выбрать пакет', setup: 'Как подключить', keyPrice: 'Пакеты API-ключей', packages: 'Вся сумма покупки поступает на баланс ключа. Выберите пакет для пробы, работы над проектом или длинных сессий.', calculation: 'Сколько стоит запрос?', calcNote: 'Сравните модели на своём контексте и подберите пакет.', models: 'Модели и ставки', rates: 'Розничные цены в USD за 1 млн токенов или за изображение. Доступность обновляется автоматически.', how: 'От ключа до первого запроса' }
    : { headline: 'AI model access', accent: 'for developers', description: 'One API key for available GPT, Claude, Gemini, Grok, DeepSeek, and GPT Image models. Connect Codex, Claude Code, OpenCode, or your own app.', choose: 'Choose a package', setup: 'Set up your client', keyPrice: 'API key packages', packages: 'The full purchase price becomes your key balance. Choose a package for a trial, daily work, or longer sessions.', calculation: 'What does a request cost?', calcNote: 'Compare models with your own context and choose a package.', models: 'Models and rates', rates: 'Retail rates in USD per million tokens or per image. Model availability updates automatically.', how: 'From key to first request' };
  const steps = [
    { icon: CreditCard, name: ru ? 'Выберите пакет' : 'Choose a package', text: ru ? 'Оплаченная сумма становится балансом ключа.' : 'The amount you pay becomes your key balance.', to: '/#pricing' },
    { icon: Cable, name: ru ? 'Подключите клиент' : 'Connect your client', text: ru ? 'Скопируйте настройки для Codex, Claude Code, OpenCode или SDK.' : 'Copy the settings for Codex, Claude Code, OpenCode, or an SDK.', to: '/setup' },
    { icon: BarChart3, name: ru ? 'Проверьте расход' : 'Track usage', text: ru ? 'Откройте остаток, историю и ошибки по ключу.' : 'See the balance, request history, and errors for each key.', to: '/dashboard/usage' },
  ];

  return <main className="storefront" id="main">
    <section className="store-hero">
      <div className="shell-width store-hero-layout">
        <div className="store-hero-copy">
          <div className="store-protocol"><Terminal size={17}/> OPENAI · ANTHROPIC · GEMINI API</div>
          <h1>{copy.headline}<br/>{' '}<span>{copy.accent}</span></h1>
          <p>{copy.description}</p>
          <div className="store-actions">
            <Link className="button large" to="/#pricing">{copy.choose}<ArrowDown size={18}/></Link>
            <Link className="button large ghost" to="/setup"><Code2 size={18}/>{copy.setup}</Link>
          </div>
          <div className="store-hero-benefits"><span><KeyRound size={16}/>{ru ? 'Разовая оплата' : 'One-time purchase'}</span><span><BarChart3 size={16}/>{ru ? 'Учёт по запросам' : 'Per-request usage'}</span></div>
        </div>
        <div className="store-hero-visual">
          <img src="/proxykey-gateway.jpg" width="1280" height="960" alt="" fetchPriority="high"/>
          <div className="store-api-panel"><span><i className={available ? 'ready' : ''}/>{catalog.loading ? (ru ? 'Проверяем доступ' : 'Checking access') : available ? (ru ? 'Ключи доступны' : 'Keys available') : (ru ? 'Покупка пока недоступна' : 'Purchases unavailable')}</span><code>POST /v1/responses</code></div>
        </div>
      </div>
    </section>

    <div className="shell-width store-content">
      <section className="store-section" id="pricing">
        <div className="store-section-heading"><div><h2>{copy.keyPrice}</h2><p>{copy.packages}</p></div><a href="#calculator">{ru ? 'Рассчитать расход' : 'Estimate usage'} <ArrowDown size={15}/></a></div>
        {catalog.loading ? <p role="status" className="store-muted">{ru ? 'Загружаем пакеты…' : 'Loading packages…'}</p> : catalog.error
          ? <div className="store-notice" role="status"><span>{ru ? 'Не удалось загрузить пакеты.' : 'Could not load packages.'}</span><button type="button" className="button small ghost" onClick={() => void catalog.reload()}>{ru ? 'Повторить' : 'Retry'}</button></div>
          : products.length > 0 ? <>
            <div className="store-packages">{products.map((product) => <PackageCard key={product.id} product={product} rates={rates} loadingRates={exchange.loading}/>)}</div>
            <p className="store-price-note">{ru ? 'Цены в ₽ и TON рассчитаны по котировкам TonAPI. Точную сумму TON покажем перед переводом.' : 'RUB and TON prices use TonAPI market rates. The checkout shows the exact TON amount before you send it.'}</p>
          </> : <p className="store-muted">{ru ? 'Пакеты пока не опубликованы.' : 'Packages have not been published yet.'}</p>}
      </section>

      <section className="store-section" id="calculator">
        <div className="store-section-heading"><div><h2>{copy.calculation}</h2><p>{copy.calcNote}</p></div></div>
        {catalog.data && <UsageEstimator products={products}/>}
      </section>

      <section className="store-section" id="models">
        <div className="store-section-heading"><div><h2>{copy.models}</h2><p>{copy.rates}</p></div><Link to="/docs#api">{ru ? 'Описание API' : 'API reference'} <ArrowRight size={15}/></Link></div>
        {catalog.data && <ModelCatalog products={products}/>}
      </section>

      <section className="store-section" id="how">
        <div className="store-section-heading"><h2>{copy.how}</h2></div>
        <div className="store-steps">{steps.map(({ icon: Icon, name, text, to }) => <Link key={to} to={to}><Icon size={21}/><h3>{name}<ArrowRight size={17}/></h3><p>{text}</p></Link>)}</div>
      </section>

      <section className="store-section store-faq" id="faq">
        <div className="store-section-heading"><h2>{ru ? 'Частые вопросы' : 'Frequently asked questions'}</h2></div>
        <div>{faq.map(([questionRu, answerRu, questionEn, answerEn]) => <details key={questionEn}>
          <summary>{ru ? questionRu : questionEn}<ChevronDown size={18}/></summary><p>{ru ? answerRu : answerEn}</p>
        </details>)}
        <Link to={user ? '/dashboard' : '/register'}>{user ? (ru ? 'Открыть кабинет' : 'Open dashboard') : (ru ? 'Создать аккаунт' : 'Create an account')} <ArrowRight size={16}/></Link></div>
      </section>
    </div>
  </main>;
}
