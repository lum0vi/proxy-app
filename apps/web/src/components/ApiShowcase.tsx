import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowRight, Braces, Code2, Film, Image, KeyRound, Layers3, MessageSquare, Pause, Play, Sparkles, Terminal } from 'lucide-react';
import { Link } from 'react-router-dom';
import { usePreferences } from '../lib/preferences';
import { sampleRequest } from '../lib/setup';
import type { Product, Protocol } from '../lib/store';
import { CopyButton } from './CodeBlock';

const apiFormats = [
  {
    id: 'openai', name: 'OpenAI', detail: 'Responses · Chat', icon: Braces, protocol: 'OPENAI',
    title: ['OpenAI-совместимый API', 'OpenAI-compatible API'],
    description: ['Responses для агентов и Codex, Chat Completions для чатов и ботов. Доступные Grok и DeepSeek также подключаются через Chat Completions.', 'Responses for agents and Codex, Chat Completions for chats and bots. Available Grok and DeepSeek models also connect through Chat Completions.'],
    features: ['Responses', 'Chat Completions', 'SSE · tools'],
    endpoints: [['POST', '/v1/responses'], ['POST', '/v1/responses/compact'], ['POST', '/v1/chat/completions'], ['GET', '/v1/models']],
  },
  {
    id: 'anthropic', name: 'Anthropic', detail: 'Messages API', icon: MessageSquare, protocol: 'ANTHROPIC',
    title: ['Claude в формате Messages', 'Claude with the Messages API'],
    description: ['Подключайте Claude Code, Anthropic SDK и свои приложения. Сообщения, потоковый ответ и вызовы инструментов используют формат Anthropic.', 'Connect Claude Code, the Anthropic SDK, and your own apps. Messages, streaming, and tool calls use the Anthropic format.'],
    features: ['Messages', 'Token counting', 'SSE · tools'],
    endpoints: [['POST', '/v1/messages'], ['POST', '/v1/messages/count_tokens'], ['GET', '/v1/models']],
  },
  {
    id: 'gemini', name: 'Gemini', detail: 'Generate Content', icon: Sparkles, protocol: 'GEMINI',
    title: ['Gemini в привычном формате', 'Gemini in its native format'],
    description: ['Используйте Google Gen AI SDK или HTTP-запросы: генерация, потоковый ответ и подсчёт токенов с указанием модели в адресе.', 'Use the Google Gen AI SDK or HTTP requests: generation, streaming, and token counting with the model in the request URL.'],
    features: ['Generate Content', 'Token counting', 'SSE · tools'],
    endpoints: [['POST', '/v1beta/models/{model}:generateContent'], ['POST', '/v1beta/models/{model}:streamGenerateContent'], ['POST', '/v1beta/models/{model}:countTokens'], ['GET', '/v1beta/models']],
  },
  {
    id: 'images', name: 'Images', detail: 'Generate · Edit', icon: Image, protocol: 'IMAGES',
    title: ['Создавайте и редактируйте изображения', 'Generate and edit images'],
    description: ['Генерация по тексту и редактирование загруженных изображений. Формат OpenAI Images; доступные размеры и качество указаны у модели.', 'Generate from text or edit uploaded images. OpenAI Images format; available sizes and quality are listed with each model.'],
    features: ['Text → image', 'Image → image', 'JSON · multipart'],
    endpoints: [['POST', '/v1/images/generations'], ['POST', '/v1/images/edits']],
  },
  {
    id: 'video', name: 'Video', detail: 'Create · Poll · Download', icon: Film, protocol: 'VIDEOS',
    title: ['От запроса до готового видео', 'From a request to a finished video'],
    description: ['Создайте задачу, проверьте статус и скачайте ролик. Длительность, разрешение и доступность зависят от выбранной модели.', 'Create a job, check its status, and download the clip. Duration, resolution, and availability depend on the selected model.'],
    features: ['Async jobs', 'Idempotency', 'MP4 download'],
    endpoints: [['POST', '/v1/videos'], ['GET', '/v1/videos'], ['GET', '/v1/videos/{id}'], ['GET', '/v1/videos/{id}/content']],
  },
] as const satisfies readonly {
  id: string; name: string; detail: string; icon: typeof Braces; protocol: Protocol;
  title: readonly [string, string]; description: readonly [string, string];
  features: readonly string[]; endpoints: readonly (readonly [string, string])[];
}[];

/** A diagram of supported formats, not a live traffic or availability indicator. */
export function ApiGatewayVisual() {
  const { locale } = usePreferences();
  const ru = locale === 'ru';
  const [paused, setPaused] = useState(false);
  return <div className={`api-gateway${paused ? ' is-paused' : ''}`}>
    <div className="gateway-heading"><span><Code2 size={14}/>{ru ? 'СОВМЕСТИМОСТЬ API' : 'API COMPATIBILITY'}</span>
      <button type="button" className="gateway-motion" aria-pressed={paused}
        aria-label={ru ? (paused ? 'Включить анимацию API' : 'Приостановить анимацию API') : (paused ? 'Play API animation' : 'Pause API animation')}
        onClick={() => setPaused(value => !value)}>{paused ? <Play size={14}/> : <Pause size={14}/>}</button>
    </div>
    <div className="gateway-map" aria-hidden="true">
      <svg className="gateway-wires" viewBox="0 0 500 280" fill="none">
        <path className="gateway-wire" d="M70 140H194M238 140H265C300 140 287 48 330 48H353M238 140H353M238 140H265C300 140 287 232 330 232H353"/>
        <path className="gateway-packet" pathLength="100" d="M70 140H194"/>
        <path className="gateway-packet" pathLength="100" d="M238 140H265C300 140 287 48 330 48H353"/>
        <path className="gateway-packet packet-two" pathLength="100" d="M238 140H353"/>
        <path className="gateway-packet packet-three" pathLength="100" d="M238 140H265C300 140 287 232 330 232H353"/>
      </svg>
      <div className="gateway-client"><Terminal size={22}/><small>{ru ? 'Ваш код' : 'Your code'}</small></div>
      <div className="gateway-core"><span className="gateway-orbit"/><KeyRound size={23}/><strong>Ksapi</strong><small>{ru ? 'один ключ' : 'one key'}</small></div>
      <div className="gateway-targets">
        <div><Braces size={18}/><span><strong>OpenAI</strong><small>Responses · Chat</small></span></div>
        <div><MessageSquare size={18}/><span><strong>Anthropic</strong><small>Messages API</small></span></div>
        <div><Sparkles size={18}/><span><strong>Gemini</strong><small>Generate Content</small></span></div>
      </div>
    </div>
    <div className="gateway-formats"><span><Image size={14}/>{ru ? 'Изображения' : 'Images'}</span><span><Film size={14}/>{ru ? 'Видео' : 'Video'}</span><span><Layers3 size={14}/>SSE · tools</span></div>
    <Link className="gateway-explore" to="/#api">{ru ? 'Посмотреть все маршруты API' : 'Explore API endpoints'}<ArrowDown size={15}/></Link>
  </div>;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function ApiShowcase({ products }: { products: Product[] }) {
  const { locale } = usePreferences();
  const ru = locale === 'ru';
  const [selected, setSelected] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const format = apiFormats[selected]!;
  const models = products.flatMap(product => product.models).filter(model => model.available);
  const model = models.find(model => model.protocol === format.protocol)
    ?? (format.id === 'openai' ? models.find(model => model.protocol === 'OPENAI_CHAT') : undefined);
  const request = sampleRequest(window.location.origin, model ?? { model: 'YOUR_MODEL', protocol: format.protocol });
  const auth = format.id === 'anthropic'
    ? ['  -H "x-api-key: $KSAPI_API_KEY"', '  -H "anthropic-version: 2023-06-01"']
    : format.id === 'gemini' ? ['  -H "x-goog-api-key: $KSAPI_API_KEY"'] : ['  -H "Authorization: Bearer $KSAPI_API_KEY"'];
  const code = [
    `curl${'stream' in request.body || format.id === 'gemini' ? ' --no-buffer' : ''} ${shellQuote(request.url)}`,
    ...auth,
    '  -H "Content-Type: application/json"',
    ...(format.id === 'video' ? ['  -H "Idempotency-Key: replace-with-a-unique-request-id"'] : []),
    `  -d ${shellQuote(JSON.stringify(request.body, null, 2))}`,
  ].join(' \\\n');

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % apiFormats.length;
    else if (event.key === 'ArrowLeft') next = (index + apiFormats.length - 1) % apiFormats.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = apiFormats.length - 1;
    else return;
    event.preventDefault();
    setSelected(next);
    tabRefs.current[next]?.focus();
  }

  return <section className="store-section api-showcase" id="api" aria-labelledby="api-showcase-title">
    <div className="store-section-heading"><div>
      <span className="comparison-eyebrow"><Braces size={16}/>{ru ? 'НАШ API · ВАШ СТЕК' : 'OUR API · YOUR STACK'}</span>
      <h2 id="api-showcase-title">{ru ? 'Знакомый API.' : 'Familiar APIs.'}<br/><span>{ru ? 'Больше возможностей.' : 'More possibilities.'}</span></h2>
      <p>{ru ? 'OpenAI, Anthropic, Gemini, изображения и видео. Выберите формат — посмотрите маршруты и пример запроса.' : 'OpenAI, Anthropic, Gemini, images, and video. Choose a format to explore its endpoints and a sample request.'}</p>
    </div><Link to="/docs#api">{ru ? 'Документация API' : 'API documentation'}<ArrowRight size={16}/></Link></div>

    <div className="api-tabs" role="tablist" aria-label={ru ? 'Форматы API' : 'API formats'}>
      {apiFormats.map(({ id, name, detail, icon: Icon }, index) => <button key={id} type="button" role="tab" id={`api-tab-${id}`}
        aria-selected={selected === index} aria-controls="api-format-panel" tabIndex={selected === index ? 0 : -1}
        ref={element => { tabRefs.current[index] = element; }} onKeyDown={event => navigateTabs(event, index)} onClick={() => setSelected(index)}>
        <Icon size={21}/><span><strong>{name}</strong><small>{detail}</small></span><span className="api-tab-dot"/>
      </button>)}
    </div>

    <div id="api-format-panel" className="api-format-panel" role="tabpanel" aria-labelledby={`api-tab-${format.id}`} tabIndex={0}>
      <div className="api-format-info">
        <div className="api-format-number" aria-hidden="true">0{selected + 1}<span>/ 05</span></div>
        <div key={format.id} className="api-format-copy"><h3>{format.title[ru ? 0 : 1]}</h3><p>{format.description[ru ? 0 : 1]}</p>
          <div className="api-feature-tags">{format.features.map(feature => <span key={feature}>{feature}</span>)}</div>
          <ul className="api-endpoints" aria-label={ru ? 'Поддерживаемые маршруты' : 'Supported endpoints'}>{format.endpoints.map(([method, path]) => <li key={`${method}${path}`}>
            <span className={method === 'GET' ? 'is-get' : ''}>{method}</span><code>{path}</code>
          </li>)}</ul>
        </div>
        <Link className="api-setup-link" to={format.id === 'video' || format.id === 'images' ? '/docs#media' : '/setup'}>{ru ? 'Как подключить' : 'How to connect'}<ArrowRight size={16}/></Link>
      </div>
      <div className="api-code-panel">
        <div className="api-code-heading"><span><i aria-hidden="true"/><i aria-hidden="true"/><i aria-hidden="true"/><span>request.sh</span></span><CopyButton value={code}/></div>
        <div className="api-code-caption"><Terminal size={14}/><span>{ru ? 'Пример запроса · без отправки' : 'Sample request · not executed'}</span><span>cURL</span></div>
        <pre tabIndex={0} aria-label={ru ? `Пример запроса ${format.name}` : `${format.name} sample request`}><code key={`${format.id}-${locale}-${model?.model ?? ''}`}>
          {code.split('\n').map((line, index) => <span className="api-code-line" key={index} style={{ '--line-delay': `${Math.min(index * 24, 360)}ms` } as CSSProperties}><span aria-hidden="true" className="api-line-number">{String(index + 1).padStart(2, '0')}</span>{line || ' '}{'\n'}</span>)}
        </code></pre>
        <div className="api-code-note"><KeyRound size={15}/><p>{ru ? 'Подставьте свой ключ в KSAPI_API_KEY и модель из каталога.' : 'Set KSAPI_API_KEY to your key and choose a model from the catalog.'}{format.id === 'video' && (ru ? ' Замените Idempotency-Key уникальным ID; для повтора сохраните тот же ID.' : 'Replace Idempotency-Key with a unique ID; keep that ID for retries.')}</p></div>
      </div>
    </div>
    <div className="api-showcase-footer"><p>{ru ? 'Показаны реализованные маршруты. Модели, функции и лимиты зависят от выбранной модели и вашего ключа.' : 'These endpoints are implemented. Models, features, and limits depend on the selected model and your key.'}</p><a href="/openapi.yaml" target="_blank" rel="noreferrer">OpenAPI .yaml<ArrowRight size={14}/></a></div>
  </section>;
}
