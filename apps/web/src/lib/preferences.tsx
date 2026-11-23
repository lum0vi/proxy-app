import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Locale = 'ru' | 'en';
export type Theme = 'SYSTEM' | 'LIGHT' | 'DARK';

type Dictionary = Record<string, string>;

const dictionaries: Record<Locale, Dictionary> = {
  ru: {
    usageHistory: 'Расход', connectKey: 'Подключить', refresh: 'Обновить', openMenu: 'Открыть меню',
    home: 'Главная', docs: 'Документация', login: 'Войти', register: 'Создать аккаунт', dashboard: 'Кабинет',
    buyKey: 'Купить ключ', topUp: 'Пополнить ключ', keys: 'API-ключи', orders: 'Заказы', profile: 'Профиль', admin: 'Админка', logout: 'Выйти',
    heroEyebrow: 'OpenAI-compatible · Responses API · Streaming',
    heroTitleA: 'Один ключ.', heroTitleB: 'Несколько AI-провайдеров.',
    heroText: 'Покупайте prepaid API-ключи с прозрачным лимитом. Подключайте Codex, OpenCode и любые OpenAI-совместимые клиенты заменой Base URL.',
    getKey: 'Выбрать ключ', viewDocs: 'Как подключиться', liveRouting: 'Живая маршрутизация',
    whyTitle: 'Прозрачная экономика без сюрпризов', whyText: 'Каждый ключ получает фиксированный wholesale-лимит. Вы видите расход, срок действия и состояние провайдера в реальном времени.',
    featureProxy: 'Нативный API', featureProxyText: 'Responses, Chat Completions, tool calls и SSE проходят без изменения формата.',
    featureSecurity: 'Ключи защищены', featureSecurityText: 'Секреты зашифрованы AES-256-GCM, пароли — scrypt, выдача платежа идемпотентна.',
    featureControl: 'Лимиты под контролем', featureControlText: 'Баланс, срок, concurrency и история запросов доступны в кабинете.',
    howTitle: 'От оплаты до первого запроса', howText: 'Создайте аккаунт, один раз оплатите prepaid-ключ и вставьте готовую конфигурацию. Никаких обязательных месячных платежей.', step1: 'Выберите пакет', step1Text: 'Цена и лимит фиксируются при создании заказа.', step2: 'Оплатите один раз', step2Text: 'USDT в сети TON.', step3: 'Подключите', step3Text: 'Скопируйте Base URL и персональный ключ.',
    pricing: 'Доступные ключи', wholesaleCredit: 'лимит использования', days: 'дней', noExpiry: 'Без срока действия', concurrency: 'параллельных запросов', available: 'доступно', soldOut: 'нет мест', buy: 'Купить ключ',
    email: 'Почта', password: 'Пароль', name: 'Имя', haveAccount: 'Уже есть аккаунт?', noAccount: 'Нет аккаунта?',
    overview: 'Обзор', activeKeys: 'Активные ключи', remainingCredit: 'Баланс', recentOrders: 'Последние заказы',
    reveal: 'Показать', rotate: 'Перевыпустить', revoke: 'Отозвать', expires: 'Истекает', never: 'Никогда', used: 'Использовано',
    concurrentModelRequests: 'Запросы к моделям одновременно',
    concurrentRequestHelp: 'Лимит действует на один API-ключ. Если все места заняты, новый запрос вернёт ошибку 429. Повторите его после завершения одного из текущих.',
    paymentMethod: 'Способ оплаты', card: 'Карта', crypto: 'Криптовалюта', testPayment: 'Тестовая оплата', continuePayment: 'Перейти к оплате',
    order: 'Заказ', status: 'Статус', amount: 'Сумма', created: 'Создан', payAddress: 'Адрес оплаты', payAmount: 'Сумма к переводу', completeMock: 'Подтвердить тестовую оплату',
    wallet: 'Платёжный кошелёк', walletHint: 'Храним только публичный адрес. Никогда не вводите seed-фразу или приватный ключ.', network: 'Сеть', walletAddress: 'Публичный адрес', save: 'Сохранить', language: 'Язык', theme: 'Тема', system: 'Системная', light: 'Светлая', dark: 'Тёмная',
    providers: 'Провайдеры', products: 'Товары', users: 'Пользователи', monitoring: 'Мониторинг',
    addProvider: 'Добавить провайдера', providerName: 'Название', slug: 'Slug', baseUrl: 'Base URL', usersPerKey: 'Пользователей на upstream-ключ', add: 'Добавить',
    addCredential: 'Добавить upstream-ключ', provider: 'Провайдер', label: 'Метка', apiKey: 'API-ключ', maxConcurrency: 'Макс. concurrency',
    upstreamCredentials: 'Ключи провайдера', spendLimit: 'Лимит расходов ключа провайдера, USD', catalogModels: 'Модели в каталоге', lastHealthCheck: 'Последняя проверка', providerIssue: 'Причина недоступности', refreshCatalog: 'Проверить каталог',
    paidAwaitingKey: 'Оплачено, ожидает выдачи', paidAwaitingKeyHint: 'Платёж подтверждён. Мы выдадим ключ автоматически, когда появится свободное место. Повторная оплата не нужна.',
    paidAwaitingTopUp: 'Оплачено, ожидает зачисления', paidAwaitingTopUpHint: 'Платёж подтверждён. Пополнение зачислится, когда ключу будет доступно место. Повторная оплата не нужна.',
    baseUrlHint: 'Можно вставить адрес с /v1 или без него — суффикс нормализуется автоматически.', modelRates: 'Тарифы моделей', addRate: 'Добавить тариф', model: 'Модель', inputRate: 'Input / 1M, USD', outputRate: 'Output / 1M, USD', cachedRate: 'Cached / 1M, USD', requestRate: 'За запрос, USD', contextThreshold: 'Порог long context', contextMultiplier: 'Long context ×', disable: 'Отключить', activate: 'Включить',
    addProduct: 'Добавить товар', description: 'Описание', wholesaleCredits: 'Wholesale-лимит, USD', duration: 'Срок, дней',
    role: 'Роль', userStatus: 'Статус', revenue: 'Выручка', upstreamCost: 'Себестоимость', pending: 'Ожидают оплаты', openGrafana: 'Открыть Grafana',
    copied: 'Скопировано', loading: 'Загрузка…', error: 'Ошибка', retry: 'Повторить',
    connectTitle: 'Подключение за минуту', connectText: 'Выберите клиент, скопируйте готовый блок и замените пример ключа на купленный pk_live_…', readyConfig: 'Готовые конфигурации', readDocs: 'Открыть полную документацию',
  },
  en: {
    usageHistory: 'Usage', connectKey: 'Connect', refresh: 'Refresh', openMenu: 'Open menu',
    home: 'Home', docs: 'Documentation', login: 'Sign in', register: 'Create account', dashboard: 'Dashboard',
    buyKey: 'Buy a key', topUp: 'Top up key', keys: 'API keys', orders: 'Orders', profile: 'Profile', admin: 'Admin', logout: 'Sign out',
    heroEyebrow: 'OpenAI-compatible · Responses API · Streaming',
    heroTitleA: 'One key.', heroTitleB: 'Multiple AI providers.',
    heroText: 'Buy prepaid API keys with a transparent limit. Connect Codex, OpenCode, and any OpenAI-compatible client by changing the Base URL.',
    getKey: 'Choose a key', viewDocs: 'How to connect', liveRouting: 'Live routing',
    whyTitle: 'Transparent economics, no surprises', whyText: 'Every key gets a fixed wholesale allowance. See usage, expiration, and provider health in real time.',
    featureProxy: 'Native API', featureProxyText: 'Responses, Chat Completions, tool calls, and SSE keep their original format.',
    featureSecurity: 'Protected keys', featureSecurityText: 'Secrets use AES-256-GCM, passwords use scrypt, and payment fulfillment is idempotent.',
    featureControl: 'Limits in control', featureControlText: 'Balance, expiration, concurrency, and request history stay visible.',
    howTitle: 'From payment to first request', howText: 'Create an account, pay once for a prepaid key, and paste the ready configuration. There are no required monthly charges.', step1: 'Choose a package', step1Text: 'The price and allowance are locked when the order is created.', step2: 'Pay once', step2Text: 'USDT on the TON network.', step3: 'Connect', step3Text: 'Copy the Base URL and your personal key.',
    pricing: 'Available keys', wholesaleCredit: 'usage allowance', days: 'days', noExpiry: 'No expiration', concurrency: 'concurrent requests', available: 'available', soldOut: 'sold out', buy: 'Buy key',
    email: 'Email', password: 'Password', name: 'Name', haveAccount: 'Already have an account?', noAccount: 'No account yet?',
    overview: 'Overview', activeKeys: 'Active keys', remainingCredit: 'Credits remaining', recentOrders: 'Recent orders',
    reveal: 'Reveal', rotate: 'Rotate', revoke: 'Revoke', expires: 'Expires', never: 'Never', used: 'Used',
    concurrentModelRequests: 'Model requests at once',
    concurrentRequestHelp: 'The limit applies to each API key. A new request returns a 429 error when the limit is reached. Retry after a running request finishes.',
    paymentMethod: 'Payment method', card: 'Card', crypto: 'Crypto', testPayment: 'Test payment', continuePayment: 'Continue to payment',
    order: 'Order', status: 'Status', amount: 'Amount', created: 'Created', payAddress: 'Payment address', payAmount: 'Amount to send', completeMock: 'Complete test payment',
    wallet: 'Payment wallet', walletHint: 'Only a public address is stored. Never enter a seed phrase or private key.', network: 'Network', walletAddress: 'Public address', save: 'Save', language: 'Language', theme: 'Theme', system: 'System', light: 'Light', dark: 'Dark',
    providers: 'Providers', products: 'Products', users: 'Users', monitoring: 'Monitoring',
    addProvider: 'Add provider', providerName: 'Name', slug: 'Slug', baseUrl: 'Base URL', usersPerKey: 'Users per upstream key', add: 'Add',
    addCredential: 'Add upstream key', provider: 'Provider', label: 'Label', apiKey: 'API key', maxConcurrency: 'Max concurrency',
    upstreamCredentials: 'Provider keys', spendLimit: 'Provider key spend limit, USD', catalogModels: 'Catalog models', lastHealthCheck: 'Last check', providerIssue: 'Availability issue', refreshCatalog: 'Check catalog',
    paidAwaitingKey: 'Paid, awaiting key', paidAwaitingKeyHint: 'Your payment is confirmed. The key will be issued when capacity is available. You do not need to pay again.',
    paidAwaitingTopUp: 'Paid, awaiting credit', paidAwaitingTopUpHint: 'Your payment is confirmed. We will add the balance when capacity is available for the key. You do not need to pay again.',
    baseUrlHint: 'Paste the address with or without /v1; the suffix is normalized automatically.', modelRates: 'Model rates', addRate: 'Add rate', model: 'Model', inputRate: 'Input / 1M, USD', outputRate: 'Output / 1M, USD', cachedRate: 'Cached / 1M, USD', requestRate: 'Per request, USD', contextThreshold: 'Long-context threshold', contextMultiplier: 'Long-context ×', disable: 'Disable', activate: 'Activate',
    addProduct: 'Add product', description: 'Description', wholesaleCredits: 'Wholesale allowance, USD', duration: 'Duration, days',
    role: 'Role', userStatus: 'Status', revenue: 'Revenue', upstreamCost: 'Wholesale cost', pending: 'Pending payment', openGrafana: 'Open Grafana',
    copied: 'Copied', loading: 'Loading…', error: 'Error', retry: 'Retry',
    connectTitle: 'Connect in one minute', connectText: 'Choose a client, copy the ready block, and replace the example key with your purchased pk_live_…', readyConfig: 'Ready-to-use configs', readDocs: 'Read the full documentation',
  },
};

interface PreferencesValue {
  locale: Locale;
  setLocale: (value: Locale) => void;
  theme: Theme;
  setTheme: (value: Theme) => void;
  t: (key: string) => string;
}

const PreferencesContext = createContext<PreferencesValue | null>(null);

function applyTheme(theme: Theme) {
  const resolved = theme === 'SYSTEM'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme.toLowerCase();
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => (localStorage.getItem('locale') as Locale) || (navigator.language.startsWith('ru') ? 'ru' : 'en'));
  const [theme, setThemeState] = useState<Theme>(() => (localStorage.getItem('theme') as Theme) || 'SYSTEM');

  useEffect(() => {
    applyTheme(theme);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => theme === 'SYSTEM' && applyTheme(theme);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [theme]);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

  const value = useMemo<PreferencesValue>(() => ({
    locale,
    setLocale: (next) => { localStorage.setItem('locale', next); setLocaleState(next); },
    theme,
    setTheme: (next) => { localStorage.setItem('theme', next); setThemeState(next); },
    t: (key) => dictionaries[locale][key] ?? key,
  }), [locale, theme]);
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error('PreferencesProvider is missing');
  return context;
}
