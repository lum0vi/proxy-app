import { ArrowRight, BarChart3, Layers3, Wallet } from 'lucide-react';
import { Link } from 'react-router-dom';
import { usePreferences } from '../lib/preferences';
import { money, type Product } from '../lib/store';

// Recheck the linked official plan descriptions when updating this comparison.
const plusSource = 'https://help.openai.com/en/articles/6950777-what-is-chatgpt-plus';
const codexSource = 'https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan';

export function ChatGptComparison({ products }: { products: Product[] }) {
  const { locale } = usePreferences();
  const ru = locale === 'ru';
  const prices = products.map(product => Number(product.retailPrice)).filter(price => Number.isFinite(price) && price > 0);
  const entry = prices.length ? money(Math.min(...prices), locale) : null;
  const benefits = [
    { icon: Wallet, title: entry ? (ru ? `Начните с ${entry}` : `Start with ${entry}`) : (ru ? 'Выберите свой бюджет' : 'Choose your budget'),
      text: ru ? 'Пополняйте ключ под задачу. Регулярного платежа и автопродления нет.' : 'Fund your key when you need it. No recurring payment or automatic renewal.' },
    { icon: Layers3, title: ru ? 'Разные модели. Один ключ.' : 'Different models. One key.',
      text: ru ? 'Выбирайте доступные GPT, Claude, Gemini, Grok и другие модели под свою задачу.' : 'Choose available GPT, Claude, Gemini, Grok and other models for each task.' },
    { icon: BarChart3, title: ru ? 'Понятно, куда ушёл баланс' : 'See where your balance goes',
      text: ru ? 'Смотрите модель, токены, кэш и сумму каждого запроса. Пополняйте конкретный ключ.' : 'See the model, tokens, cache and cost of each request. Top up a specific key.' },
  ];
  const rows = ru ? [
    ['Оплата', 'Разовая покупка и пополнение. Расход по тарифу выбранной модели.', 'Подписка: базовая цена 20 USD в месяц по справке OpenAI.'],
    ['Своё приложение или бот', 'API-ключ для запросов из вашего кода и совместимых клиентов.', 'Использование OpenAI API оплачивается отдельно от Plus.'],
    ['Выбор моделей', 'Доступные модели разных семейств в одном каталоге и с одним балансом ключа.', 'Модели и инструменты, доступные в вашем плане ChatGPT.'],
    ['Работа с кодом', 'Настройки для Codex, Claude Code, OpenCode и SDK с вашим ключом.', 'Codex включён; доступ и лимиты зависят от плана и настроек.'],
    ['Расход и ограничения', 'Виден расход по запросам. Ограничения: баланс, тариф, конкурентность и доступность модели.', 'Лимиты ChatGPT и Codex зависят от плана; подключённые инструменты используют соответствующий лимит.'],
  ] : [
    ['Payment', 'One-time purchases and top-ups. Usage billed at the selected model rate.', 'Subscription: a base price of USD 20 per month according to OpenAI.'],
    ['Your app or bot', 'An API key for requests from your code and compatible clients.', 'OpenAI API usage is billed separately from Plus.'],
    ['Model choice', 'Available model families in one catalog, sharing one key balance.', 'Models and tools available with your ChatGPT plan.'],
    ['Coding', 'Setup examples for Codex, Claude Code, OpenCode and SDKs using your key.', 'Codex is included; access and limits depend on the plan and settings.'],
    ['Usage and limits', 'Per-request charges. Subject to balance, rates, concurrency and model availability.', 'ChatGPT and Codex limits depend on the plan; connected tools use the applicable allowance.'],
  ];

  return <section className="store-section store-comparison" id="compare" aria-labelledby="compare-title">
    <div className="store-section-heading"><div>
      <span className="comparison-eyebrow">{ru ? 'ВАШИ ИНСТРУМЕНТЫ · ВАШ БЮДЖЕТ' : 'YOUR TOOLS · YOUR BUDGET'}</span>
      <h2 id="compare-title">{ru ? 'Когда выбрать Ksapi' : 'When to choose Ksapi'}</h2>
      <p>{ru ? 'Для ботов, своих приложений и работы с разными AI-моделями. Сравните этот сценарий с подпиской ChatGPT Plus.' : 'For bots, your own apps and working with different AI models. Compare this workflow with a ChatGPT Plus subscription.'}</p>
    </div></div>

    <div className="comparison-benefits">{benefits.map(({ icon: Icon, title, text }) => <article key={title}>
      <span className="comparison-icon"><Icon size={22} aria-hidden="true"/></span><h3>{title}</h3><p>{text}</p>
    </article>)}</div>

    <div className="comparison-table-wrap" role="region" aria-label={ru ? 'Сравнение Ksapi и ChatGPT Plus' : 'Ksapi and ChatGPT Plus comparison'} tabIndex={0}>
      <table className="comparison-table">
        <caption className="sr-only">{ru ? 'Способы оплаты, API, модели и ограничения' : 'Payment, API access, models and limits'}</caption>
        <thead><tr><th scope="col">{ru ? 'Что важно' : 'What matters'}</th><th scope="col"><span>Ksapi</span><small>{ru ? 'API для ваших задач' : 'API access for your tasks'}</small></th><th scope="col"><span>ChatGPT Plus</span><small>{ru ? 'Подписка на ChatGPT' : 'ChatGPT subscription'}</small></th></tr></thead>
        <tbody>{rows.map(([label, ours, plus]) => <tr key={label}><th scope="row">{label}</th><td>{ours}</td><td>{plus}</td></tr>)}</tbody>
      </table>
    </div>
    <div className="comparison-bottom">
      <p>{ru ? 'Готовый чат, голос, загрузка файлов и Deep Research — возможности ChatGPT. Ksapi предоставляет API-доступ. Выгодность зависит от модели, объёма запросов и контекста; одинаковый набор возможностей или фиксированная экономия не обещаются.' : 'A ready-to-use chat, voice, file uploads and Deep Research are ChatGPT features. Ksapi provides API access. Value depends on your models, request volume and context; the feature sets and costs are not identical.'}</p>
      <Link className="button" to="/#calculator">{ru ? 'Рассчитать свой расход' : 'Estimate your usage'}<ArrowRight size={16}/></Link>
    </div>
    <p className="comparison-sources">{ru ? 'Условия проверены 25.11.2026. Источники: ' : 'Checked on November 25, 2026. Sources: '}
      <a href={plusSource} target="_blank" rel="noopener noreferrer">ChatGPT Plus</a>{' · '}<a href={codexSource} target="_blank" rel="noopener noreferrer">Codex</a>.
      {' '}{ru ? 'Фактическую цену и условия подписки проверяйте при оформлении у OpenAI.' : 'Check the current subscription price and terms at OpenAI checkout.'}
    </p>
  </section>;
}
