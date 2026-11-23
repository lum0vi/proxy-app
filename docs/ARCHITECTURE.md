# Архитектура и инварианты ProxyKey

## Границы системы

`apps/web` — React/Vite SPA для витрины, пользователя и администратора. `apps/api` — Fastify для управления ключами и передачи запросов через OpenAI, Anthropic и Gemini API. PostgreSQL хранит пользователей, заказы, места, расход и аудит. Worker проверяет ключи и отправляет уведомления. Nginx раздаёт SPA и проксирует `/api`, `/v1`, `/v1beta`, `/grafana`.

## Жизненный цикл продажи

1. Пользователь выбирает товар. Товар связан с пулом, который может объединять несколько независимых каналов моделей.
2. PostgreSQL блокирует строку доступного credential, перепроверяет capacity и резервирует место. Для продажи нужен подтверждённый каталог с активной ставкой хотя бы для одной модели.
3. ЮKassa создаёт рублёвый платёж, NOWPayments — счёт в USDT TON. Заказ сохраняет цену, тарифный коэффициент, пул, название, срок и параллельность ключа. Заказ отдельно хранит платёжную сумму и валюту, зафиксированный курс RUB и сумму зачисления USDT. После выдачи баланс равен выбранной сумме USDT.
4. Подписанный webhook сопоставляется с заказом по ID, валюте и сумме; запись события `(provider,event_id)` и переход в `PAID` происходят одной транзакцией.
5. Выдача блокирует заказ и создаёт не более одного `pk_live_*`. Если подходящего места нет, заказ остаётся `PAID`; worker повторяет попытку.
6. Зарезервированное место становится местом выданного ключа. Поздний платёж без действующего резерва ждёт места в исходном или связанном канале. Первое обращение к другому каналу закрепляет дополнительное место там, если оно свободно.

Capacity пула:

```text
free = сумма по проверенным уникальным credentials:
       max(0, capacity − active_or_paused_keys − pending_or_paid_reservations)
```

Таким образом `credential_capacity=2` — именно два проданных ключа на один upstream credential, а не наценка и не concurrency.

## Жизненный цикл proxy-запроса

1. Bearer key хэшируется SHA-256 и ищется в `api_keys`.
2. Проверяются status, expiry, credits и модельная ставка.
3. В транзакции создаётся request lease с TTL и `STARTED` usage record. Проверяются concurrency и остаток с учётом оценок других незавершённых запросов.
4. Upstream credential расшифровывается AES-256-GCM только в памяти процесса.
5. Запрос передаётся без логирования контента. Разрешены точные пути, ограниченный список заголовков и stateless-запросы. Идентификаторы cache/session изолированы по ключу.
6. JSON или SSE передаётся клиенту; Nginx buffering для `/v1` отключён.
7. Расход читается из Responses/Chat, Claude Messages или Gemini. Для Images фиксируется фактическое число результатов. Без подтверждённого расхода запрос отмечается для сверки, оценка по байтам не списывается.
8. Одна транзакция обновляет usage ledger, prepaid credits и upstream spend. Lease удаляется либо удерживается на короткий срок при неподтверждённом расходе.

В каждом используемом канале ключ закрепляется за credential, чтобы сохранялись кэш и привязка сессии. Если credential отключён, ключ атомарно перевязывается к credential со свободным местом. Запасная группа с той же моделью и протоколом может обслужить запрос, только если её ставки не превысят опубликованные.

## Billing

```text
uncached = max(input_tokens − cached_input_tokens − cache_write_tokens, 0)
token_cost = (uncached + 1.25 × cache_write_5m + 2 × cache_write_1h) × input_rate / 1M
           + cached × cached_rate / 1M
           + output × output_rate / 1M

if input_tokens > long_context_threshold:
    token_cost *= long_context_multiplier

source_cost = token_cost × peak_multiplier + (фактическое число картинок или 1 текстовый запрос) × per_request
customer_charge = min(remaining_balance, source_cost × order_effective_markup)
```

Цена продажи (`wholesale_credits × PRICE_MARKUP`, округлённая до центов) становится балансом. Списания покупателя и себестоимость хранятся раздельно. Множитель списания вычисляется из сохранённых условий заказа, включая округление: `amount / wholesale_credits`. Резервы заявок учитываются отдельно для баланса клиента и для ключа поставщика.

## Security

- пароли: salted scrypt;
- session и downstream keys: в индексах только SHA-256 hashes;
- upstream и revealable downstream secrets: AES-256-GCM с уникальным nonce;
- cookie: HttpOnly, SameSite=Lax, Secure в production;
- state-changing browser API: Origin check плюс cookie policy;
- admin mutations: RBAC и append-only audit log;
- payment fulfillment: signature, exact order/provider/external ID and amount matching и идемпотентная выдача;
- логи Fastify редактируют authorization, cookie, password и apiKey;
- prompt/response content не пишется в PostgreSQL;
- public wallet — только адрес и network, никаких seed/private keys.

Угроза с максимальным blast radius — компрометация `KEY_ENCRYPTION_SECRET` или admin account. Production должен использовать secret manager, ограниченный доступ к Grafana/backup, MFA перед reverse proxy при необходимости и регулярную ротацию upstream credentials.

## Мультипровайдерность

Пул задаёт Base URL, протокол, число мест, приоритет и состояние. Credential задаёт секрет, приоритет, число параллельных запросов и предельный расход. Ставка относится к каналу, а товар использует основной пул и его прямые дочерние каналы.

Для OpenAI и совместимых шлюзов поддерживаются Responses и Chat, а для Claude и Gemini — их собственные форматы, включая SSE. У Images — отдельный протокол с оплатой по результатам. Каналы CE содержат GPT, Claude, Gemini, Grok, DeepSeek и GPT Image. Azure deployment syntax и WebSocket Realtime за пределами текущего API.

## Observability

Control plane экспортирует HTTP rate/latency. Data plane экспортирует provider/endpoint/status, active requests, полную задержку, время до первого байта, usage и аномалии учёта. Business gauges показывают доступные места и заказы, ожидающие оплаты или выдачи. PostgreSQL и Nginx наблюдаются отдельными exporters.

Readiness требует PostgreSQL. `/health/serving` отдельно проверяет наличие подтверждённого канала. Worker опрашивает `/v1/models` или `/v1beta/models`. Увиденные модели без ставки видны в каталоге без доступа к вызову. Предельный расход поставщика блокирует новые запросы по исчерпании.

## Отказоустойчивость и ограничения

- Перезапуск API не теряет ledger; stale leases удаляются по TTL.
- Streaming response уже мог быть доставлен, когда финальный accounting временно недоступен. Ошибка фиксируется в server log; для строгого финансового production следующая эволюция — transactional outbox/usage reconciliation worker.
- Предварительная оценка по размеру запроса и output budget не гарантирует счёт CE. Подтвердить цены и поддержку usage должен коммерческий тест с рабочим каналом.
- Один PostgreSQL подходит для начального deployment. Горизонтальное масштабирование API поддерживается row locks и leases; worker должен иметь leader election при запуске нескольких экземпляров.
- Текущая Nginx-конфигурация HTTP-only; TLS должен завершаться внешним ingress или отдельной production-конфигурацией.
