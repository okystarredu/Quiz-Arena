const crypto = require('crypto');
async function telegramApi(method, payload = {}) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN is missing.');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed.`);
  return data.result;
}

function miniAppLink(code) {
  const username = (process.env.BOT_USERNAME || '').replace(/^@/, '');
  const shortName = (process.env.MINI_APP_SHORT_NAME || '').trim();
  if (!username) return `${process.env.PUBLIC_URL || ''}/?code=${encodeURIComponent(code)}`;
  if (shortName) return `https://t.me/${username}/${shortName}?startapp=${encodeURIComponent(code)}`;
  return `https://t.me/${username}?startapp=${encodeURIComponent(code)}`;
}

async function sendJoinMessage(chatId, session) {
  const url = miniAppLink(session.code);
  const text = [
    `🏆 <b>${escapeHtml(session.title)}</b>`,
    '',
    `📝 ${session.questionCount} questions`,
    `⏱ ${session.timerSeconds} seconds per question`,
    `🎯 Scoring: ${session.scoringMode === 'speed' ? 'speed points' : 'one point per correct answer'}`,
    '',
    'Tap below to join the lobby.'
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
  return crypto.createHash('sha256').update(process.env.APP_SECRET || 'development-only-secret-change-me').digest('hex').slice(0, 48);
}

async function setWebhook() {
  const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  if (!publicUrl || !process.env.BOT_TOKEN) return null;
  return telegramApi('setWebhook', {
    url: `${publicUrl}/telegram/webhook`,
    allowed_updates: ['message'],
    secret_token: webhookSecret()
  });
}

async function getMe() {
  return telegramApi('getMe');
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

module.exports = { telegramApi, sendJoinMessage, sendFinalLeaderboard, setWebhook, getMe, miniAppLink, webhookSecret };
