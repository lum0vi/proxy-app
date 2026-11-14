import {
  Activity, ArrowRight, BarChart3, CircleDollarSign,
  CreditCard, Eye, Gauge, KeyRound, Languages, LayoutDashboard,
  LockKeyhole, LogOut, Menu, Moon, Network, Package, Plus, RefreshCw, Server,
  Settings2, ShieldCheck, ShoppingBag, Sun, TerminalSquare, UserRound, Users, Wallet,
  X, Zap,
} from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  Link, NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams,
} from 'react-router-dom';
import { api, ApiError } from './lib/api';
import { useAuth, type User } from './lib/auth';
import { usePreferences, type Locale, type Theme } from './lib/preferences';
import { useRemote } from './lib/useRemote';
import { money, type CustomerKey, type ModelOption, type PriceRates, type PaymentMethod, type StoreCatalog } from './lib/store';
import { connectionSnippets, exampleKey } from './lib/setup';
import { CodeBlock, CopyButton } from './components/CodeBlock';
import { ClientSetup } from './components/ClientSetup';
import { Storefront } from './components/Storefront';
import { PriceCurrencies } from './components/PriceCurrencies';

type AnyRecord = Record<string, unknown>;

interface Order {
  id: string;
  status: string;
  paymentProvider: string;
  amount: string;
  currency: string;
  checkoutUrl: string | null;
  metadata: Record<string, unknown>;
  reservedUntil: string;
  paidAt: string | null;
  fulfilledAt: string | null;
  createdAt: string;
  productName: string;
  apiKeyId: string | null;
  keyHint: string | null;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <Link to="/" className="brand" aria-label="ProxyKey home">
    <span className="brand-mark"><Network size={18} /></span>
    {!compact && <span>Proxy<span className="accent-text">Key</span></span>}
  </Link>;
}

function PreferenceControls({ minimal = false }: { minimal?: boolean }) {
  const { locale, setLocale, theme, setTheme, t } = usePreferences();
  const nextTheme: Record<Theme, Theme> = { SYSTEM: 'LIGHT', LIGHT: 'DARK', DARK: 'SYSTEM' };
  const ThemeIcon = theme === 'DARK' ? Moon : theme === 'LIGHT' ? Sun : Settings2;
  return <div className="preference-controls">
    <button className="icon-button labelled" onClick={() => setLocale(locale === 'ru' ? 'en' : 'ru')} title={t('language')}>
      <Languages size={17} /><span>{locale.toUpperCase()}</span>
    </button>
    <button className="icon-button" onClick={() => setTheme(nextTheme[theme])} title={`${t('theme')}: ${t(theme.toLowerCase())}`}>
      <ThemeIcon size={17} />{!minimal && <span className="sr-only">{t('theme')}</span>}
    </button>
  </div>;
}

function PublicHeader() {
  const { user, loading } = useAuth();
  const { t, locale } = usePreferences();
  const ru = locale === 'ru';
  const links = [
    ['/#pricing', ru ? 'Пакеты' : 'Packages'], ['/#models', ru ? 'Модели' : 'Models'],
    ['/#calculator', ru ? 'Калькулятор' : 'Calculator'], ['/setup', ru ? 'Подключение' : 'Setup'],
  ] as const;
  return <header className="public-header shell-width">
    <Brand />
    <nav className="public-nav" aria-label={ru ? 'Разделы сайта' : 'Site sections'}>
      {links.map(([to, label]) => <Link key={to} to={to}>{label}</Link>)}
    </nav>
    <div className="header-actions">
      <PreferenceControls minimal />
      <Link className="button small" to={user ? '/dashboard' : '/login'}>{user || loading ? t('dashboard') : t('login')} <ArrowRight size={15}/></Link>
    </div>
  </header>;
}

function PublicFooter() {
  const { t, locale } = usePreferences();
  return <footer className="public-footer shell-width">
    <Brand />
    <p>© {new Date().getFullYear()} ProxyKey</p>
    <div><Link to="/docs">{t('docs')}</Link><a href="/openapi.yaml" target="_blank" rel="noreferrer">OpenAPI</a><a href="/health/serving" target="_blank" rel="noreferrer">{locale === 'ru' ? 'Статус API' : 'API status'}</a><Link to="/#faq">FAQ</Link></div>
  </footer>;
}

function LandingPage() {
  return <div className="marketing-page"><PublicHeader/><Storefront/><PublicFooter/></div>;
}

function SetupPage() {
  const { locale } = usePreferences();
  const ru = locale === 'ru';
  const catalog = useRemote(() => api<StoreCatalog>('/api/products'));
  const models = [...new Map<string, ModelOption>(catalog.data?.products.flatMap((product) => product.models.map((rate) => [`${rate.protocol}/${rate.model}`, rate] as const))).values()];
  return <div className="marketing-page"><PublicHeader/>
    <main className="shell-width setup-page">
      <div className="store-section-heading">
        <div><h1>{ru ? 'Как подключить ProxyKey' : 'Connect to ProxyKey'}</h1><p>{ru ? 'Выберите клиент и подставьте ключ из кабинета.' : 'Choose a client and use the API key from your dashboard.'}</p></div>
        <Link to="/docs">{ru ? 'Документация' : 'Documentation'} <ArrowRight size={17}/></Link>
      </div>
      <p className="store-muted">{ru ? 'Доступные для вашего ключа модели показаны в кабинете.' : 'Find the models available for your key in the dashboard.'}</p>
      <ClientSetup models={models}/>
    </main>
    <PublicFooter/>
  </div>;
}

function ScrollToRoute() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'instant' });
      else window.scrollTo({ top: 0, behavior: 'instant' });
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname, hash]);
  return null;
}

const docsCopy = {
  ru: {
    eyebrow: 'Документация ProxyKey',
    title: 'От покупки ключа до первого запроса',
    lead: 'Оплатите API-ключ один раз и используйте один баланс в Codex, Claude Code, OpenCode и других совместимых клиентах.',
    start: 'Начало работы', platform: 'API и оплата',
    overview: 'Обзор', quickstart: 'Быстрый старт', codex: 'Codex CLI / App', api: 'SDK и REST API', billing: 'Ключи и оплата', errors: 'Ошибки',
    overviewTitle: 'Как устроен сервис',
    overviewText: 'Один ключ открывает доступные модели GPT, Claude, Gemini, Grok, DeepSeek и GPT Image. Выберите модель и её API; расход списывается с общего баланса ключа.',
    nativeTitle: 'API для разных моделей', nativeText: 'Поддерживаются Responses, Chat Completions, Anthropic Messages, Gemini и генерация изображений.',
    prepaidTitle: 'Разовая покупка', prepaidText: 'Вы платите за выбранный ключ. Автопродления и скрытого ежемесячного списания нет.',
    safeTitle: 'История расходов', safeText: 'Баланс, срок, число одновременных запросов и списания видны в кабинете.',
    quickTitle: 'Четыре шага до запуска',
    steps: [
      ['Создайте аккаунт', 'Зарегистрируйтесь по почте и откройте «Купить ключ».'],
      ['Выберите пакет', 'Проверьте цену, срок действия и доступные модели.'],
      ['Оплатите один раз', 'Используйте карту или криптовалюту. После webhook ключ выдаётся автоматически.'],
      ['Скопируйте ключ', 'Откройте «API-ключи», нажмите «Показать» и сохраните pk_live_… в менеджере секретов.'],
    ],
    codexTitle: 'Подключение Codex',
    codexText: 'Добавьте пользовательский конфиг в ~/.codex/config.toml. Проектный .codex/config.toml не подходит для model_providers. Base URL уже включает /v1.',
    authTitle: 'Передайте ключ',
    authText: 'Экспортируйте переменную перед запуском Codex. Этот профиль читает ключ из окружения; для POSIX-оболочки используйте команду ниже.',
    apiTitle: 'Прямой API и OpenAI SDK',
    apiText: 'Получите доступные модели через GET /v1/models и выберите подходящий маршрут. Для длинных сессий отправляйте историю в каждом запросе или используйте сжатие контекста, если модель его поддерживает.',
    endpointsTitle: 'Поддерживаемые маршруты',
    endpoint: 'Маршрут', purpose: 'Назначение',
    billingTitle: 'Что именно покупает пользователь',
    billingText: 'Вся сумма покупки поступает на баланс ключа. Запросы ко всем доступным моделям списываются с этого баланса по ставкам ProxyKey.',
    noticesTitle: 'Уведомления', noticesText: 'Email отправляется после выдачи ключа, при низком остатке и перед истечением срока. Пользователь покупает новый ключ сам — автоматического платежа нет.',
    walletTitle: 'Данные кошелька', walletText: 'В профиле хранится только публичный адрес для связи с платежом. Seed-фразы и приватные ключи сервис никогда не запрашивает.',
    errorsTitle: 'Типовые ответы API',
    errorRows: [
      ['401 INVALID_API_KEY', 'Ключ отсутствует или неверен.'],
      ['403 API_KEY_INACTIVE', 'Ключ отозван или отключён.'],
      ['402 CREDITS_EXHAUSTED', 'Prepaid-лимит закончился — нужен новый ключ.'],
      ['409 NO_UPSTREAM_CAPACITY', 'У провайдера временно нет свободного места для новой продажи.'],
      ['429 KEY_CONCURRENCY_LIMIT', 'Достигнут лимит одновременных запросов ключа.'],
      ['503 UPSTREAM_UNAVAILABLE', 'Провайдер недоступен; повторите запрос с backoff.'],
    ],
    fullSpec: 'Открыть OpenAPI-спецификацию', buyNow: 'Купить ключ',
  },
  en: {
    eyebrow: 'ProxyKey documentation',
    title: 'From buying a key to your first request',
    lead: 'Pay once for an API key and use one balance across Codex, Claude Code, OpenCode, and other compatible clients.',
    start: 'Getting started', platform: 'API and billing',
    overview: 'Overview', quickstart: 'Quickstart', codex: 'Codex CLI / App', api: 'SDK and REST API', billing: 'Keys and billing', errors: 'Errors',
    overviewTitle: 'How the service works',
    overviewText: 'One key unlocks available GPT, Claude, Gemini, Grok, DeepSeek, and GPT Image models. Choose a model and its API; every request draws from the same key balance.',
    nativeTitle: 'APIs for different models', nativeText: 'Use Responses, Chat Completions, Anthropic Messages, Gemini, or image generation.',
    prepaidTitle: 'One-time purchase', prepaidText: 'You pay for the selected key. There is no hidden monthly charge or automatic renewal.',
    safeTitle: 'Usage history', safeText: 'See your remaining balance, expiration, concurrent request limit, and charges in the dashboard.',
    quickTitle: 'Four steps to start',
    steps: [
      ['Create an account', 'Register with your email and open “Buy a key”.'],
      ['Choose a package', 'Check the price, expiration, and available models.'],
      ['Pay once', 'Use a card or crypto. The key is issued automatically after a verified webhook.'],
      ['Copy the key', 'Open “API keys”, choose “Reveal”, and store pk_live_… in a secret manager.'],
    ],
    codexTitle: 'Connect Codex',
    codexText: 'Add the provider to your user-level ~/.codex/config.toml. A project .codex/config.toml cannot define model_providers. The Base URL already includes /v1.',
    authTitle: 'Provide the key',
    authText: 'Export the variable before starting Codex. This profile reads its key from the environment; the command below uses a POSIX shell.',
    apiTitle: 'Direct API and OpenAI SDK',
    apiText: 'Use GET /v1/models to see the models your key can use, then choose the matching route. For long sessions, send your conversation history or use context compaction if the model supports it.',
    endpointsTitle: 'Supported routes', endpoint: 'Endpoint', purpose: 'Purpose',
    billingTitle: 'What the customer buys',
    billingText: 'The full purchase amount becomes your API key balance. Requests to all available models draw from this balance at ProxyKey rates.',
    noticesTitle: 'Notifications', noticesText: 'Email is sent when the key is issued, when its allowance is low, and before expiration. The customer buys another key manually; no automatic payment occurs.',
    walletTitle: 'Wallet data', walletText: 'Only a public payment address is stored in the profile. The service never asks for seed phrases or private keys.',
    errorsTitle: 'Common API responses',
    errorRows: [
      ['401 INVALID_API_KEY', 'The key is missing or invalid.'],
      ['403 API_KEY_INACTIVE', 'The key is revoked or disabled.'],
      ['402 CREDITS_EXHAUSTED', 'The prepaid allowance is exhausted; purchase a new key.'],
      ['409 NO_UPSTREAM_CAPACITY', 'The provider has no capacity for another sale.'],
      ['429 KEY_CONCURRENCY_LIMIT', 'The key has reached its concurrent request limit.'],
      ['503 UPSTREAM_UNAVAILABLE', 'The provider is unavailable; retry with backoff.'],
    ],
    fullSpec: 'Open the OpenAPI specification', buyNow: 'Buy a key',
  },
};

function DocsPage() {
  const { locale } = usePreferences();
  const copy = docsCopy[locale];
  const snippets = connectionSnippets(window.location.origin);
  const authSnippet = `export PROXYKEY_API_KEY="${exampleKey}"`;
  const endpoints = [
    ['GET /v1/models', 'Каталог моделей ключа', 'Models available to the key'],
    ['POST /v1/responses', 'GPT и Grok · потоковые ответы', 'GPT and Grok · streaming'],
    ['POST /v1/responses/compact', 'Сжатие контекста', 'Context compaction'],
    ['POST /v1/chat/completions', 'Chat Completions, включая DeepSeek', 'Chat Completions, including DeepSeek'],
    ['POST /v1/messages', 'Claude · Anthropic Messages', 'Claude · Anthropic Messages'],
    ['GET /v1beta/models', 'Доступные модели Gemini', 'Available Gemini models'],
    ['POST /v1beta/models/{model}:generateContent', 'Gemini · ответ JSON', 'Gemini · JSON response'],
    ['POST /v1beta/models/{model}:streamGenerateContent', 'Gemini · потоковый ответ', 'Gemini · streaming response'],
    ['POST /v1/images/generations', 'GPT Image · генерация изображений', 'GPT Image · image generation'],
  ];
  const nav = [
    [copy.start, [['overview', copy.overview], ['quickstart', copy.quickstart], ['codex', copy.codex]]],
    [copy.platform, [['api', copy.api], ['billing', copy.billing], ['errors', copy.errors]]],
  ] as const;
  return <div className="docs-page">
    <PublicHeader />
    <main>
      <section className="docs-hero shell-width">
        <span className="eyebrow"><TerminalSquare size={14}/>{copy.eyebrow}</span>
        <h1>{copy.title}</h1><p>{copy.lead}</p>
        <div><Link className="button" to="/dashboard/buy">{copy.buyNow}<ArrowRight size={16}/></Link><a className="button ghost" href="/openapi.yaml" target="_blank" rel="noreferrer">OpenAPI</a></div>
      </section>
      <div className="docs-layout shell-width">
        <aside className="docs-sidebar" aria-label="Documentation navigation">
          {nav.map(([group, links]) => <div key={group}><span>{group}</span>{links.map(([id, label]) => <Link to={`/docs#${id}`} key={id}>{label}</Link>)}</div>)}
        </aside>
        <article className="docs-content">
          <section id="overview" className="docs-section"><h2>{copy.overviewTitle}</h2><p className="docs-lead">{copy.overviewText}</p>
            <div className="docs-feature-grid"><article><TerminalSquare/><h3>{copy.nativeTitle}</h3><p>{copy.nativeText}</p></article><article><CreditCard/><h3>{copy.prepaidTitle}</h3><p>{copy.prepaidText}</p></article><article><Gauge/><h3>{copy.safeTitle}</h3><p>{copy.safeText}</p></article></div>
          </section>
          <section id="quickstart" className="docs-section"><h2>{copy.quickTitle}</h2><ol className="docs-steps">{copy.steps.map(([title, text], index) => <li key={title}><b>{index + 1}</b><div><h3>{title}</h3><p>{text}</p></div></li>)}</ol></section>
          <section id="codex" className="docs-section"><h2>{copy.codexTitle}</h2><p>{copy.codexText}</p><CodeBlock code={snippets.codex} label="~/.codex/config.toml"/><h3>{copy.authTitle}</h3><p>{copy.authText}</p><CodeBlock code={authSnippet} label="Terminal"/></section>
          <section id="api" className="docs-section"><h2>{copy.apiTitle}</h2><p>{copy.apiText}</p><div className="docs-code-pair"><CodeBlock code={snippets.curl} label="curl"/><CodeBlock code={snippets.node} label="Node.js / TypeScript"/></div><Link className="docs-link" to="/setup">{locale === 'ru' ? 'Примеры для других моделей и клиентов' : 'Examples for other models and clients'}<ArrowRight size={15}/></Link><h3>{copy.endpointsTitle}</h3><div className="docs-table"><table><thead><tr><th>{copy.endpoint}</th><th>{copy.purpose}</th></tr></thead><tbody>{endpoints.map(([path, ru, en]) => <tr key={path}><td><code>{path}</code></td><td>{locale === 'ru' ? ru : en}</td></tr>)}</tbody></table></div><a className="docs-link" href="/openapi.yaml" target="_blank" rel="noreferrer">{copy.fullSpec}<ArrowRight size={15}/></a></section>
          <section id="billing" className="docs-section"><h2>{copy.billingTitle}</h2><p className="docs-lead">{copy.billingText}</p><div className="docs-note-grid"><article><Activity/><h3>{copy.noticesTitle}</h3><p>{copy.noticesText}</p></article><article><Wallet/><h3>{copy.walletTitle}</h3><p>{copy.walletText}</p></article></div></section>
          <section id="errors" className="docs-section"><h2>{copy.errorsTitle}</h2><dl className="error-catalog">{copy.errorRows.map(([code, text]) => <div key={code}><dt><code>{code}</code></dt><dd>{text}</dd></div>)}</dl></section>
        </article>
      </div>
    </main>
    <PublicFooter />
  </div>;
}

function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { login, register } = useAuth();
  const { t } = usePreferences();
  const navigate = useNavigate();
  const location = useLocation();
  const requested = new URLSearchParams(location.search).get('next');
  const next = requested && /^\/dashboard(?:[/?]|$)/.test(requested) && !/[\\\r\n]/.test(requested) ? requested : '/dashboard';
  const alternative = mode === 'login' ? '/register' : '/login';
  const authLink = requested ? `${alternative}?${new URLSearchParams({ next })}` : alternative;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      if (mode === 'login') await login(String(form.get('email')), String(form.get('password')));
      else await register(String(form.get('name')), String(form.get('email')), String(form.get('password')));
      navigate(next, { replace: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <div className="auth-page">
    <div className="auth-panel"><div className="auth-top"><Brand/><PreferenceControls minimal/></div>
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-icon"><KeyRound/></div><h1>{t(mode)}</h1><p>{mode === 'login' ? t('noAccount') : t('haveAccount')} <Link to={authLink}>{t(mode === 'login' ? 'register' : 'login')}</Link></p>
        {error && <div className="form-error">{error}</div>}
        {mode === 'register' && <Field label={t('name')} name="name" autoComplete="name" required minLength={2}/>}
        <Field label={t('email')} name="email" type="email" autoComplete="email" required/>
        <Field label={t('password')} name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={12}/>
        <button className="button wide large" disabled={busy}>{busy ? t('loading') : t(mode)} <ArrowRight size={17}/></button>
      </form>
    </div>
    <div className="auth-art"><div className="orb one"/><div className="orb two"/><blockquote>“OpenAI-compatible routing with billing you can actually audit.”</blockquote></div>
  </div>;
}

function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const { label, ...input } = props;
  return <label className="field"><span>{label}</span><input {...input}/></label>;
}

function ProtectedRoute({ admin = false }: { admin?: boolean }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullPageLoading/>;
  if (!user) return <Navigate to={`/login?${new URLSearchParams({ next: location.pathname + location.search })}`} replace/>;
  if (admin && user.role !== 'ADMIN') return <Navigate to="/dashboard" replace/>;
  return <Outlet/>;
}

const dashboardNav = [
  { to: '/dashboard', key: 'overview', icon: LayoutDashboard, end: true },
  { to: '/dashboard/keys', key: 'keys', icon: KeyRound },
  { to: '/dashboard/usage', key: 'usageHistory', icon: BarChart3 },
  { to: '/dashboard/buy', key: 'buyKey', icon: ShoppingBag },
  { to: '/dashboard/orders', key: 'orders', icon: Package },
  { to: '/dashboard/profile', key: 'profile', icon: UserRound },
];

const adminNav = [
  { to: '/admin', key: 'overview', icon: LayoutDashboard, end: true },
  { to: '/admin/providers', key: 'providers', icon: Server },
  { to: '/admin/products', key: 'products', icon: ShoppingBag },
  { to: '/admin/users', key: 'users', icon: Users },
  { to: '/admin/orders', key: 'orders', icon: Package },
  { to: '/admin/monitoring', key: 'monitoring', icon: BarChart3 },
];

function AppShell({ admin = false }: { admin?: boolean }) {
  const { user, logout } = useAuth();
  const { t } = usePreferences();
  const navigate = useNavigate();
  const [mobile, setMobile] = useState(false);
  const nav = admin ? adminNav : dashboardNav;
  return <div className="app-shell">
    <aside className={mobile ? 'sidebar open' : 'sidebar'}>
      <div className="sidebar-head"><Brand/><button className="mobile-close" onClick={() => setMobile(false)}><X/></button></div>
      <div className="account-chip"><span>{user?.name?.[0]?.toUpperCase() ?? user?.email[0]?.toUpperCase()}</span><div><b>{user?.name ?? user?.email}</b><small>{admin ? t('admin') : user?.email}</small></div></div>
      <nav>{nav.map(({ to, key, icon: Icon, end }) => <NavLink key={to} to={to} end={end} onClick={() => setMobile(false)}><Icon size={18}/>{t(key)}</NavLink>)}</nav>
      <div className="sidebar-foot">
        {user?.role === 'ADMIN' && <Link className="admin-switch" to={admin ? '/dashboard' : '/admin'}>{admin ? <LayoutDashboard size={17}/> : <ShieldCheck size={17}/>} {admin ? t('dashboard') : t('admin')}</Link>}
        <button onClick={() => { void logout().then(() => navigate('/')); }}><LogOut size={17}/>{t('logout')}</button>
      </div>
    </aside>
    {mobile && <button className="sidebar-backdrop" onClick={() => setMobile(false)} aria-label="Close menu"/>}
    <div className="app-main">
      <header className="app-header"><button className="mobile-menu" aria-label={t('openMenu')} onClick={() => setMobile(true)}><Menu/></button><div className="app-header-spacer"/><PreferenceControls/></header>
      <main className="app-content"><Outlet/></main>
    </div>
  </div>;
}

function PageTitle({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  return <div className="page-title"><div>{eyebrow && <span>{eyebrow}</span>}<h1>{title}</h1></div>{action}</div>;
}

function Loading() { const { t } = usePreferences(); return <div className="loading"><RefreshCw className="spin"/>{t('loading')}</div>; }
function FullPageLoading() { return <div className="full-loading"><Brand/><RefreshCw className="spin"/></div>; }
function ErrorState({ message, retry }: { message: string; retry?: () => void }) { const { t } = usePreferences(); return <div className="error-state"><b>{t('error')}</b><p>{message}</p>{retry && <button className="button small ghost" onClick={retry}>{t('retry')}</button>}</div>; }

function formatDate(value: string | null, locale: Locale) {
  return value ? new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
}

function StatusPill({ status }: { status: string }) { const { t } = usePreferences(); return <span className={`status-pill ${status.toLowerCase()}`}><i/>{status === 'PAID' ? t('paidAwaitingKey') : status}</span>; }

function DashboardOverview() {
  const { t, locale } = usePreferences();
  const keys = useRemote(() => api<{ keys: CustomerKey[] }>('/api/keys'), []);
  const orders = useRemote(() => api<{ orders: Order[] }>('/api/orders'), []);
  const active = keys.data?.keys.filter((key) => key.status === 'ACTIVE') ?? [];
  const remaining = active.reduce((sum, key) => sum + Math.max(0, Number(key.creditsTotal) - Number(key.creditsUsed)), 0);
  return <>
    <PageTitle eyebrow="ProxyKey / API" title={t('overview')} action={<Link className="button" to="/dashboard/buy"><Plus size={17}/>{t('buyKey')}</Link>}/>
    <div className="stat-grid">
      <StatCard icon={KeyRound} label={t('activeKeys')} value={String(active.length)} accent="violet"/>
      <StatCard icon={Wallet} label={t('remainingCredit')} value={`$${remaining.toFixed(4)}`} accent="green"/>
      <StatCard icon={Package} label={t('orders')} value={String(orders.data?.orders.length ?? 0)} accent="blue"/>
    </div>
    <section className="panel"><div className="panel-head"><h2>{t('keys')}</h2><Link to="/dashboard/keys">{t('keys')} <ArrowRight size={15}/></Link></div>
      {keys.loading ? <Loading/> : active.length === 0 ? <EmptyState icon={KeyRound} text={t('buyKey')} to="/dashboard/buy"/> : <div className="key-mini-grid">{active.slice(0,3).map((key) => <div className="key-mini" key={key.id}><span><KeyRound/></span><div><b>{key.label}</b><code>{key.keyHint}</code></div><UsageBar used={Number(key.creditsUsed)} total={Number(key.creditsTotal)}/></div>)}</div>}
    </section>
    <section className="panel"><div className="panel-head"><h2>{t('recentOrders')}</h2><Link to="/dashboard/orders">{t('orders')} <ArrowRight size={15}/></Link></div>
      <DataTable headers={[t('order'), t('amount'), t('status'), t('created')]} rows={(orders.data?.orders.slice(0,5) ?? []).map((order) => [<Link to={`/dashboard/orders/${order.id}`}>{order.productName}</Link>, `${order.amount} ${order.currency}`, <StatusPill status={order.status}/>, formatDate(order.createdAt, locale)])}/>
    </section>
  </>;
}

function StatCard({ icon: Icon, label, value, accent }: { icon: typeof KeyRound; label: string; value: string; accent: string }) {
  return <article className="stat-card"><span className={`stat-icon ${accent}`}><Icon/></span><div><p>{label}</p><strong>{value}</strong></div></article>;
}

function UsageBar({ used, total }: { used: number; total: number }) {
  const percent = total > 0 ? Math.min(100, used / total * 100) : 0;
  return <div className="usage-bar" title={`${percent.toFixed(1)}%`}><i style={{ width: `${percent}%` }}/></div>;
}

function EmptyState({ icon: Icon, text, to }: { icon: typeof KeyRound; text: string; to: string }) {
  return <div className="empty-state"><Icon/><p>{text}</p><Link className="button small" to={to}>{text}</Link></div>;
}

function DataTable({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return <div className="table-scroll"><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.length ? rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>) : <tr><td colSpan={headers.length}>—</td></tr>}</tbody></table></div>;
}

function KeysPage() {
  const { t, locale } = usePreferences();
  const remote = useRemote(() => api<{ keys: CustomerKey[] }>('/api/keys'), []);
  const [action, setAction] = useState<{ key: CustomerKey; type: 'reveal' | 'rotate' } | null>(null);
  const [secret, setSecret] = useState('');
  async function secretAction(password: string) {
    if (!action) return;
    const result = await api<{ apiKey: string }>(`/api/keys/${action.key.id}/${action.type}`, { method: 'POST', body: JSON.stringify({ password }) });
    setSecret(result.apiKey); setAction(null); await remote.reload();
  }
  return <>
    <PageTitle eyebrow="API / Keys" title={t('keys')} action={<Link className="button" to="/dashboard/buy"><Plus size={17}/>{t('buyKey')}</Link>}/>
    {secret && <div className="secret-banner"><div><ShieldCheck/><span><b>API key</b><code>{secret}</code></span></div><CopyButton value={secret}/><button className="icon-button" onClick={() => setSecret('')}><X/></button></div>}
    {remote.loading ? <Loading/> : remote.error ? <ErrorState message={remote.error} retry={remote.reload}/> : <div className="key-grid">{remote.data?.keys.map((key) => {
      const total = Number(key.creditsTotal), used = Number(key.creditsUsed);
      return <article className="api-key-card" key={key.id}><div className="api-key-top"><span className="key-logo"><KeyRound/></span><div><h3>{key.label}</h3></div><StatusPill status={key.status}/></div>
        <code className="key-hint">{key.keyHint}</code><UsageBar used={used} total={total}/><div className="usage-label"><span>{t('used')} ${used.toFixed(4)}</span><b>${Math.max(0,total-used).toFixed(4)}</b></div>
        <dl><div><dt>{t('expires')}</dt><dd>{key.expiresAt ? formatDate(key.expiresAt, locale) : t('never')}</dd></div><div><dt>{t('concurrentModelRequests')}</dt><dd>{key.concurrencyLimit}</dd></div></dl>
        <div className="card-actions">
          <Link className="button small" to={`/dashboard/keys/${key.id}/setup`}><TerminalSquare size={15}/>{t('connectKey')}</Link>
          <Link className="button small ghost" to={`/dashboard/usage?key=${key.id}`}><BarChart3 size={15}/>{t('usageHistory')}</Link>
          <button className="button small ghost" onClick={() => setAction({ key, type: 'reveal' })}><Eye size={15}/>{t('reveal')}</button>
          <button className="button small ghost" onClick={() => setAction({ key, type: 'rotate' })}><RefreshCw size={15}/>{t('rotate')}</button>
          <button className="icon-button danger" title={t('revoke')} onClick={async () => { if (confirm(t('revoke'))) { await api(`/api/keys/${key.id}/revoke`, { method: 'POST' }); await remote.reload(); } }}><X size={16}/></button>
        </div>
      </article>;
    })}</div>}
    {action && <PasswordModal title={t(action.type)} close={() => setAction(null)} submit={secretAction}/>}
  </>;
}

function PasswordModal({ title, close, submit }: { title: string; close: () => void; submit: (password: string) => Promise<void> }) {
  const { t } = usePreferences(); const [error,setError] = useState(''); const [busy,setBusy]=useState(false);
  return <div className="modal-backdrop"><form className="modal" onSubmit={async (event) => { event.preventDefault(); setBusy(true); setError(''); const password=String(new FormData(event.currentTarget).get('password')); try { await submit(password); } catch(cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } }}><button type="button" className="modal-close" onClick={close}><X/></button><LockKeyhole/><h2>{title}</h2><p>{t('password')}</p>{error && <div className="form-error">{error}</div>}<Field label={t('password')} name="password" type="password" autoFocus required/><button className="button wide" disabled={busy}>{busy?t('loading'):title}</button></form></div>;
}

function KeySetupPage() {
  const { id } = useParams();
  const { t, locale } = usePreferences();
  const ru = locale === 'ru';
  const remote = useRemote(() => api<{ keys: CustomerKey[] }>('/api/keys'));
  if (remote.loading) return <Loading/>;
  if (remote.error) return <ErrorState message={remote.error} retry={remote.reload}/>;
  const key = remote.data?.keys.find((item) => item.id === id);
  if (!key) return <ErrorState message={ru ? 'Ключ не найден' : 'Key not found'}/>;
  return <>
    <PageTitle title={`${t('connectKey')} · ${key.label}`} action={<Link className="button ghost" to="/dashboard/keys">{t('keys')}</Link>}/>
    {key.status !== 'ACTIVE' || key.models.length === 0
      ? <section className="panel"><p>{ru ? 'Сейчас для ключа нет доступных моделей.' : 'This key has no available models right now.'}</p><button className="button ghost" type="button" onClick={() => void remote.reload()}>{t('retry')}</button></section>
      : <ClientSetup models={key.modelOptions}/>}
  </>;
}

interface UsageEntry {
  id: string;
  requestId: string;
  endpoint: string;
  model: string | null;
  inputTokens: string;
  cachedInputTokens: string;
  cacheWrite5mTokens: string;
  cacheWrite1hTokens: string;
  outputTokens: string;
  imageCount: number;
  cost: string;
  status: 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  errorCode: string | null;
  startedAt: string;
}

function UsageTable({ keyId, before }: { keyId: string; before: string | null }) {
  const { t, locale } = usePreferences();
  const ru = locale === 'ru';
  const query = before ? `?${new URLSearchParams({ before })}` : '';
  const remote = useRemote(() => api<{ usage: UsageEntry[]; nextCursor: string | null }>(`/api/keys/${keyId}/usage${query}`), [keyId, query]);
  if (remote.loading) return <Loading/>;
  if (remote.error) return <ErrorState message={remote.error} retry={remote.reload}/>;
  const entries = remote.data?.usage ?? [];
  const next = remote.data?.nextCursor;
  const statuses = ru ? { STARTED: 'В работе', SUCCEEDED: 'Завершён', FAILED: 'Ошибка', CANCELLED: 'Прерван' }
    : { STARTED: 'Running', SUCCEEDED: 'Complete', FAILED: 'Failed', CANCELLED: 'Cancelled' };
  const count = new Intl.NumberFormat(locale);
  return <>
    {entries.length ? <div className="table-scroll"><table className="usage-history-table">
      <thead><tr>{(ru ? ['Время и запрос', 'Модель', 'Вход', 'Из кэша', 'Ответ', 'Списано', 'Статус'] : ['Time and request', 'Model', 'Input', 'Cached', 'Output', 'Charged', 'Status']).map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody>{entries.map((entry) => <tr key={entry.id}>
        <td><span>{formatDate(entry.startedAt, locale)}</span><code title={entry.requestId}>{entry.requestId.slice(0, 8)} · {entry.endpoint}</code></td>
        <td><code>{entry.model ?? '—'}</code></td>
        <td>{count.format(BigInt(entry.inputTokens))}</td><td>{count.format(BigInt(entry.cachedInputTokens))}
          {(entry.cacheWrite5mTokens !== '0' || entry.cacheWrite1hTokens !== '0') && <span>{ru ? 'Записано' : 'Written'}: {count.format(BigInt(entry.cacheWrite5mTokens) + BigInt(entry.cacheWrite1hTokens))}</span>}
        </td>
        <td>{entry.imageCount > 0 ? `${count.format(entry.imageCount)} ${ru ? 'изобр.' : 'images'}` : count.format(BigInt(entry.outputTokens))}</td>
        <td>{entry.status === 'STARTED' ? '—' : money(entry.cost, locale, 'USD', 8)}</td>
        <td>{statuses[entry.status]}{entry.errorCode && <code>{entry.errorCode}</code>}</td>
      </tr>)}</tbody>
    </table></div> : <p className="store-muted">{ru ? 'В этой выборке пока нет запросов.' : 'No requests on this page yet.'}</p>}
    <div className="card-actions usage-pagination">
      <button className="button small ghost" type="button" onClick={() => void remote.reload()}><RefreshCw size={15}/>{t('refresh')}</button>
      {before && <Link className="button small ghost" to={`/dashboard/usage?${new URLSearchParams({ key: keyId })}`}>{ru ? 'К новым запросам' : 'Newest requests'}</Link>}
      {next && <Link className="button small ghost" to={`/dashboard/usage?${new URLSearchParams({ key: keyId, before: next })}`}>{ru ? 'Более ранние' : 'Older requests'}<ArrowRight size={15}/></Link>}
    </div>
  </>;
}

function UsagePage() {
  const { t, locale } = usePreferences();
  const ru = locale === 'ru';
  const navigate = useNavigate();
  const { search } = useLocation();
  const selection = new URLSearchParams(search);
  const remote = useRemote(() => api<{ keys: CustomerKey[] }>('/api/keys'));
  const key = remote.data?.keys.find((item) => item.id === selection.get('key')) ?? remote.data?.keys[0];
  const before = key?.id === selection.get('key') ? selection.get('before') : null;
  return <>
    <PageTitle title={ru ? 'Расход по ключу' : 'Usage by key'} action={<Link className="button ghost" to="/dashboard/keys"><KeyRound size={16}/>{t('keys')}</Link>}/>
    {remote.loading ? <Loading/> : remote.error ? <ErrorState message={remote.error} retry={remote.reload}/> : key ? <section className="panel">
      <div className="usage-heading">
        <label className="field"><span>{t('apiKey')}</span><select value={key.id} onChange={(event) => navigate(`/dashboard/usage?${new URLSearchParams({ key: event.target.value })}`)}>
          {remote.data?.keys.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.keyHint}</option>)}
        </select></label>
        <div><span>{t('remainingCredit')}</span><strong>{money(Math.max(0, Number(key.creditsTotal) - Number(key.creditsUsed)), locale, 'USD', 8)}</strong></div>
      </div>
      <UsageTable key={`${key.id}/${before ?? ''}`} keyId={key.id} before={before}/>
    </section> : <EmptyState icon={BarChart3} text={t('buyKey')} to="/dashboard/buy"/>}
  </>;
}

function BuyPage() {
  const { t, locale } = usePreferences();
  const ru = locale === 'ru';
  const navigate = useNavigate();
  const { search } = useLocation();
  const catalog = useRemote(() => api<StoreCatalog>('/api/products'));
  const exchange = useRemote(() => api<{ rates: PriceRates | null }>('/api/price-rates'));
  const products = catalog.data?.products ?? [];
  const methods = catalog.data?.paymentMethods ?? [];
  const [chosenMethod, setChosenMethod] = useState<PaymentMethod>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const selection = new URLSearchParams(search).get('product');
  const product = products.find((item) => item.id === selection) ?? products.find((item) => item.inventory > 0) ?? products[0];
  const method = chosenMethod && methods.includes(chosenMethod) ? chosenMethod : methods[0];
  const cryptoCurrency = catalog.data?.cryptoCurrency;

  async function purchase() {
    if (!product || product.inventory < 1 || !method || busy) return;
    setBusy(true);
    setError('');
    try {
      const { order } = await api<{ order: Order }>('/api/orders', {
        method: 'POST', body: JSON.stringify({ productId: product.id, paymentProvider: method }),
      });
      if (order.checkoutUrl && new URL(order.checkoutUrl, window.location.origin).origin !== window.location.origin) {
        window.location.assign(order.checkoutUrl);
      } else navigate(`/dashboard/orders/${order.id}`);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'NO_UPSTREAM_CAPACITY') {
        setError(ru ? 'Свободные места закончились. Обновите наличие.' : 'This package just sold out. Refresh availability.');
      } else if (cause instanceof ApiError && cause.code === 'PAYMENT_PROVIDER_ERROR') {
        setError(ru ? 'Платёжная система не смогла выставить счёт. Проверьте способ оплаты или выберите другой пакет.' : 'The payment processor could not create an invoice. Check the payment method or choose another package.');
      } else setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  return <><PageTitle title={t('buyKey')}/>
    {catalog.loading ? <Loading/> : catalog.error ? <ErrorState message={catalog.error} retry={catalog.reload}/> : <div className="checkout-layout">
      <div><div className="selectable-products">{products.map((item) => <button type="button" key={item.id} className={product?.id === item.id ? 'selected' : ''}
        onClick={() => { setError(''); navigate(`/dashboard/buy?${new URLSearchParams({ product: item.id })}`, { replace: true }); }}>
        <span><Package/>{item.inventory > 0 ? (ru ? 'Доступен' : 'Available') : (ru ? 'Нет мест' : 'Unavailable')}</span>
        <b>{item.name}</b><strong>{money(item.retailPrice, locale)}</strong>
      </button>)}</div>
      <section className="panel payment-panel"><h2>{t('paymentMethod')}</h2>
        {methods.length === 0 ? <p className="store-muted">{ru ? 'Оплата пока отключена.' : 'Payments are currently disabled.'}</p> : <div className="payment-options">{methods.map((item) => <button type="button" className={method === item ? 'selected' : ''} aria-pressed={method === item} onClick={() => setChosenMethod(item)} key={item}>
          {item === 'stripe' ? <CreditCard/> : item === 'nowpayments' ? <Wallet/> : <Zap/>}<span>
            <b>{item === 'stripe' ? t('card') : item === 'nowpayments' ? cryptoCurrency ?? t('crypto') : t('testPayment')}</b>
            <small>{item === 'stripe' ? 'Stripe · USD' : item === 'nowpayments' ? 'NOWPayments' : (ru ? 'Локальная проверка' : 'Local testing')}</small>
          </span><i/>
        </button>)}</div>}
      </section></div>
      {product && <aside className="order-summary"><h2>{product.name}</h2>
        <dl><div><dt>{ru ? 'Срок с выдачи' : 'Valid after issuance'}</dt><dd>{product.durationDays ? `${product.durationDays} ${t('days')}` : t('noExpiry')}</dd></div>
          <div><dt>{t('concurrentModelRequests')}</dt><dd>{product.concurrencyLimit}</dd></div>
        </dl>
        <p>{t('concurrentRequestHelp')}</p>
        <div className="summary-total"><span>{t('amount')}</span><strong>{money(product.retailPrice, locale)} <small>USD</small></strong></div>
        <PriceCurrencies usd={product.retailPrice} rates={exchange.data?.rates ?? null} loading={exchange.loading}/>
        {method === 'nowpayments' && <p>{ru ? 'Точная сумма и адрес будут в счёте.' : 'The invoice will show the exact amount and address.'}</p>}
        {error && <div className="form-error" role="alert">{error}</div>}
        {product.inventory < 1 ? <button className="button wide ghost" type="button" onClick={() => void catalog.reload()}><RefreshCw size={16}/>{ru ? 'Проверить наличие' : 'Refresh availability'}</button>
          : <button className="button wide large" type="button" disabled={busy || !method} onClick={() => void purchase()}>{busy ? t('loading') : t('continuePayment')}<ArrowRight size={17}/></button>}
      </aside>}
    </div>}
  </>;
}

function OrdersPage(){const{t,locale}=usePreferences();const remote=useRemote(()=>api<{orders:Order[]}>('/api/orders'),[]);return <><PageTitle eyebrow="Billing / Orders" title={t('orders')}/>{remote.loading?<Loading/>:remote.error?<ErrorState message={remote.error}/>:<section className="panel"><DataTable headers={[t('order'),t('paymentMethod'),t('amount'),t('status'),t('created')]} rows={(remote.data?.orders??[]).map(order=>[<Link to={`/dashboard/orders/${order.id}`}>{order.productName}</Link>,order.paymentProvider,`${order.amount} ${order.currency}`,<StatusPill status={order.status}/>,formatDate(order.createdAt,locale)])}/></section>}</>}

function OrderPage() {
  const { id } = useParams();
  const { t, locale } = usePreferences();
  const remote = useRemote(() => api<{ order: Order }>(`/api/orders/${id}`), [id]);
  const [actionError, setActionError] = useState('');
  const order = remote.data?.order.id === id ? remote.data?.order : undefined;
  const refresh = order?.status === 'PENDING' || order?.status === 'PAID';
  const { reload } = remote;
  useEffect(() => {
    if (!refresh) return;
    const timer = window.setInterval(() => { if (!document.hidden) void reload(); }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh, reload]);
  if (remote.loading && !order) return <Loading/>;
  if (remote.error || !order) return <ErrorState message={remote.error ?? 'Not found'} retry={reload}/>;
  const meta = order.metadata;
  const crypto = order.paymentProvider === 'nowpayments';
  const invoiceDates = [Date.parse(order.reservedUntil)];
  if (crypto && typeof meta.expirationEstimateDate === 'string') {
    const expiry = Date.parse(meta.expirationEstimateDate);
    if (Number.isFinite(expiry)) invoiceDates.push(expiry);
  }
  const invoiceDeadline = Math.min(...invoiceDates);
  const pending = order.status === 'PENDING' && invoiceDeadline > Date.now();
  return <>
    <PageTitle eyebrow={`Billing / ${order.id.slice(0, 8)}`} title={order.productName} action={<StatusPill status={order.status}/>}/>
    <div className="order-detail">
      <section className="panel">
        <h2>{t('order')}</h2>
        <dl className="detail-list">
          <div><dt>ID</dt><dd><code>{order.id}</code></dd></div>
          <div><dt>{t('amount')}</dt><dd>{order.amount} {order.currency}</dd></div>
          <div><dt>{t('paymentMethod')}</dt><dd>{order.paymentProvider}</dd></div>
          <div><dt>{t('created')}</dt><dd>{formatDate(order.createdAt, locale)}</dd></div>
        </dl>
        {order.status === 'PAID' && <div className="info-box"><Activity/><p>{t('paidAwaitingKeyHint')}</p></div>}
        {actionError && <div className="form-error">{actionError}</div>}
        <div className="card-actions">
          {pending && order.checkoutUrl && order.paymentProvider === 'stripe' && <a className="button" href={order.checkoutUrl}>{t('continuePayment')}<ArrowRight size={16}/></a>}
          {pending && order.paymentProvider === 'mock' && <button className="button" onClick={async () => {
            setActionError('');
            try { await api(`/api/payments/mock/${order.id}/complete`, { method: 'POST' }); await remote.reload(); }
            catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
          }}>{t('completeMock')}</button>}
          {refresh && <button className="button ghost" type="button" onClick={() => void remote.reload()}><RefreshCw size={16}/>{t('status')}</button>}
        </div>
      </section>
      {crypto && order.status === 'PENDING' && !pending && <section className="panel"><p>{locale === 'ru' ? 'Срок счёта истёк. Если уже отправили платёж, проверьте статус этого заказа.' : 'This invoice expired. If you already paid, check the status of this order.'}</p></section>}
      {pending && crypto && !!meta.payAddress && <section className="panel crypto-invoice">
        <Wallet/><h2>{t('crypto')}</h2>
        {Boolean(meta.network) && <><p>{t('network')}</p><strong>{String(meta.network)}</strong></>}
        <p>{t('payAmount')}</p><strong>{String(meta.payAmount ?? '')} {String(meta.payCurrency ?? '').toUpperCase()}</strong>
        <p>{t('payAddress')}</p><code>{String(meta.payAddress)}</code><CopyButton value={String(meta.payAddress)}/>
        {Boolean(meta.payinExtraId) && <><p>Memo / tag</p><code>{String(meta.payinExtraId)}</code><CopyButton value={String(meta.payinExtraId)}/></>}
        <p>{t('expires')} {formatDate(new Date(invoiceDeadline).toISOString(), locale)}</p>
      </section>}
      {order.apiKeyId && <section className="panel success-panel"><ShieldCheck/><h2>{t('keys')}</h2><p>{order.keyHint}</p><div className="card-actions"><Link className="button" to={`/dashboard/keys/${order.apiKeyId}/setup`}>{t('connectKey')}<ArrowRight size={16}/></Link><Link className="button ghost" to="/dashboard/keys">{t('keys')}</Link></div></section>}
    </div>
  </>;
}

function ProfilePage(){const{t,locale,setLocale,theme,setTheme}=usePreferences();const{user,refresh}=useAuth();const[message,setMessage]=useState('');async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=new FormData(event.currentTarget);await api('/api/profile',{method:'PATCH',body:JSON.stringify({name:String(form.get('name')),walletNetwork:String(form.get('walletNetwork'))||null,walletAddress:String(form.get('walletAddress'))||null,locale,theme})});await refresh();setMessage('✓');}return <><PageTitle eyebrow="Account / Profile" title={t('profile')}/><form className="profile-grid" onSubmit={submit}><section className="panel"><h2>{t('profile')}</h2><Field label={t('name')} name="name" defaultValue={user?.name??''} required/><Field label={t('email')} name="email" defaultValue={user?.email??''} disabled/><h3>{t('language')}</h3><div className="segmented"><button type="button" className={locale==='ru'?'active':''} onClick={()=>setLocale('ru')}>Русский</button><button type="button" className={locale==='en'?'active':''} onClick={()=>setLocale('en')}>English</button></div><h3>{t('theme')}</h3><div className="segmented">{(['SYSTEM','LIGHT','DARK']as Theme[]).map(value=><button type="button" className={theme===value?'active':''} onClick={()=>setTheme(value)} key={value}>{value==='SYSTEM'?<Settings2/>:value==='LIGHT'?<Sun/>:<Moon/>}{t(value.toLowerCase())}</button>)}</div></section><section className="panel"><h2>{t('wallet')}</h2><div className="info-box"><ShieldCheck/><p>{t('walletHint')}</p></div><Field label={t('network')} name="walletNetwork" defaultValue={user?.walletNetwork??''} placeholder="TRC20 / ERC20 / SOL"/><Field label={t('walletAddress')} name="walletAddress" defaultValue={user?.walletAddress??''}/><button className="button">{t('save')} {message}</button></section></form></>}

function AdminOverview(){const{t}=usePreferences();const remote=useRemote(()=>api<{stats:Record<string,string|number>}>('/api/admin/stats'),[]);const s=remote.data?.stats;return <><PageTitle eyebrow="Operations / Admin" title={t('overview')}/>{remote.loading?<Loading/>:<div className="stat-grid admin-stats"><StatCard icon={Users} label={t('users')} value={String(s?.users??0)} accent="blue"/><StatCard icon={KeyRound} label={t('activeKeys')} value={String(s?.activeKeys??0)} accent="violet"/><StatCard icon={CircleDollarSign} label={t('revenue')} value={`$${s?.grossRevenue??0}`} accent="green"/><StatCard icon={Gauge} label={t('upstreamCost')} value={`$${s?.wholesaleCost??0}`} accent="orange"/><StatCard icon={Package} label={t('pending')} value={String(s?.pendingOrders??0)} accent="blue"/></div>}</>}

function AdminProviders() {
  const { t, locale } = usePreferences();
  const ru = locale === 'ru';
  const pools = useRemote(() => api<{ pools: AnyRecord[] }>('/api/admin/pools'), []);
  const creds = useRemote(() => api<{ credentials: AnyRecord[] }>('/api/admin/credentials'), []);
  const rates = useRemote(() => api<{ rates: AnyRecord[] }>('/api/admin/rates'), []);
  const [error, setError] = useState('');
  const protocols = [ ['OPENAI', 'Responses + Chat Completions'], ['OPENAI_CHAT', 'Chat Completions'],
    ['ANTHROPIC', 'Anthropic Messages'], ['GEMINI', 'Gemini'], ['IMAGES', 'Images'] ];
  const poolList = pools.data?.pools ?? [];

  async function addPool(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const element = event.currentTarget; const form = new FormData(element); setError('');
    try {
      await api('/api/admin/pools', { method: 'POST', body: JSON.stringify({
        name: form.get('name'), slug: form.get('slug'), baseUrl: form.get('baseUrl'),
        protocol: form.get('protocol'), parentPoolId: form.get('parentPoolId') || null,
        routingPriority: Number(form.get('routingPriority')),
        credentialCapacity: Number(form.get('capacity')), active: true,
      }) });
      element.reset(); await pools.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function addCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const element = event.currentTarget; const form = new FormData(element); setError('');
    try {
      await api(`/api/admin/pools/${form.get('poolId')}/credentials`, { method: 'POST', body: JSON.stringify({
        label: form.get('label'), apiKey: form.get('apiKey'),
        maxConcurrency: Number(form.get('maxConcurrency')), priority: 100, spendLimit: String(form.get('spendLimit') || '') || null,
        testOnly: form.has('testOnly'),
      }) });
      element.reset(); await Promise.all([creds.reload(), pools.reload()]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function addRate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const element = event.currentTarget; const form = new FormData(element); setError('');
    try {
      await api('/api/admin/rates', { method: 'POST', body: JSON.stringify({
        poolId: form.get('poolId'), model: form.get('model'),
        inputPerMillion: form.get('inputRate'), outputPerMillion: form.get('outputRate'),
        cachedInputPerMillion: form.get('cachedRate'), perRequest: form.get('requestRate') || '0',
        longContextThreshold: form.get('contextThreshold') ? Number(form.get('contextThreshold')) : null,
        longContextMultiplier: form.get('contextMultiplier') || '1', active: true,
        ...(form.get('peakMultiplier') ? { peakMultiplier: Number(form.get('peakMultiplier')) } : {}),
      }) });
      element.reset(); await rates.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function updateCredential(credential: AnyRecord, change: { status?: 'ACTIVE' | 'DISABLED'; testOnly?: boolean }) {
    setError('');
    try {
      await api(`/api/admin/credentials/${credential.id}`, { method: 'PATCH', body: JSON.stringify(change) });
      await Promise.all([creds.reload(), pools.reload()]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <>
    <PageTitle eyebrow="Routing / Providers" title={t('providers')}/>
    {error && <div className="form-error">{error}</div>}
    <div className="admin-form-grid">
      <form className="panel compact-form" onSubmit={addPool}>
        <h2>{t('addProvider')}</h2>
        <Field label={t('providerName')} name="name" required/>
        <Field label={t('slug')} name="slug" required pattern="[a-z0-9-]+"/>
        <Field label={t('baseUrl')} name="baseUrl" type="url" required placeholder="https://provider.example"/>
        <label className="field"><span>{ru ? 'Протокол' : 'Protocol'}</span><select name="protocol">{protocols.map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>
        <label className="field"><span>{ru ? 'Объединить с пулом' : 'Link to pool'}</span><select name="parentPoolId"><option value="">{ru ? 'Отдельный пул' : 'Standalone pool'}</option>{poolList.filter((pool) => !pool.parentPoolId).map((pool) => <option key={String(pool.id)} value={String(pool.id)}>{String(pool.name)}</option>)}</select></label>
        <Field label={ru ? 'Приоритет маршрута' : 'Routing priority'} name="routingPriority" type="number" min={0} max={10000} defaultValue={0} required/>
        <Field label={t('usersPerKey')} name="capacity" type="number" min={1} defaultValue={2} required/>
        <button className="button"><Plus/>{t('add')}</button>
      </form>
      <form className="panel compact-form" onSubmit={addCredential}>
        <h2>{t('addCredential')}</h2>
        <label className="field"><span>{t('provider')}</span><select name="poolId" required>{pools.data?.pools.map((pool) => <option key={String(pool.id)} value={String(pool.id)}>{String(pool.name)}</option>)}</select></label>
        <Field label={t('label')} name="label" required/>
        <Field label={t('apiKey')} name="apiKey" type="password" required/>
        <Field label={t('maxConcurrency')} name="maxConcurrency" type="number" min={1} defaultValue={8} required/>
        <Field label={t('spendLimit')} name="spendLimit" type="number" min="0.00000001" step="0.00000001"/>
        <label className="form-hint"><input type="checkbox" name="testOnly"/> {ru ? 'Только для тестовой оплаты' : 'Use for mock payments only'}</label>
        <button className="button"><Plus/>{t('add')}</button>
      </form>
      <form className="panel compact-form" onSubmit={addRate}>
        <h2>{t('addRate')}</h2>
        <label className="field"><span>{t('provider')}</span><select name="poolId" required>{pools.data?.pools.map((pool) => <option key={String(pool.id)} value={String(pool.id)}>{String(pool.name)}</option>)}</select></label>
        <Field label={t('model')} name="model" required placeholder="model-id"/>
        <Field label={t('inputRate')} name="inputRate" type="number" min="0" step="0.00000001" defaultValue="0" required/>
        <Field label={t('outputRate')} name="outputRate" type="number" min="0" step="0.00000001" defaultValue="0" required/>
        <Field label={t('cachedRate')} name="cachedRate" type="number" min="0" step="0.00000001" defaultValue="0" required/>
        <Field label={t('requestRate')} name="requestRate" type="number" min="0" step="0.00000001" defaultValue="0" required/>
        <Field label={t('contextThreshold')} name="contextThreshold" type="number" min="1" placeholder="272000"/>
        <Field label={t('contextMultiplier')} name="contextMultiplier" type="number" min="1" step="0.01" defaultValue="1" required/>
        <Field label={ru ? 'Множитель часов пик' : 'Peak-hour multiplier'} name="peakMultiplier" type="number" min="1" max="10" step="0.0001" placeholder="1"/>
        <button className="button"><Plus/>{t('add')}</button>
      </form>
    </div>
    <section className="panel"><h2>{t('providers')}</h2><DataTable headers={[t('provider'), ru ? 'Протокол' : 'Protocol', ru ? 'Родительский пул' : 'Parent pool', t('baseUrl'), t('usersPerKey'), 'Credentials', 'Assigned']} rows={poolList.map((pool) => [String(pool.name), protocols.find(([id]) => id === pool.protocol)?.[1] ?? '—', String(poolList.find(({ id }) => id === pool.parentPoolId)?.name ?? '—'), <code>{String(pool.baseUrl)}</code>, String(pool.credentialCapacity), String(pool.credentialCount), String(pool.assignedKeys)])}/></section>
    <section className="panel"><div className="panel-head"><h2>{t('upstreamCredentials')}</h2><button className="button ghost small" onClick={() => void creds.reload()}><RefreshCw size={15}/>{t('status')}</button></div>
      <DataTable headers={[t('provider'), t('label'), t('apiKey'), t('status'), t('catalogModels'), t('lastHealthCheck'), t('providerIssue'), '']}
        rows={(creds.data?.credentials ?? []).map((credential) => {
          const models = Array.isArray(credential.availableModels) ? credential.availableModels.map(String) : [];
          const status = String(credential.status);
          const stale = status === 'ACTIVE' && (!credential.catalogValidUntil || Date.parse(String(credential.catalogValidUntil)) <= Date.now());
          return [String(credential.poolName), <span>{String(credential.label)}{Boolean(credential.testOnly) && <small className="catalog-status"> · {ru ? 'Тестовый' : 'Test only'}</small>}</span>, <code>{String(credential.keyHint)}</code>, <StatusPill status={stale ? 'DEGRADED' : status}/>,
            <span title={models.join(', ')}>{models.length || '—'}</span>, formatDate(credential.lastHealthAt ? String(credential.lastHealthAt) : null, locale),
            <span className="credential-issue">{String(credential.lastError ?? '—')}</span>,
            <div className="row-actions">{status !== 'EXHAUSTED' && <button className="text-button" onClick={() => void updateCredential(credential, { status: 'ACTIVE' })}>{status === 'DISABLED' ? t('activate') : t('refreshCatalog')}</button>}
              {status !== 'DISABLED' && <button className="text-button" onClick={() => void updateCredential(credential, { status: 'DISABLED' })}>{t('disable')}</button>}
              {!credential.testOnly && <button className="text-button" onClick={() => void updateCredential(credential, { testOnly: true })}>{ru ? 'Только для теста' : 'Mark test only'}</button>}</div>];
        })}/>
    </section>
    <section className="panel"><h2>{t('modelRates')}</h2><DataTable headers={[t('provider'), t('model'), t('inputRate'), t('outputRate'), t('cachedRate'), t('requestRate'), t('contextMultiplier'), ru ? 'Часы пик' : 'Peak hours', t('status')]} rows={(rates.data?.rates ?? []).map((rate) => [String(rate.providerName), <code>{String(rate.model)}</code>, String(rate.inputPerMillion), String(rate.outputPerMillion), String(rate.cachedInputPerMillion), String(rate.perRequest), rate.longContextThreshold ? `${String(rate.longContextMultiplier)}× > ${String(rate.longContextThreshold)}` : '—', Number(rate.peakMultiplier) > 1 ? `${Number(rate.peakMultiplier)}×` : '—', <StatusPill status={Boolean(rate.active) ? 'ACTIVE' : 'DISABLED'}/>])}/></section>
  </>;
}

function AdminProducts(){const{t}=usePreferences();const products=useRemote(()=>api<{products:AnyRecord[];priceMarkup:string}>('/api/admin/products'),[]);const pools=useRemote(()=>api<{pools:AnyRecord[]}>('/api/admin/pools'),[]);const[error,setError]=useState('');async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();const f=new FormData(event.currentTarget);try{await api('/api/admin/products',{method:'POST',body:JSON.stringify({poolId:f.get('poolId'),name:f.get('name'),slug:f.get('slug'),description:f.get('description'),wholesaleCredits:f.get('credits'),currency:'USD',durationDays:Number(f.get('duration')),concurrencyLimit:Number(f.get('concurrency')),active:true})});event.currentTarget.reset();await products.reload();}catch(e){setError(e instanceof Error?e.message:String(e));}}return <><PageTitle eyebrow="Store / Products" title={t('products')}/><div className="notice-line"><CircleDollarSign/>PRICE_MARKUP = <b>{products.data?.priceMarkup??'—'}×</b></div>{error&&<div className="form-error">{error}</div>}<form className="panel inline-admin-form" onSubmit={submit}><h2>{t('addProduct')}</h2><label className="field"><span>{t('provider')}</span><select name="poolId" required>{pools.data?.pools.map(p=><option value={String(p.id)} key={String(p.id)}>{String(p.name)}</option>)}</select></label><Field label={t('providerName')} name="name" required/><Field label={t('slug')} name="slug" required pattern="[a-z0-9-]+"/><Field label={t('wholesaleCredits')} name="credits" type="number" step="0.0001" min="0.0001" required/><Field label={t('duration')} name="duration" type="number" min={1} defaultValue={30} required/><Field label="Concurrency" name="concurrency" type="number" min={1} defaultValue={2} required/><label className="field wide-field"><span>{t('description')}</span><input name="description"/></label><button className="button"><Plus/>{t('add')}</button></form><section className="panel"><DataTable headers={[t('provider'),t('providerName'),t('wholesaleCredits'),t('duration'),t('status')]} rows={(products.data?.products??[]).map(p=>[String(p.providerName),String(p.name),`$${String(p.wholesaleCredits)}`,`${String(p.durationDays)} ${t('days')}`,<StatusPill status={Boolean(p.active)?'ACTIVE':'DISABLED'}/>])}/></section></>}

function AdminUsers(){const{t,locale}=usePreferences();const remote=useRemote(()=>api<{users:(User&AnyRecord)[]}>('/api/admin/users'),[]);async function update(id:string,body:AnyRecord){await api(`/api/admin/users/${id}`,{method:'PATCH',body:JSON.stringify(body)});await remote.reload();}return <><PageTitle eyebrow="Access / Users" title={t('users')}/>{remote.loading?<Loading/>:<section className="panel"><DataTable headers={[t('email'),t('name'),t('role'),t('userStatus'),t('keys'),t('created'),'']} rows={(remote.data?.users??[]).map(u=>[u.email,u.name??'—',<StatusPill status={u.role}/>,<StatusPill status={String(u.status)}/>,String(u.keyCount),formatDate(String(u.createdAt),locale),<div className="row-actions"><button className="text-button" onClick={()=>update(u.id,{status:u.status==='ACTIVE'?'SUSPENDED':'ACTIVE'})}>{u.status==='ACTIVE'?'Suspend':'Activate'}</button><button className="text-button" onClick={()=>update(u.id,{role:u.role==='ADMIN'?'USER':'ADMIN'})}>{u.role==='ADMIN'?'Make user':'Make admin'}</button></div>])}/></section>}</>}

function AdminOrders(){const{t,locale}=usePreferences();const remote=useRemote(()=>api<{orders:AnyRecord[]}>('/api/admin/orders'),[]);return <><PageTitle eyebrow="Billing / Orders" title={t('orders')}/>{remote.loading?<Loading/>:<section className="panel"><DataTable headers={[t('email'),t('order'),t('provider'),t('paymentMethod'),t('amount'),t('status'),t('created')]} rows={(remote.data?.orders??[]).map(o=>[String(o.userEmail),String(o.productName),String(o.providerName),String(o.paymentProvider),`${String(o.amount)} ${String(o.currency)}`,<StatusPill status={String(o.status)}/>,formatDate(String(o.createdAt),locale)])}/></section>}</>}

function Monitoring(){const{t}=usePreferences();return <><PageTitle eyebrow="Observability / Grafana" title={t('monitoring')} action={<a className="button" href="/grafana/" target="_blank" rel="noreferrer"><BarChart3/>{t('openGrafana')}</a>}/><div className="monitor-grid"><article className="panel"><Activity/><h2>Service health</h2><p>Readiness checks PostgreSQL and reports upstream state without leaking credentials.</p><a href="/health/ready" target="_blank" rel="noreferrer">/health/ready <ArrowRight/></a></article><article className="panel"><Gauge/><h2>Prometheus</h2><p>Latency, throughput, 5xx rate, event-loop lag, memory, active streams, pool capacity, and cost.</p><code>prometheus:9090</code></article><article className="panel"><BarChart3/><h2>Grafana dashboard</h2><p>Pre-provisioned panels and alerts for saturation, provider degradation, and database health.</p><a href="/grafana/" target="_blank" rel="noreferrer">{t('openGrafana')} <ArrowRight/></a></article></div></>}

export function App() {
  return <><ScrollToRoute/><Routes>
    <Route path="/" element={<LandingPage/>}/><Route path="/setup" element={<SetupPage/>}/><Route path="/docs" element={<DocsPage/>}/><Route path="/login" element={<AuthPage mode="login"/>}/><Route path="/register" element={<AuthPage mode="register"/>}/>
    <Route element={<ProtectedRoute/>}>
      <Route element={<AppShell/>}>
        <Route path="/dashboard" element={<DashboardOverview/>}/>
        <Route path="/dashboard/keys" element={<KeysPage/>}/>
        <Route path="/dashboard/keys/:id/setup" element={<KeySetupPage/>}/>
        <Route path="/dashboard/usage" element={<UsagePage/>}/>
        <Route path="/dashboard/buy" element={<BuyPage/>}/>
        <Route path="/dashboard/orders" element={<OrdersPage/>}/>
        <Route path="/dashboard/orders/:id" element={<OrderPage/>}/>
        <Route path="/dashboard/profile" element={<ProfilePage/>}/>
      </Route>
    </Route>
    <Route element={<ProtectedRoute admin/>}><Route element={<AppShell admin/>}><Route path="/admin" element={<AdminOverview/>}/><Route path="/admin/providers" element={<AdminProviders/>}/><Route path="/admin/products" element={<AdminProducts/>}/><Route path="/admin/users" element={<AdminUsers/>}/><Route path="/admin/orders" element={<AdminOrders/>}/><Route path="/admin/monitoring" element={<Monitoring/>}/></Route></Route>
    <Route path="*" element={<Navigate to="/" replace/>}/>
  </Routes></>;
}
