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
        <div><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd">
          <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/>
        </svg><span><strong>OpenAI</strong><small>Responses · Chat</small></span></div>
        <div><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd">
          <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/>
        </svg><span><strong>Anthropic</strong><small>Messages API</small></span></div>
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
