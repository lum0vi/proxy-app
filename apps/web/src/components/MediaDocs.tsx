import { api } from '../lib/api';
import { useRemote } from '../lib/useRemote';
import { usePreferences } from '../lib/preferences';
import { sampleRequest } from '../lib/setup';
import type { StoreCatalog } from '../lib/store';
import { CodeBlock } from './CodeBlock';

export function MediaDocs() {
  const { locale } = usePreferences(); const ru = locale === 'ru';
  const catalog = useRemote(() => api<StoreCatalog>('/api/products'));
  const models = catalog.data?.products.flatMap(product => product.models) ?? [];
  const image = models.find(model => model.protocol === 'IMAGES' && model.mediaOptions?.operations?.includes('edit'));
  const video = models.find(model => model.protocol === 'VIDEOS');
  const videoRequest = sampleRequest(window.location.origin, video ?? { model: 'YOUR_VIDEO_MODEL', protocol: 'VIDEOS' });
  const editOptions = Object.entries(image?.mediaOptions ?? {}).filter(([name, values]) => !['operations', 'seconds'].includes(name) && values.length)
    .map(([name, values]) => `  -F '${name}=${String(values[0]).replaceAll("'", "'\\''")}' \\\n`).join('');
  return <section id="media" className="docs-section">
    <h2>{ru ? 'Изображения и видео' : 'Images and videos'}</h2>
    <p>{ru ? 'Используйте свой обычный API-ключ. Модель, длительность, разрешение и качество должны быть доступны в её тарифе. Наличие маршрута не означает доступность любой модели.' : 'Use your regular API key. Choose a model, duration, resolution and quality available in its rate. An endpoint does not imply that every model is available.'}</p>
    <h3>{ru ? 'Редактировать изображение' : 'Edit an image'}</h3>
    <CodeBlock label="curl · multipart/form-data" code={`curl "${window.location.origin}/v1/images/edits" \\
  -H "Authorization: Bearer $KSAPI_API_KEY" \\
  -F 'model=${(image?.model ?? 'YOUR_IMAGE_MODEL').replaceAll("'", "'\\''")}' \\
  -F 'prompt=Add soft sunlight to this scene' \\
${editOptions}  -F 'image=@input.png;type=image/png'`}/>
    <p>{ru ? 'Передайте PNG, JPEG или WebP. Максимальный размер всего запроса — 32 МБ. Оплата — за успешно возвращённые изображения. Для передачи нескольких файлов используйте повторяющиеся поля image[].' : 'Upload PNG, JPEG or WebP. The whole request is limited to 32 MB. Only returned images are billed. Use repeated image[] fields for multiple files.'}</p>
    <h3>{ru ? 'Создать видео' : 'Create a video'}</h3>
    <CodeBlock label="curl · JSON" code={`curl "${videoRequest.url}" \\
  -H "Authorization: Bearer $KSAPI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: replace-with-a-unique-request-id" \\
  -d '${JSON.stringify(videoRequest.body).replaceAll("'", "'\\''")}'`}/>
    <CodeBlock label={ru ? 'Статус и скачивание' : 'Status and download'} code={`# Set VIDEO_ID to the id returned by POST /v1/videos
curl "${window.location.origin}/v1/videos/$VIDEO_ID" \\
  -H "Authorization: Bearer $KSAPI_API_KEY"

# Download only after status becomes completed
curl "${window.location.origin}/v1/videos/$VIDEO_ID/content" \\
  -H "Authorization: Bearer $KSAPI_API_KEY" -o video.mp4`}/>
    <p>{ru ? 'До завершения сумма резервируется. Готовое видео списывается один раз по длительности; статус и скачивание бесплатны. Если запрос оборвался, повторите его с тем же Idempotency-Key и тем же содержимым. При billing_status: review_required сохраните ID и обратитесь в поддержку — новая попытка с другим ID может создать второй ролик.' : 'Funds are reserved until completion. A finished clip is charged once by duration; polling and downloads are free. Retry an interrupted request with the same Idempotency-Key and content. For billing_status: review_required, keep the job ID and contact support; a new idempotency key could create another clip.'}</p>
    {!video && <p className="form-hint">{ru ? 'Видео-модели ещё не настроены. Вместо YOUR_VIDEO_MODEL понадобится доступная модель из каталога.' : 'Video models are not configured yet. Replace YOUR_VIDEO_MODEL with an available catalog model.'}</p>}
  </section>;
}
