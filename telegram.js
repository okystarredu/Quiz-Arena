const crypto = require('crypto');

function cleanBotToken() {
  return String(process.env.BOT_TOKEN || '').trim();
}

function cleanBotUsername() {
  return String(process.env.BOT_USERNAME || '').trim().replace(/^@/, '');
}

function normaliseQuizCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 48);
}

function publicAppUrl(code = '') {
  const publicUrl = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!publicUrl) throw new Error('PUBLIC_URL is missing.');

  let url;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new Error('PUBLIC_URL must be a valid HTTPS URL.');
  }

  if (url.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
    throw new Error('PUBLIC_URL must use HTTPS in production.');
  }

  const quizCode = normaliseQuizCode(code);
  if (quizCode) url.searchParams.set('code', quizCode);
  return url.toString();
}

function botStartLink(code = '') {
  const username = cleanBotUsername();
  if (!username) {
    try { return publicAppUrl(code); }
    catch {
      const localCode = normaliseQuizCode(code);
      return localCode ? `/?code=${encodeURIComponent(localCode)}` : '/';
    }
  }

  const quizCode = normaliseQuizCode(code);
  const startParameter = quizCode ? `quiz_${quizCode}` : 'open';
  return `https://t.me/${username}?start=${encodeURIComponent(startParameter)}`;
}

function directMiniAppLink(code = '') {
  const username = cleanBotUsername();
  const shortName = String(process.env.MINI_APP_SHORT_NAME || '').trim();
  const quizCode = normaliseQuizCode(code);

  if (!username) {
    try { return publicAppUrl(quizCode); }
    catch { return quizCode ? `/?code=${encodeURIComponent(quizCode)}` : '/'; }
  }
  if (shortName) {
    return `https://t.me/${username}/${shortName}?startapp=${encodeURIComponent(quizCode)}`;
  }
  return `https://t.me/${username}?startapp=${encodeURIComponent(quizCode)}`;
}

/*
 * Group messages cannot use an inline-keyboard web_app button. The safest
 * default is therefore a normal bot /start deep link. It opens the private
 * bot chat, where the bot can send a proper web_app button with PUBLIC_URL.
 *
 * Set USE_DIRECT_MINI_APP_LINKS=true only after a Main Mini App or a valid
 * MINI_APP_SHORT_NAME has been configured in BotFather.
 */
function miniAppLink(code = '') {
  const useDirectLinks = ['1', 'true', 'yes'].includes(
    String(process.env.USE_DIRECT_MINI_APP_LINKS || '').trim().toLowerCase()
  );
  return useDirectLinks ? directMiniAppLink(code) : botStartLink(code);
}

function parseStartCode(value = '') {
  const raw = String(value || '').trim();
  if (!raw || raw.toLowerCase() === 'open') return '';
  return normaliseQuizCode(raw.replace(/^quiz_/i, ''));
}

async function telegramApi(method, payload = {}) {
  const token = cleanBotToken();
  if (!token) throw new Error('BOT_TOKEN is missing.');

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Telegram ${method} returned an unreadable response.`);
  }

  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed.`);
  return data.result;
}

async function sendJoinMessage(chatId, session) {
  const url = miniAppLink(session.code);
  const directLinksEnabled = ['1', 'true', 'yes'].includes(
    String(process.env.USE_DIRECT_MINI_APP_LINKS || '').trim().toLowerCase()
  );

  const text = [
    `🏆 <b>${escapeHtml(session.title)}</b>`,
    '',
    `📝 ${session.questionCount} questions`,
    `⏱ ${session.timerSeconds} seconds per question`,
    `🎯 Scoring: ${session.scoringMode === 'speed' ? 'speed points' : 'one point per correct answer'}`,
    '',
    directLinksEnabled
      ? 'Tap below to join the lobby.'
      : 'Tap below, then press “Open Quiz Arena” in the private bot chat.'
  ].join('\n');

  return telegramApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '🎮 Join Quiz', url }]] }
  });
}

async function sendFinalLeaderboard(chatId, session, leaders) {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = leaders.slice(0, 10).map((row, i) => {
    const prefix = medals[i] || `${i + 1}.`;
    return `${prefix} <b>${escapeHtml(row.name)}</b> — ${row.score} pts (${row.correct}/${session.questionCount})`;
  });

  const text = [
    `🏁 <b>${escapeHtml(session.title)} — Final Results</b>`,
    '',
    ...(lines.length ? lines : ['No completed entries.']),
    '',
    'Well done to everyone who participated! 🎉'
  ].join('\n');

  return telegramApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

function webhookSecret() {
  return crypto
    .createHash('sha256')
    .update(process.env.APP_SECRET || 'development-only-secret-change-me')
    .digest('hex')
    .slice(0, 48);
}

async function setWebhook() {
  const publicUrl = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!publicUrl || !cleanBotToken()) return null;

  return telegramApi('setWebhook', {
    url: `${publicUrl}/telegram/webhook`,
    allowed_updates: ['message'],
    secret_token: webhookSecret()
  });
}

async function setMenuButton() {
  if (!cleanBotToken() || !process.env.PUBLIC_URL) return null;
  return telegramApi('setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: 'Open Quiz Arena',
      web_app: { url: publicAppUrl('') }
    }
  });
}

async function getMe() {
  return telegramApi('getMe');
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>]/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;'
  }[ch]));
}

module.exports = {
  telegramApi,
  sendJoinMessage,
  sendFinalLeaderboard,
  setWebhook,
  setMenuButton,
  getMe,
  miniAppLink,
  publicAppUrl,
  parseStartCode,
  webhookSecret
};
