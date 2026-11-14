# Как пользоваться ProxyKey

Эта инструкция ведёт от пустой машины до первой продажи и первого запроса через купленный ключ.

## 1. Что нужно заранее

- macOS с Colima или Linux с Docker Engine;
- Docker Compose (`docker-compose`) либо новый синтаксис `docker compose`;
- Node.js 24.22.3+ для локальных проверок; в Docker используется Node.js 24 LTS;
- CE-аккаунт с положительным PayGo-балансом и ключом нужной группы для платных запросов;
- для production: домен, HTTPS, Stripe и/или NOWPayments, SMTP.

Для PayGo-группы вы пополняете баланс CE. Ключи можно добавлять через админку или выпускать автоматически с уже пополненного аккаунта. ProxyKey выдаёт покупателям собственные ключи и учитывает расход. Отдельная группа Free Trial предназначена для тестов.

## 2. Подготовьте `.env`

```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

Первый результат вставьте в `SESSION_SECRET`, второй — в `KEY_ENCRYPTION_SECRET`. Также обязательно поменяйте:

```dotenv
NODE_ENV=development
PUBLIC_APP_URL=http://localhost:8080
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=длинный-уникальный-пароль
POSTGRES_PASSWORD=другой-длинный-пароль
DATABASE_URL=postgres://proxiapp:тот-же-пароль@postgres:5432/proxiapp
GRAFANA_ADMIN_PASSWORD=ещё-один-пароль

PRICE_MARKUP=2
USERS_PER_UPSTREAM_KEY=2
PAYMENT_METHODS=mock
ALLOW_MOCK_PAYMENTS=true
```

`PRICE_MARKUP` и `USERS_PER_UPSTREAM_KEY` — разные параметры:

- `PRICE_MARKUP=2` задаёт множитель цены пакета и ставок запроса. Оплата `$20` начисляет `$20` на баланс ключа;
- `USERS_PER_UPSTREAM_KEY=2` разрешает закрепить за одним CE API key максимум два проданных ключа.

Не меняйте `KEY_ENCRYPTION_SECRET` после добавления upstream-ключей без отдельной процедуры re-encryption: старые ciphertext станут нечитаемыми. Смена `SESSION_SECRET` безопасна, но завершит все активные сессии.

## 3. Запустите стек через Colima

```bash
colima start --cpu 4 --memory 8 --disk 60
docker-compose up -d --build
docker-compose ps
curl -fsS http://localhost:8080/health/live
curl -fsS http://localhost:8080/health/ready
```

При первом старте `migrate` применит SQL-миграции, `seed` создаст каналы CE, три пакета, ставки моделей и первого администратора. Данные сохраняются в томах Docker. Если в старом `.env` вручную задан `PROXY_ALLOWED_PATHS`, добавьте пути Messages и Gemini из [.env.example](../.env.example).

Адреса:

- приложение: `http://localhost:8080`;
- readiness: `http://localhost:8080/health/ready`;
- наличие проверенного канала для запросов: `http://localhost:8080/health/serving` (`503` на пустом стенде);
- Grafana: `http://localhost:8080/grafana/`;
- Prometheus: `http://127.0.0.1:9090`;
- OpenAPI: `http://localhost:8080/openapi.yaml`.

Если у вас установлен только новый Compose, заменяйте `docker-compose` на `docker compose` во всех командах.

## 4. Подключите Codex Everywhere

При `CE_AUTO_PROVISION_KEYS=false` добавляйте ключи вручную. Это режим по умолчанию.

1. В кабинете CE получите рабочий ключ для каждой нужной группы. В ProxyKey войдите с данными администратора и откройте **Админка → Провайдеры → Добавить upstream-ключ**.
2. Выберите пул `Codex Everywhere` для **Plus PayGo**. Для остальных групп выберите готовый канал: `CE · Codex Pro PayGo`, `CE · Claude Max PayGo`, `CE · Claude Kiro PayGo`, `CE · Grok Heavy PayGo`, `CE · DeepSeek Official`, `CE · GPT Image PayGo` или `CE · Gemini Antigravity`. Для Gemini нужен ключ с доступом к этой группе; он может отсутствовать в списке выдачи CE. CE ограничивает Claude Max клиентом Claude Code.
3. Укажите метку, секрет и реальный предел параллельных запросов. Для Free Trial поставьте «Только для тестовой оплаты»: такой ключ работает только с mock-заказами, когда `PAYMENT_METHODS=mock`, `ALLOW_MOCK_PAYMENTS=true` и среда не production. Не добавляйте один секрет в несколько каналов. Покупателю достаточно одного ключа ProxyKey для доступных моделей всех связанных каналов.
4. Проверьте статус в **Ключи провайдера**. ProxyKey проверяет каталог при добавлении и периодически обновляет его. Ставка должна быть задана и модель должна быть в проверенном каталоге. Новые модели без ставки появятся на витрине с отметкой «Ставка не задана»; укажите цену в **Тарифы моделей**, когда подтвердите себестоимость. Для `codex-auto-review` отдельная ставка CE в публичных таблицах не указана.
5. Сверьте **Тарифы моделей** с [актуальными ставками CE](https://docs.codex-everywhere.com/models/). Проверьте тестовый запрос через каждый включённый канал и сравните расход с кабинетом CE перед началом продаж. Для GPT задан консервативный множитель `2` после `272000` входных токенов.

Секрет CE после сохранения нельзя получить через admin API: интерфейс показывает только hint. Он расшифровывается внутри proxy непосредственно перед upstream-запросом и не пишется в логи.

### Автоматический выпуск ключей CE

1. Создайте файл `.env.ce` рядом с `docker-compose.yml`. Этот файл читает только контейнер worker. Укажите почту и пароль аккаунта CE собственными значениями. Worker откроет свою сессию и зашифрует её токены перед сохранением в PostgreSQL.

   ```dotenv
   CE_PROVISION_EMAIL=you@example.com
   CE_PROVISION_PASSWORD='your CE password'
   ```
2. Соберите приложение, запустите миграции и посмотрите группы аккаунта. Команда выведет их ID, названия и текущий баланс CE.

   ```bash
   docker-compose up -d --build
   docker-compose exec worker node apps/api/dist/worker.js --ce-groups
   ```

3. В основном `.env` задайте флаг и пары `slug пула:ID группы`. Возьмите ID из вывода предыдущей команды. Например, если ID **Codex Plus Pool (PayGo)** равен `17`, а **Codex Pro Pool (PayGo)** — `23`:

   ```dotenv
   CE_AUTO_PROVISION_KEYS=true
   CE_PROVISION_GROUPS=codex-everywhere:17,ce-codex-pro:23
   CE_PROVISION_FREE_SLOTS=2
   ```

4. Пересоздайте worker и проверьте новые ключи в **Админка → Провайдеры**.

   ```bash
   docker-compose up -d --no-deps --force-recreate worker
   docker-compose logs --tail=50 worker
   ```

Worker проверяет запас примерно раз в минуту, создаёт ключ для настроенной PayGo-группы при нехватке мест и открывает продажи после проверки каталога. Лимит расходов нового ключа CE равен максимальной себестоимости пакета в пуле, умноженной на число покупателей на ключ. Worker проверяет баланс CE перед выпуском. Пополнение баланса выполняется в CE отдельно. Для возврата к ручному режиму поставьте `CE_AUTO_PROVISION_KEYS=false` и пересоздайте worker.

Если вход по паролю требует второго фактора, можно использовать `CE_PROVISION_REFRESH_TOKEN` вместо пары почта и пароль. Возьмите `refresh_token` из отдельной браузерной сессии CE в **DevTools → Application → Local Storage**. При истечении или отзыве этой сессии укажите новый токен и пересоздайте worker.

Выпуск использует HTTP API кабинета CE (`/api/v1/keys`), которое CE не публикует как отдельный партнёрский контракт. Параметры сверены с веб-клиентом CE, выпуск и обработку сбоев мы проверили на локальном имитаторе.

### Что произойдёт при capacity = 2

Один подтверждённый ключ поставщика даёт до двух мест. Покупка закрепляет одно место в доступном канале. Когда покупатель впервые запрашивает модель из другого канала, ProxyKey занимает там место при наличии. Если Claude-канал заполнен, третий покупатель сможет работать с другими доступными моделями, пока не появится место для Claude. Добавление ещё одного ключа этой группы даёт дополнительные места.

Неоплаченный заказ резервирует место на час для Stripe, до срока криптосчёта для NOWPayments и на 24 часа для локального теста. Поздний подтверждённый платёж сохраняется как `PAID`. При отсутствии свободного ключа worker повторит выдачу после появления места.

## 5. Добавьте другого провайдера или New API

В **Админка → Провайдеры → Добавить провайдера** заполните:

- название и уникальный slug;
- Base URL и протокол: Responses/Chat Completions, только Chat, Anthropic Messages, Gemini или Images;
- при необходимости — родительский пул, если нужен общий каталог и один клиентский ключ;
- **Пользователей на upstream-ключ** — например `5`.

После этого:

1. добавьте один или несколько upstream API keys;
2. добавьте ставки для каждой разрешённой модели;
3. в **Админка → Товары** создайте товар, выберите этот provider pool, wholesale-лимит, срок и concurrency;
4. сделайте тестовый заказ и запрос.

Так можно подключить CE напрямую, собственный Sub2API/New API или другой совместимый API. Каждый канал передаёт запросы в своём формате. Claude можно вызывать через `/v1/messages`, Gemini — через `/v1beta/models/{model}:generateContent` и `:streamGenerateContent?alt=sse`.

## 6. Создайте товар и проверьте цену

Преднастроены `Starter Key`, `Developer Key` и `Extended Key` на 30 дней. При `PRICE_MARKUP=2` покупатель может выбрать `$2`, `$20` или `$50`; столько же будет на балансе ключа. Доступность моделей обновляется по результатам проверки каталогов подключённых ключей.

Тарифы витрины и калькулятор показывают розничные ставки в USD. Фактическое списание видно в истории запроса. Оплаченный баланс доступен всем моделям ключа. Чтение кэша учитывается по собственной ставке; у Claude отдельно учитывается и запись в кэш.

Изменение `PRICE_MARKUP` влияет на новые заказы после рестарта. В каждом заказе сохраняются цена и множитель. При обновлении со старой схемы баланс существующего ключа пересчитывается на полную сумму его заказа, а прежние списания — в той же пропорции, чтобы сохранить долю остатка.

Витрина показывает цену в USD и ориентировочные эквиваленты в ₽ и TON по котировкам TonAPI. Точный счёт создаёт выбранная платёжная система. В калькуляторе можно указать модель и объёмы входа, кэша и ответа. **Кабинет → Расход** показывает списания и статусы запросов по выбранному ключу.

## 7. Проведите локальную тестовую покупку

1. Зарегистрируйте обычного пользователя.
2. Откройте **Купить ключ** и выберите товар.
3. Выберите **Тестовая оплата**.
4. На странице заказа нажмите **Подтвердить тестовую оплату**.
5. Откройте **API-ключи → Показать**, введите пароль аккаунта и скопируйте `pk_live_...`.

Mock-оплата блокируется при `NODE_ENV=production`, даже если её случайно оставить в списке.

## 8. Подключите выданный ключ

### curl / Responses API

```bash
curl https://your-domain.example/v1/responses \
  -H 'Authorization: Bearer pk_live_ВАШ_КЛЮЧ' \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-6.1-sol","input":"Напиши короткий health-check","stream":true}'
```

### OpenAI Node SDK

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.PROXYKEY_API_KEY,
  baseURL: 'https://your-domain.example/v1',
});

const response = await client.responses.create({
  model: 'gpt-6.1-sol',
  input: 'Привет!',
});
```

### Codex CLI / Desktop / VS Code

В начало `~/.codex/config.toml`:

```toml
model_provider = "proxykey"
model = "gpt-6.1-sol"
model_reasoning_effort = "high"
web_search = "disabled"

[model_providers.proxykey]
name = "proxykey"
base_url = "https://your-domain.example/v1"
env_key = "PROXYKEY_API_KEY"
wire_api = "responses"
supports_websockets = false
```

Перед запуском Codex экспортируйте ключ:

```bash
export PROXYKEY_API_KEY="pk_live_ВАШ_КЛЮЧ"
```

Этот профиль читает ключ из окружения. Для приложения и расширения переменная должна быть доступна процессу при запуске. `GET /v1/models` возвращает доступные модели с полем `protocols`. В **API-ключи → Подключить** или на `/setup` есть конфигурации для Codex, Claude Code, OpenCode и готовые команды curl для Gemini, DeepSeek и изображений.

Для прямых запросов передавайте стабильные `session_id` и `prompt_cache_key`, когда клиент это поддерживает. ProxyKey преобразует их отдельно для каждого ключа. Для истории передавайте полные сообщения или stateless compaction, если upstream поддерживает его. Ссылки на чужие сохранённые объекты, hosted tools и фоновые запросы отклоняются. Лимит `PROXY_ASSUMED_MAX_OUTPUT_TOKENS` используется в оценке, если клиент не указал свой; фактическое списание идёт по подтверждённому usage.

## 9. Включите реальные платежи

### Stripe — обычная оплата

```dotenv
NODE_ENV=production
PAYMENT_METHODS=stripe
ALLOW_MOCK_PAYMENTS=false
SALES_ENABLED=false
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
PUBLIC_APP_URL=https://your-domain.example
```

В Stripe создайте webhook endpoint:

```text
https://your-domain.example/api/webhooks/stripe
```

Подпишите события `checkout.session.completed` и `checkout.session.async_payment_succeeded`. ProxyKey проверяет подпись по исходному телу запроса, сопоставляет ID сессии, валюту и сумму с заказом; повтор webhook не создаст второй ключ.

### NOWPayments — криптовалюта

```dotenv
PAYMENT_METHODS=stripe,nowpayments
NOWPAYMENTS_API_KEY=...
NOWPAYMENTS_IPN_SECRET=...
NOWPAYMENTS_PAY_CURRENCY=ton
```

Callback создаётся автоматически как `https://your-domain.example/api/webhooks/nowpayments`. Подтверждение требует `finished`, корректной подписи, совпадения цены/валюты и фактической оплаты в нужной монете. Недоплата не выдаёт ключ.

Для TON перенесите из счёта точную сумму, адрес и memo, если он указан. Проверьте минимальный размер платежа для вашего кошелька выплат в [NOWPayments](https://nowpayments.io/help/payments/common/what-is-the-minimum-payment-amount). Рубли на витрине являются справочной ценой. Для приёма оплаты российскими картами или СБП нужен настроенный локальный эквайринг.

Поля кошелька в профиле — только контактный публичный адрес пользователя. Приложение не хранит private key/seed и не является custodial wallet.

## 10. Email-уведомления

Заполните SMTP-параметры. Worker раз в минуту ставит и отправляет дедуплицированные уведомления:

- ключ создан;
- до истечения осталось 7/3/1 дней;
- осталось 20/10/5 процентов лимита.

Без SMTP сообщение безопасно отмечается в структурированном логе как `email_skipped`, что удобно локально.

## 11. Мониторинг и health-check

Grafana dashboard показывает availability, RPS, active streams, p95 latency, 5xx/upstream errors, Node memory/event-loop lag, PostgreSQL, provider capacity, pending orders и wholesale cost.

Основные проверки:

```bash
curl -fsS https://your-domain.example/health/live
curl -fsS https://your-domain.example/health/ready
curl -fsS https://your-domain.example/health/serving
curl -fsS http://127.0.0.1:9090/-/ready
docker-compose logs --tail=100 api worker nginx prometheus grafana
```

Prometheus содержит alerts для API/PostgreSQL down, error rate >5%, p95 >30 секунд, event-loop saturation и отсутствия provider capacity.

## 12. Production-запуск

1. Установите `NODE_ENV=production`, реальный HTTPS URL и уникальные секреты. По умолчанию контейнер Nginx публикуется на `127.0.0.1` для подключения через локальный TLS-терминатор. Оставьте `SALES_ENABLED=false` до проверки, затем включите `SALES_ENABLED=true`.
2. Оставьте PostgreSQL и Prometheus привязанными к localhost/private network.
3. Завершайте TLS на внешнем load balancer/CDN либо добавьте сертификаты в Nginx. Не публикуйте приложение по HTTP.
4. Ограничьте доступ к Grafana, используйте отдельный сложный пароль.
5. Сделайте backup PostgreSQL volume до обновления.
6. Выполните live-чеклист ниже.

Обновление:

```bash
git pull --ff-only
docker-compose build --pull
docker-compose up -d
docker-compose ps
curl -fsS https://your-domain.example/health/ready
```

## 13. Live-чеклист перед открытием продаж

- `/v1/models` через ваш `pk_live_*` возвращает CE models;
- нестриминговый `/v1/responses` записывает точный usage;
- streaming Responses и Chat Completions завершаются без Nginx buffering;
- tool call проходит без изменения JSON/SSE;
- остаток ключа уменьшается на ожидаемую сумму, включая cached и long context;
- третий покупатель при одном CE credential и capacity `2` не может оплатить товар;
- Stripe test webhook и NOWPayments sandbox/IPN проходят подпись и duplicate delivery;
- письмо low-balance/expiry доставляется;
- Grafana видит API, PostgreSQL и Nginx;
- backup PostgreSQL восстановлен на отдельном тестовом окружении;
- у вас есть письменное подтверждение допустимости resale от upstream-провайдера.

Для этой финальной проверки доступ к CE-кабинету можно дать без передачи пароля в чат: вы сами входите и вводите CE API key в локальной админке, после чего проверяются только результат и метрики.

## 14. Частые проблемы

`NO_UPSTREAM_CAPACITY` / товар «нет мест» — нет свободных мест на проверенных credentials. Сначала посмотрите причину последнего отказа в админке; если ключи пригодны, учитываются выданные ключи, неподтверждённые резервы и оплаченные заказы в ожидании. Добавьте рабочий credential или дождитесь освобождения мест.

`MODEL_NOT_PRICED` — модель не добавлена или отключена в тарифах выбранного пула. Это защитный отказ: запрос не отправляется, пока невозможно посчитать себестоимость.

`UPSTREAM_BUSY` — достигнут `maxConcurrency` конкретного upstream credential. Увеличивайте его только в пределах реальных ограничений провайдера.

Credential стал `DEGRADED` — откройте логи worker и проверьте баланс, API key, Base URL и `/v1/models`. `EXHAUSTED` не активируется worker автоматически: увеличьте spend limit или добавьте новый ключ.

`CREDITS_EXHAUSTED` / HTTP 402 — проданный ключ израсходовал свой prepaid budget. Пользователь покупает новый ключ; автосписания отсутствуют.

Grafana через `/grafana/` не открывается — проверьте `GF_SERVER_ROOT_URL`, `PUBLIC_APP_URL`, контейнер `grafana` и Nginx DNS.

## 15. CI и тесты

GitHub Actions запускает всё на GitHub-hosted `ubuntu-latest`. Job `verify` поднимает PostgreSQL 16, применяет миграции, seed, security audit, typecheck, unit tests, интеграционный proxy test и build. Job `docker` отдельно собирает production targets `api` и `gateway`.

Локально:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Полный интеграционный тест с PostgreSQL из запущенного Compose:

```bash
RUN_INTEGRATION_TESTS=true \
DATABASE_URL=postgres://proxiapp:change-me-in-production@127.0.0.1:55432/proxiapp \
npm run test --workspace @proxi/api
```

Подставьте фактический пароль из `.env`. Тест использует уникальные записи и удаляет их после завершения.
