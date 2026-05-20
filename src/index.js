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
const BOT_MODE = (process.env.BOT_MODE || (process.env.RENDER ? 'webhook' : 'polling')).toLowerCase();
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/telegram-webhook';
const PORT = Number(process.env.PORT || 3000);
const SKIP_SET_WEBHOOK = process.env.SKIP_SET_WEBHOOK === 'true';

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

async function generateWithGemini(chatId, userText) {
  const history = getHistory(chatId).map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }]
  }));
  const chat = geminiModel.startChat({ history });
  const result = await chat.sendMessage(userText);
  return result.response.text().trim();
}

async function generateWithOpenAI(chatId, userText) {
  const messages = [
    { role: 'system', content: systemPrompt },
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
  return ctx.reply(
    'Привет. Я обучающий консультант по стартерам и генераторам. Опиши ситуацию клиента, авто, бюджет или вопрос — подскажу что ответить и какие данные уточнить.'
  );
});

bot.command('reset', (ctx) => {
  histories.delete(ctx.chat.id);
  return ctx.reply('Контекст очищен. Можете начать новую ситуацию.');
});

bot.help((ctx) => ctx.reply([
  'Напишите ситуацию клиента обычным сообщением.',
  'Примеры:',
  '• Клиенту дорого 4200 за генератор, что ответить?',
  '• VW T4 1.9, генератор, есть только VIN — какие вопросы задать?',
  '• Клиент спрашивает гарантию и талон.'
].join('\n')));

bot.on('text', async (ctx) => {
  const userText = ctx.message.text.trim();
  if (!userText) return;

  await ctx.sendChatAction('typing');

  try {
    const answer = await generateAnswer(ctx.chat.id, userText) || 'Не удалось сформировать ответ.';
    saveTurn(ctx.chat.id, userText, answer);
    await ctx.reply(answer, { disable_web_page_preview: true });
  } catch (error) {
    console.error('LLM error:', error);
    await ctx.reply('Не смог ответить из-за ошибки модели. Попробуйте ещё раз или переформулируйте вопрос.');
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
