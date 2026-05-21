const fs = require('fs');
const http = require('http');
const path = require('path');
const { Telegraf } = require('telegraf');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
require('dotenv').config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const MAX_HISTORY_MESSAGES = Number(process.env.MAX_HISTORY_MESSAGES || 12);
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/telegram-webhook';
const PORT = Number(process.env.PORT || 3000);
const DEFAULT_BOT_MODE = (process.env.RENDER || WEBHOOK_BASE_URL || process.env.PORT) ? 'webhook' : 'polling';
const BOT_MODE = (process.env.BOT_MODE || DEFAULT_BOT_MODE).toLowerCase();
const SKIP_SET_WEBHOOK = process.env.SKIP_SET_WEBHOOK === 'true';
const TRAINING_MEMORY_FILE = process.env.TRAINING_MEMORY_FILE || path.join(process.cwd(), 'data', 'training-memory.json');
const MAX_TRAINING_ENTRIES = Number(process.env.MAX_TRAINING_ENTRIES || 80);
const MAX_TRAINING_CHARS = Number(process.env.MAX_TRAINING_CHARS || 12000);
const TEACHING_ADMIN_IDS = (process.env.TEACHING_ADMIN_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN is required');
}

if (LLM_PROVIDER === 'gemini' && !GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY is required');
}

if (LLM_PROVIDER === 'openai' && !OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required when LLM_PROVIDER=openai');
}

const systemPrompt = fs.readFileSync(
  path.join(__dirname, '..', 'prompts', 'starter_generator_consultant.md'),
  'utf8'
);

const geminiModel = LLM_PROVIDER === 'gemini'
  ? new GoogleGenerativeAI(GEMINI_API_KEY).getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: systemPrompt
  })
  : null;
const openai = LLM_PROVIDER === 'openai' ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const histories = new Map();
const pendingActions = new Map();
const TELEGRAM_MESSAGE_LIMIT = 3900;

function loadTrainingMemory() {
  try {
    if (!fs.existsSync(TRAINING_MEMORY_FILE)) {
      return [];
    }

    const parsed = JSON.parse(fs.readFileSync(TRAINING_MEMORY_FILE, 'utf8'));
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (error) {
    console.error('Training memory load error:', error);
    return [];
  }
}

let trainingMemory = loadTrainingMemory();

function getHistory(chatId) {
  const history = histories.get(chatId) || [];
  return history.slice(-MAX_HISTORY_MESSAGES);
}

function saveTurn(chatId, userText, assistantText) {
  const history = getHistory(chatId);
  history.push({ role: 'user', content: userText });
  history.push({ role: 'assistant', content: assistantText });
  histories.set(chatId, history.slice(-MAX_HISTORY_MESSAGES));
}


function saveTrainingMemory() {
  fs.mkdirSync(path.dirname(TRAINING_MEMORY_FILE), { recursive: true });
  fs.writeFileSync(
    TRAINING_MEMORY_FILE,
    JSON.stringify({ entries: trainingMemory }, null, 2),
    'utf8'
  );
}

function isTeachingAllowed(ctx) {
  if (TEACHING_ADMIN_IDS.length === 0) {
    return true;
  }

  return TEACHING_ADMIN_IDS.includes(String(ctx.chat.id)) || TEACHING_ADMIN_IDS.includes(String(ctx.from.id));
}

function trimTrainingMemory() {
  trainingMemory = trainingMemory.slice(-MAX_TRAINING_ENTRIES);
  while (formatTrainingMemory().length > MAX_TRAINING_CHARS && trainingMemory.length > 1) {
    trainingMemory.shift();
  }
}

function addTrainingEntry(type, text, authorId) {
  const cleanText = text.trim().slice(0, 6000);
  if (!cleanText) {
    return null;
  }

  const entry = {
    type,
    text: cleanText,
    authorId,
    createdAt: new Date().toISOString()
  };
  trainingMemory.push(entry);
  trimTrainingMemory();
  saveTrainingMemory();
  return entry;
}

function clearTrainingMemory() {
  trainingMemory = [];
  saveTrainingMemory();
}

function formatTrainingMemory() {
  if (trainingMemory.length === 0) {
    return '';
  }

  return trainingMemory
    .map((entry, index) => `${index + 1}. [${entry.type}] ${entry.text}`)
    .join('\n');
}

function buildUserTextWithMemory(userText) {
  const memory = formatTrainingMemory();
  if (!memory) {
    return userText;
  }

  return [
    'Додаткове навчання, яке користувач дав боту в Telegram. Враховуй ці правила, прайси, скрипти й задачі як пріоритетні, якщо вони не суперечать безпеці та чесності:',
    memory,
    'Поточне повідомлення користувача:',
    userText
  ].join('\n\n');
}

function parseTrainingCommand(text) {
  const trimmed = text.trim();
  const slashMatch = trimmed.match(/^\/(teach|prompt)\s+([\s\S]+)/i);
  if (slashMatch) {
    return { type: slashMatch[1].toLowerCase(), text: slashMatch[2] };
  }

  const prefixMatch = trimmed.match(/^(запомни|запам['’]?ятай|запамятай|обучение|навчання|промт|правило)\s*[:\-]\s*([\s\S]+)/i);
  if (prefixMatch) {
    const promptPrefixes = ['промт', 'правило'];
    return {
      type: promptPrefixes.includes(prefixMatch[1].toLowerCase()) ? 'prompt' : 'teach',
      text: prefixMatch[2]
    };
  }

  return null;
}

async function generateWithGemini(chatId, userText) {
  const history = getHistory(chatId).map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }]
  }));
  const chat = geminiModel.startChat({ history });
  const result = await chat.sendMessage(buildUserTextWithMemory(userText));
  return result.response.text().trim();
}

async function generateWithOpenAI(chatId, userText) {
  const messages = [
    { role: 'system', content: [systemPrompt, formatTrainingMemory() ? `\n\nДодаткове навчання з Telegram:\n${formatTrainingMemory()}` : ''].join('') },
    ...getHistory(chatId),
    { role: 'user', content: userText }
  ];
  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages
  });
  return completion.choices[0]?.message?.content?.trim() || '';
}

async function generateAnswer(chatId, userText) {
  if (LLM_PROVIDER === 'openai') {
    return generateWithOpenAI(chatId, userText);
  }

  return generateWithGemini(chatId, userText);
}


function getFriendlyModelError(error) {
  const message = [
    error?.message,
    error?.response?.data?.error?.message,
    error?.errorDetails,
    JSON.stringify(error?.response?.data || {})
  ].filter(Boolean).join(' ');

  if (/quota|RESOURCE_EXHAUSTED|429|rate limit|exceeded/i.test(message)) {
    return 'Сейчас бесплатный Gemini временно упёрся в лимит запросов. Подождите 1–2 минуты и отправьте сообщение ещё раз. Если такое будет часто — лучше подключить платный API или запасную модель.';
  }

  if (/API key|API_KEY|permission|unauthorized|403|401/i.test(message)) {
    return 'Похоже, проблема с Gemini API key или доступом к модели. Проверьте GEMINI_API_KEY в Render Environment.';
  }

  if (/model|not found|404/i.test(message)) {
    return 'Похоже, выбранная Gemini-модель недоступна для этого ключа. Проверьте GEMINI_MODEL в Render Environment.';
  }

  return 'Не смог ответить из-за ошибки модели. Попробуйте ещё раз или переформулируйте вопрос.';
}

function cleanBotFormatting(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/^\s*[*•]\s+/gm, '')
    .replace(/^\s*-\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitTelegramMessage(text) {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let splitAt = remaining.lastIndexOf('\n\n', TELEGRAM_MESSAGE_LIMIT);
    if (splitAt < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      splitAt = remaining.lastIndexOf('\n', TELEGRAM_MESSAGE_LIMIT);
    }
    if (splitAt < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      splitAt = remaining.lastIndexOf('. ', TELEGRAM_MESSAGE_LIMIT);
    }
    if (splitAt < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      splitAt = TELEGRAM_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

async function replyLong(ctx, text) {
  const chunks = splitTelegramMessage(text);
  for (const chunk of chunks) {
    await ctx.reply(chunk, { disable_web_page_preview: true });
  }
}


function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        ['Разобрать ситуацию', 'Ответ клиенту'],
        ['Работа с возражениями', 'Обучение менеджера'],
        ['Просто общение', 'Добавить обучение'],
        ['Примеры']
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}

function situationMenu() {
  return {
    reply_markup: {
      keyboard: [
        ['Начать сначала'],
        ['Назад в меню']
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}


function backMenu() {
  return {
    reply_markup: {
      keyboard: [
        ['Главное меню']
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}

function menuText() {
  return [
    'Главное меню',
    '',
    'Выберите, что нужно сделать:',
    '',
    'Разобрать ситуацию',
    'Глубокий разбор клиента: что происходит, где риск, какой лучший ход и что делать дальше.',
    '',
    'Ответ клиенту',
    'Готовый текст, который можно сразу отправить клиенту.',
    '',
    'Работа с возражениями',
    'Дорого, подумаю, нашёл дешевле, куплю по месту, не доверяю — разбор и сильный ответ.',
    '',
    'Обучение менеджера',
    'Тренировка продаж, скрипты, психология клиента, ошибки и рост навыка.',
    '',
    'Просто общение',
    'Свободный режим: можно спрашивать любые вопросы.',
    '',
    'Добавить обучение',
    'Добавить прайс, скрипт, правило, знания по поставщикам или любую информацию в память бота.',
    '',
    'Примеры',
    'Покажу готовые идеи запросов.'
  ].join('\n');
}

function trainingMenuText() {
  return [
    'Отправьте обучение одним сообщением.',
    '',
    'Можно отправить прайс, скрипт, правила продаж, информацию по поставщикам или любой текст, который бот должен учитывать.'
  ].join('\n');
}

function instructionText() {
  return [
    'Как пользоваться ботом:',
    '',
    '1. Пишите как живому человеку. Можно на русском или украинском.',
    '',
    '2. Если нужно разобрать клиента — нажмите «Разобрать ситуацию».',
    '',
    '3. Если нужен готовый текст — нажмите «Ответ клиенту».',
    '',
    '4. Если клиент возражает — нажмите «Работа с возражениями».',
    '',
    '5. Если хотите тренироваться как менеджер — нажмите «Обучение менеджера».',
    '',
    '6. Для обучения бота нажмите «Добавить обучение» и отправьте прайс, скрипт, правило или любой текст, который бот должен учитывать.',
    '',
    'Для подбора агрегата лучше давать: авто, год, двигатель, стартер/генератор, фото или номер агрегата, VIN, что случилось, бюджет и срочность.',
    '',
    'Команды тоже работают:',
    '/teach текст обучения',
    '/prompt правило поведения',
    '/memory показать память',
    '/forget_all очистить память',
    '/menu открыть меню'
  ].join('\n');
}

function examplesText() {
  return [
    'Примеры, что можно писать:',
    '',
    'Клиент говорит дорого 4200 за генератор, что ответить?',
    '',
    'Клиент хочет купить по месту. Напиши сильный ответ без давления.',
    '',
    'Разбери ситуацию: клиент не доверяет реставрации, хочет только новый агрегат.',
    '',
    'Отработай возражение: я нашёл дешевле на разборке.',
    '',
    'Обучи меня продавать реставрированный оригинал вместо дешёвого б/у.',
    '',
    'Проведи тренировку менеджера по возражениям: дорого, подумаю, нашёл дешевле.',
    '',
    'Сделай готовый текст клиенту: реставрированный оригинал 4200 грн, гарантия 6 месяцев, отправка сегодня.',
    '',
    'Разбери мою переписку с клиентом и скажи, где я теряю продажу.'
  ].join('\n');
}

function situationPrompt() {
  return [
    'Режим: Разобрать ситуацию.',
    '',
    'Я разберу клиента профессионально: что происходит, какая скрытая потребность, где риск, какой лучший ход, что написать клиенту и какой следующий шаг.',
    '',
    'Опишите ситуацию одним сообщением.',
    '',
    'Лучший формат:',
    '1. Что нужно: стартер или генератор.',
    '2. Авто, год, двигатель.',
    '3. Что говорит клиент.',
    '4. Цена/варианты, которые есть.',
    '5. Возражение: дорого, подумаю, по месту, срочно, не подошло.',
    '',
    'Если хотите начать новую ситуацию без старого контекста — нажмите «Начать сначала».'
  ].join('\n');
}

function clientReplyPrompt() {
  return [
    'Режим: Ответ клиенту.',
    '',
    'Я напишу готовый красивый текст, который можно сразу отправить клиенту. Без звёздочек, без лишней воды, живым языком.',
    '',
    'Опишите ситуацию.',
    '',
    'Например:',
    'Клиент говорит дорого. Генератор реставрированный 4200 грн, гарантия 6 месяцев, отправка сегодня Новой Почтой.'
  ].join('\n');
}

function objectionPrompt() {
  return [
    'Режим: Работа с возражениями.',
    '',
    'Я разберу причину возражения, психологию клиента, что нельзя говорить, лучший ответ, готовый текст и следующий шаг.',
    '',
    'Напишите возражение клиента и ситуацию.',
    '',
    'Например:',
    'Клиент говорит: у вас дорого, я нашёл дешевле на разборке.'
  ].join('\n');
}

function managerTrainingPrompt() {
  return [
    'Режим: Обучение менеджера.',
    '',
    'Я проведу обучение глубоко и практично: логика, психология продаж, скрипты, ошибки, тренировка и домашнее задание.',
    '',
    'Напишите, чему нужно обучить менеджера.',
    '',
    'Например:',
    'Научи меня закрывать возражение дорого по генераторам.',
    'Проведи тренировку по продаже реставрированного оригинала.',
    'Разбери мои ошибки в диалоге с клиентом.'
  ].join('\n');
}

function casualChatPrompt() {
  return [
    'Режим: Просто общение.',
    '',
    'Можно свободно задать любой вопрос. Я отвечу как живой умный собеседник, полезно и по делу.',
    '',
    'Пишите вопрос обычным текстом.'
  ].join('\n');
}

function setPendingAction(ctx, action) {
  pendingActions.set(ctx.chat.id, action);
}

function getPendingAction(ctx) {
  return pendingActions.get(ctx.chat.id);
}

function clearPendingAction(ctx) {
  pendingActions.delete(ctx.chat.id);
}

async function setWebhookWithRetry(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await bot.telegram.setWebhook(url);
      return;
    } catch (error) {
      const retryAfter = error.response?.parameters?.retry_after;
      if (error.response?.error_code !== 429 || !retryAfter || attempt === retries) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
    }
  }
}

bot.start((ctx) => {
  histories.delete(ctx.chat.id);
  clearPendingAction(ctx);
  return ctx.reply(menuText(), mainMenu());
});

bot.command('menu', (ctx) => ctx.reply(menuText(), mainMenu()));

bot.command('reset', (ctx) => {
  histories.delete(ctx.chat.id);
  return ctx.reply('Контекст очищен. Можете начать новую ситуацию.');
});

bot.command('whoami', (ctx) => ctx.reply(`Ваш chat_id: ${ctx.chat.id}\nВаш user_id: ${ctx.from.id}`));

bot.command(['teach', 'prompt'], async (ctx) => {
  if (!isTeachingAllowed(ctx)) {
    return ctx.reply('У вас нет доступа к обучению этого бота.');
  }

  const text = ctx.message.text.replace(/^\/(teach|prompt)(@\w+)?\s*/i, '').trim();
  if (!text) {
    return ctx.reply('Напишите так: /teach новый прайс или правило');
  }

  const type = ctx.message.text.toLowerCase().startsWith('/prompt') ? 'prompt' : 'teach';
  addTrainingEntry(type, text, ctx.from.id);
  return ctx.reply('Запомнил. Теперь буду учитывать это в следующих ответах.', mainMenu());
});

bot.command('memory', (ctx) => {
  const memory = formatTrainingMemory();
  if (!memory) {
    return ctx.reply('Пока нет дополнительного обучения. Напишите: /teach ваше правило или прайс');
  }

  return replyLong(ctx, `Что я запомнил:\n\n${memory}`);
});

bot.command('forget_all', (ctx) => {
  if (!isTeachingAllowed(ctx)) {
    return ctx.reply('У вас нет доступа к очистке обучения этого бота.');
  }

  clearTrainingMemory();
  return ctx.reply('Готово. Дополнительное обучение очищено.', mainMenu());
});

bot.help((ctx) => ctx.reply(instructionText(), mainMenu()));

bot.on('text', async (ctx) => {
  const userText = ctx.message.text.trim();
  if (!userText) return;

  if (userText === 'Назад в меню' || userText === 'Главное меню') {
    clearPendingAction(ctx);
    await ctx.reply(menuText(), mainMenu());
    return;
  }

  if (userText === 'Начать сначала') {
    histories.delete(ctx.chat.id);
    setPendingAction(ctx, 'analyze_situation');
    await ctx.reply('Готово. Старую ситуацию убрал из контекста. Опишите новую ситуацию одним сообщением.', situationMenu());
    return;
  }

  if (userText === 'Разобрать ситуацию' || userText === 'Разобрать клиента') {
    setPendingAction(ctx, 'analyze_situation');
    await ctx.reply(situationPrompt(), situationMenu());
    return;
  }

  if (userText === 'Ответ клиенту') {
    setPendingAction(ctx, 'client_reply');
    await ctx.reply(clientReplyPrompt(), backMenu());
    return;
  }

  if (userText === 'Работа с возражениями') {
    setPendingAction(ctx, 'objection_work');
    await ctx.reply(objectionPrompt(), backMenu());
    return;
  }

  if (userText === 'Обучение менеджера') {
    setPendingAction(ctx, 'manager_training');
    await ctx.reply(managerTrainingPrompt(), backMenu());
    return;
  }

  if (userText === 'Просто общение') {
    setPendingAction(ctx, 'casual_chat');
    await ctx.reply(casualChatPrompt(), backMenu());
    return;
  }

  if (userText === 'Новый диалог') {
    histories.delete(ctx.chat.id);
    clearPendingAction(ctx);
    await ctx.reply('Готово. Текущий разговор очищен, можно начать новую ситуацию.', mainMenu());
    return;
  }


  if (userText === 'Добавить обучение') {
    setPendingAction(ctx, 'teach');
    await ctx.reply(['Режим: Добавить обучение.', '', 'Отправьте одним сообщением прайс, скрипт, правило, информацию по поставщику или любой текст, который бот должен учитывать дальше.'].join('\n'), backMenu());
    return;
  }

  if (userText === 'Правило поведения') {
    setPendingAction(ctx, 'prompt');
    await ctx.reply('Отправьте правило поведения. Например: отвечай короче, сначала давай готовый текст клиенту, не используй звёздочки.', mainMenu());
    return;
  }

  if (userText === 'Память бота') {
    const memory = formatTrainingMemory();
    await replyLong(ctx, memory ? `Что я запомнил:

${memory}` : 'Пока нет дополнительного обучения. Нажмите «Добавить обучение» и отправьте текст.');
    return;
  }

  if (userText === 'Инструкция') {
    await replyLong(ctx, instructionText());
    return;
  }

  if (userText === 'Примеры') {
    await replyLong(ctx, examplesText());
    return;
  }

  if (userText === 'Очистить память') {
    setPendingAction(ctx, 'confirm_forget');
    await ctx.reply('Точно очистить всю память обучения? Напишите ДА для подтверждения или НЕТ для отмены.', mainMenu());
    return;
  }

  const pendingAction = getPendingAction(ctx);
  if (pendingAction) {
    if (pendingAction === 'confirm_forget') {
      if (/^(да|так|yes)$/i.test(userText.trim())) {
        if (!isTeachingAllowed(ctx)) {
          await ctx.reply('У вас нет доступа к очистке обучения этого бота.', mainMenu());
          clearPendingAction(ctx);
          return;
        }

        clearTrainingMemory();
        clearPendingAction(ctx);
        await ctx.reply('Готово. Память обучения очищена.', mainMenu());
        return;
      }

      clearPendingAction(ctx);
      await ctx.reply('Ок, не очищаю память.', mainMenu());
      return;
    }

    if (['analyze_client', 'analyze_situation', 'client_reply', 'objection_work', 'manager_training', 'casual_chat'].includes(pendingAction)) {
      clearPendingAction(ctx);
      const prefixes = {
        analyze_client: 'Разбери ситуацию клиента глубоко: что происходит, риски, лучший ход, готовый текст клиенту и следующий шаг. Ситуация:',
        analyze_situation: 'Разбери ситуацию профессионально и интеллектуально: что происходит, какой тип клиента, скрытая потребность, риски, лучший ход, готовый текст клиенту и следующий шаг. Ситуация:',
        client_reply: 'Напиши готовый красивый ответ клиенту без markdown, без звёздочек и без лишней воды. Ситуация:',
        objection_work: 'Отработай возражение клиента профессионально: причина возражения, психология клиента, что нельзя говорить, лучший ответ, готовый текст клиенту и следующий шаг. Возражение и ситуация:',
        manager_training: 'Проведи обучение менеджера по этой теме глубоко и практично: логика, психология продаж, скрипты, ошибки, тренировка и домашнее задание. Тема:',
        casual_chat: 'Ответь как живой умный собеседник, полезно и по делу. Сообщение пользователя:'
      };
      ctx.message.text = `${prefixes[pendingAction]}
${userText}`;
    } else {
      if (!isTeachingAllowed(ctx)) {
        await ctx.reply('У вас нет доступа к обучению этого бота.', mainMenu());
        clearPendingAction(ctx);
        return;
      }

      addTrainingEntry(pendingAction, userText, ctx.from.id);
      clearPendingAction(ctx);
      await ctx.reply('Запомнил. Теперь буду учитывать это в следующих ответах.', mainMenu());
      return;
    }
  }

  const effectiveUserText = ctx.message.text.trim();
  const trainingCommand = parseTrainingCommand(effectiveUserText);
  if (trainingCommand) {
    if (!isTeachingAllowed(ctx)) {
      await ctx.reply('У вас нет доступа к обучению этого бота.');
      return;
    }

    addTrainingEntry(trainingCommand.type, trainingCommand.text, ctx.from.id);
    await ctx.reply('Запомнил. Теперь буду учитывать это в следующих ответах.');
    return;
  }

  await ctx.sendChatAction('typing');

  let answer;
  try {
    const rawAnswer = await generateAnswer(ctx.chat.id, effectiveUserText) || 'Не удалось сформировать ответ.';
    answer = cleanBotFormatting(rawAnswer);
  } catch (error) {
    console.error('LLM error:', error);
    await ctx.reply(getFriendlyModelError(error));
    return;
  }

  saveTurn(ctx.chat.id, effectiveUserText, answer);

  try {
    await replyLong(ctx, answer);
  } catch (error) {
    console.error('Telegram reply error:', error);
    await ctx.reply('Ответ получился слишком длинный или Telegram не принял сообщение. Напишите “короче” — я дам сжатую версию.');
  }
});

bot.catch((error) => {
  console.error('Telegram bot error:', error);
});

async function startBot() {
  const modelName = LLM_PROVIDER === 'openai' ? OPENAI_MODEL : GEMINI_MODEL;
  if (BOT_MODE === 'webhook') {
    if (!WEBHOOK_BASE_URL) {
      throw new Error('WEBHOOK_BASE_URL is required when BOT_MODE=webhook');
    }

    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Starter/generator Telegram bot is running');
        return;
      }

      if (req.method !== 'POST' || req.url !== WEBHOOK_PATH) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      req.on('end', async () => {
        try {
          await bot.handleUpdate(JSON.parse(body || '{}'));
          res.writeHead(200);
          res.end('OK');
        } catch (error) {
          console.error('Webhook update error:', error);
          res.writeHead(500);
          res.end('Webhook error');
        }
      });
    });
    server.listen(PORT);
    if (!SKIP_SET_WEBHOOK) {
      await setWebhookWithRetry(`${WEBHOOK_BASE_URL}${WEBHOOK_PATH}`);
    }
    console.log(`Bot started in webhook mode on port ${PORT} with ${LLM_PROVIDER}:${modelName}`);
    return;
  }

  await bot.launch();
  console.log(`Bot started in polling mode with ${LLM_PROVIDER}:${modelName}`);
}

startBot().catch((error) => {
  console.error('Bot startup error:', error);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
