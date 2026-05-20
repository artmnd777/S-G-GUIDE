# Starter Generator Telegram Bot

Telegram-бот-консультант по продаже, подбору, ремонту и реставрации стартеров и генераторов.

## Бесплатный запуск

1. Создайте Telegram-бота через `@BotFather` и получите `TELEGRAM_BOT_TOKEN`.
2. Создайте бесплатный Gemini API key: https://aistudio.google.com/app/apikey
3. Установите зависимости:

```bash
npm install
```

4. Скопируйте переменные окружения:

```bash
cp .env.example .env
```

5. Заполните `.env`:

```env
TELEGRAM_BOT_TOKEN=...
LLM_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash-lite
```

6. Запустите:

```bash
npm start
```

## Переключение на GPT / OpenAI

Если позже появится OpenAI API key и доступ к нужной модели, поменяйте `.env`:

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.5
```

Если `gpt-5.5` недоступна в аккаунте, укажите любую доступную модель OpenAI.

## Деплой на Render

Бот должен быть постоянно запущен. Для Render используется webhook-режим.

1. Загрузите проект в GitHub.
2. В Render создайте **New → Web Service** из этого репозитория.
3. Render увидит `render.yaml`; выберите план `Free` или платный.
4. Добавьте переменные окружения:

```env
BOT_MODE=webhook
LLM_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash-lite
TELEGRAM_BOT_TOKEN=...
WEBHOOK_BASE_URL=https://your-render-service.onrender.com
WEBHOOK_PATH=/telegram-webhook
MAX_HISTORY_MESSAGES=12
```

5. После деплоя отправьте боту `/start`.

Важно: бесплатный Render может засыпать после простоя, поэтому первый ответ может идти дольше. Для стабильного 24/7 лучше платный instance.

## Команды

- `/start` — начать работу и очистить контекст.
- `/reset` — очистить контекст текущего чата.
- `/help` — примеры вопросов.

## Как обновлять знания

Редактируйте `prompts/starter_generator_consultant.md`. Новые знания лучше добавлять в конец в формате: дата, тема, правило, когда применять, готовый текст клиенту, исключения/риски.
