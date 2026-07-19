const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const { loadStore, updateStore } = require('./store');
const { parseQuestionFile } = require('./parsers');
const { validateTelegramInitData, createAdminCookie, verifyAdminCookie } = require('./auth');
const { sendJoinMessage, sendFinalLeaderboard, setWebhook, getMe, telegramApi, miniAppLink, webhookSecret } = require('./telegram');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const PORT = Number(process.env.PORT || 3000);
const APP_SECRET = process.env.APP_SECRET || 'development-only-secret-change-me';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PLAYER_COOKIE = 'hqa_player';
const ADMIN_COOKIE = 'hqa_admin';

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

function code() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let value = '';
  for (let i = 0; i < 6; i++) value += alphabet[crypto.randomInt(0, alphabet.length)];
  return value;
}

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function prepareQuestions(questions, shuffleQuestions, shuffleAnswers) {
  let prepared = questions.map(q => ({ ...q, options: [...q.options] }));
  if (shuffleQuestions) prepared = shuffle(prepared);
  if (shuffleAnswers) {
    prepared = prepared.map(q => {
      const items = q.options.map((text, index) => ({ text, correct: index === q.correctIndex }));
      const mixed = shuffle(items);
      return { ...q, options: mixed.map(item => item.text), correctIndex: mixed.findIndex(item => item.correct) };
    });
  }
  return prepared;
}

function signPlayer(player) {
  const payload = Buffer.from(JSON.stringify(player)).toString('base64url');
  const signature = crypto.createHmac('sha256', APP_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readPlayer(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', APP_SECRET).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const player = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return player && player.id ? player : null;
  } catch {
    return null;
  }
}

function requireAdmin(req, res, next) {
  if (!verifyAdminCookie(req.cookies[ADMIN_COOKIE], APP_SECRET)) {
    return res.status(401).json({ error: 'Admin login required.' });
  }
  next();
}

function requirePlayer(req, res, next) {
  const player = readPlayer(req.cookies[PLAYER_COOKIE]);
  if (!player) return res.status(401).json({ error: 'Open the quiz from Telegram or sign in as a test guest.' });
  req.player = player;
  next();
}

function findSession(store, codeOrId) {
  const needle = String(codeOrId || '').toUpperCase();
  return store.sessions.find(s => s.id === codeOrId || s.code === needle);
}

function questionDurationMs(question, session) {
  return Math.max(5, Math.min(300, Number(question.timeSeconds || session.timerSeconds || 30))) * 1000;
}

function timelineState(session, now = Date.now()) {
  if (session.status === 'lobby') return { phase: 'lobby', index: -1 };
  if (session.status === 'finished') return { phase: 'finished', index: session.questions.length };
  if (!session.startedAt) return { phase: 'lobby', index: -1 };

  let cursor = new Date(session.startedAt).getTime();
  if (now < cursor) return { phase: 'countdown', index: -1, startsAt: cursor };
  for (let i = 0; i < session.questions.length; i++) {
    const duration = questionDurationMs(session.questions[i], session);
    const answerEndsAt = cursor + duration;
    const feedbackEndsAt = answerEndsAt + Number(session.feedbackSeconds || 3) * 1000;
    if (now < answerEndsAt) {
      return { phase: 'question', index: i, questionStartedAt: cursor, answerEndsAt, feedbackEndsAt };
    }
    if (now < feedbackEndsAt) {
      return { phase: 'feedback', index: i, questionStartedAt: cursor, answerEndsAt, feedbackEndsAt };
    }
    cursor = feedbackEndsAt;
  }
  return { phase: 'finished', index: session.questions.length, endedAt: cursor };
}

function participantStats(session, playerId) {
  const participant = session.participants?.[playerId];
  if (!participant) return null;
  const answers = Object.values(participant.answers || {});
  const responseValues = answers.filter(a => a.responseMs != null).map(a => a.responseMs);
  return {
    id: participant.id,
    name: participant.name,
    score: participant.score || 0,
    correct: participant.correct || 0,
    answered: answers.length,
    averageMs: responseValues.length ? Math.round(responseValues.reduce((a, b) => a + b, 0) / responseValues.length) : null
  };
}

function leaderboard(session) {
  return Object.keys(session.participants || {})
    .map(playerId => participantStats(session, playerId))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.correct - a.correct || (a.averageMs ?? Infinity) - (b.averageMs ?? Infinity) || a.name.localeCompare(b.name));
}

function publicSessionState(session, playerId) {
  const state = timelineState(session);
  const participant = session.participants?.[playerId] || null;
  const leaders = leaderboard(session);
  const myStats = participantStats(session, playerId);
  const myRank = myStats ? leaders.findIndex(row => row.id === playerId) + 1 : null;

  const base = {
    id: session.id,
    code: session.code,
    title: session.title,
    status: session.status,
    phase: state.phase,
    questionCount: session.questions.length,
    timerSeconds: session.timerSeconds,
    scoringMode: session.scoringMode,
    participantCount: Object.keys(session.participants || {}).length,
    me: myStats ? { ...myStats, rank: myRank } : null,
    leaderboard: leaders.slice(0, 10),
    serverNow: Date.now(),
    startsAt: state.startsAt || null
  };

  if (state.phase === 'question' || state.phase === 'feedback') {
    const q = session.questions[state.index];
    const answer = participant?.answers?.[q.id] || null;
    base.question = {
      id: q.id,
      number: state.index + 1,
      text: q.question,
      options: q.options,
      category: q.category,
      difficulty: q.difficulty,
      questionStartedAt: state.questionStartedAt,
      answerEndsAt: state.answerEndsAt,
      feedbackEndsAt: state.feedbackEndsAt,
      selectedIndex: answer?.optionIndex ?? null,
      answered: Boolean(answer)
    };
    if (state.phase === 'feedback' || answer) {
      base.feedback = {
        correctIndex: q.correctIndex,
        explanation: q.explanation,
        correct: answer ? answer.correct : null,
        points: answer ? answer.points : 0
      };
    }
  }
  return base;
}

function finishSessionById(sessionId, reason = 'timer') {
  let finished = null;
  updateStore(store => {
    const session = store.sessions.find(s => s.id === sessionId);
    if (!session || session.status === 'finished') return;
    session.status = 'finished';
    session.endedAt = new Date().toISOString();
    session.finishReason = reason;
    finished = JSON.parse(JSON.stringify(session));
  });
  if (finished?.chatId && !finished.finalResultsPosted) {
    const leaders = leaderboard(finished);
    sendFinalLeaderboard(finished.chatId, finished, leaders)
      .then(() => updateStore(store => {
        const live = store.sessions.find(s => s.id === sessionId);
        if (live) live.finalResultsPosted = true;
      }))
      .catch(err => console.error('Could not post final results:', err.message));
  }
  return finished;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

app.get('/health', (req, res) => res.json({ ok: true, name: 'Hermit Quiz Arena', version: '0.2.0' }));
app.get('/api/public/config', (req, res) => res.json({ allowGuests: String(process.env.ALLOW_GUESTS).toLowerCase() === 'true' }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'ADMIN_PASSWORD has not been configured.' });
  if (String(req.body.password || '') !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Incorrect password.' });
  res.cookie(ADMIN_COOKIE, createAdminCookie(APP_SECRET), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE);
  res.json({ ok: true });
});

app.get('/api/admin/status', requireAdmin, async (req, res) => {
  const store = loadStore();
  let bot = null;
  try { if (process.env.BOT_TOKEN) bot = await getMe(); } catch (error) { bot = { error: error.message }; }
  res.json({
    configured: Boolean(process.env.BOT_TOKEN && process.env.PUBLIC_URL && process.env.BOT_USERNAME),
    publicUrl: process.env.PUBLIC_URL || '',
    bot,
    setCount: store.sets.length,
    sessionCount: store.sessions.length,
    chatCount: store.chats.length
  });
});

app.get('/api/admin/sets', requireAdmin, (req, res) => {
  const store = loadStore();
  res.json(store.sets.map(set => ({ ...set, questions: set.questions })));
});

app.post('/api/admin/sets/import', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a question file.' });
    const questions = await parseQuestionFile(req.file);
    if (!questions.length) return res.status(400).json({ error: 'No questions were found.' });
    const set = {
      id: id('set'),
      name: String(req.body.name || path.parse(req.file.originalname).name || 'Imported Quiz').trim(),
      description: String(req.body.description || '').trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      questions
    };
    updateStore(store => store.sets.unshift(set));
    res.json(set);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/admin/sets/:id', requireAdmin, (req, res) => {
  try {
    let updated;
    updateStore(store => {
      const set = store.sets.find(item => item.id === req.params.id);
      if (!set) throw new Error('Question set not found.');
      if (req.body.name != null) set.name = String(req.body.name).trim() || set.name;
      if (req.body.description != null) set.description = String(req.body.description).trim();
      if (Array.isArray(req.body.questions)) {
        const { normaliseQuestion } = require('./parsers');
        set.questions = req.body.questions.map((q, index) => ({ ...normaliseQuestion(q, index), id: q.id || id('q') }));
      }
      set.updatedAt = new Date().toISOString();
      updated = set;
    });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/sets/:id', requireAdmin, (req, res) => {
  updateStore(store => {
    store.sets = store.sets.filter(item => item.id !== req.params.id);
  });
  res.json({ ok: true });
});

app.get('/api/admin/chats', requireAdmin, (req, res) => res.json(loadStore().chats));

app.get('/api/admin/sessions', requireAdmin, (req, res) => {
  const sessions = loadStore().sessions.map(session => ({
    id: session.id,
    code: session.code,
    title: session.title,
    status: session.status,
    questionCount: session.questions.length,
    participantCount: Object.keys(session.participants || {}).length,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    chatId: session.chatId,
    leaderboard: leaderboard(session).slice(0, 10)
  }));
  res.json(sessions);
});

app.post('/api/admin/sessions', requireAdmin, (req, res) => {
  try {
    let created;
    updateStore(store => {
      const set = store.sets.find(item => item.id === req.body.setId);
      if (!set) throw new Error('Choose a valid question set.');
      const requestedCount = Math.max(1, Math.min(set.questions.length, Number(req.body.questionCount || set.questions.length)));
      const source = req.body.shuffleQuestions ? shuffle(set.questions).slice(0, requestedCount) : set.questions.slice(0, requestedCount);
      const questions = prepareQuestions(source, false, Boolean(req.body.shuffleAnswers));
      let sessionCode;
      do { sessionCode = code(); } while (store.sessions.some(s => s.code === sessionCode));
      created = {
        id: id('session'),
        code: sessionCode,
        setId: set.id,
        title: String(req.body.title || set.name).trim(),
        questions,
        questionCount: questions.length,
        timerSeconds: Math.max(5, Math.min(300, Number(req.body.timerSeconds || 30))),
        feedbackSeconds: Math.max(1, Math.min(10, Number(req.body.feedbackSeconds || 3))),
        scoringMode: req.body.scoringMode === 'classic' ? 'classic' : 'speed',
        shuffleAnswers: Boolean(req.body.shuffleAnswers),
        chatId: req.body.chatId ? String(req.body.chatId) : '',
        status: 'lobby',
        participants: {},
        createdAt: new Date().toISOString(),
        startedAt: null,
        endedAt: null,
        finalResultsPosted: false
      };
      store.sessions.unshift(created);
      store.sessions = store.sessions.slice(0, 100);
    });
    res.json({ ...created, joinUrl: miniAppLink(created.code) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/sessions/:id/announce', requireAdmin, async (req, res) => {
  try {
    const store = loadStore();
    const session = findSession(store, req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    const chatId = String(req.body.chatId || session.chatId || '');
    if (!chatId) return res.status(400).json({ error: 'Choose a registered Telegram group.' });
    const message = await sendJoinMessage(chatId, session);
    updateStore(liveStore => {
      const live = findSession(liveStore, session.id);
      if (live) { live.chatId = chatId; live.announcementMessageId = message.message_id; }
    });
    res.json({ ok: true, messageId: message.message_id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/sessions/:id/start', requireAdmin, (req, res) => {
  try {
    let started;
    updateStore(store => {
      const session = findSession(store, req.params.id);
      if (!session) throw new Error('Session not found.');
      if (session.status === 'finished') throw new Error('This session has already finished.');
      session.status = 'live';
      session.startedAt = new Date(Date.now() + Math.max(0, Number(req.body.delaySeconds ?? 3)) * 1000).toISOString();
      started = session;
    });
    res.json(started);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/admin/sessions/:id/finish', requireAdmin, (req, res) => {
  const finished = finishSessionById(req.params.id, 'admin');
  if (!finished) return res.status(404).json({ error: 'Session not found or already finished.' });
  res.json({ ok: true });
});

app.get('/api/admin/sessions/:id/results.csv', requireAdmin, (req, res) => {
  const store = loadStore();
  const session = findSession(store, req.params.id);
  if (!session) return res.status(404).send('Session not found.');
  const rows = [['Rank', 'Name', 'Score', 'Correct', 'Answered', 'Accuracy', 'Average Response Seconds']];
  leaderboard(session).forEach((row, index) => {
    rows.push([
      index + 1,
      row.name,
      row.score,
      row.correct,
      row.answered,
      row.answered ? `${Math.round((row.correct / row.answered) * 100)}%` : '0%',
      row.averageMs == null ? '' : (row.averageMs / 1000).toFixed(2)
    ]);
  });
  const csv = rows.map(row => row.map(csvEscape).join(',')).join('\n');
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${session.code}-leaderboard.csv"`);
  res.send(`\ufeff${csv}`);
});

app.post('/api/player/auth', (req, res) => {
  let player = validateTelegramInitData(req.body.initData, process.env.BOT_TOKEN);
  if (!player && String(process.env.ALLOW_GUESTS).toLowerCase() === 'true') {
    const guestName = String(req.body.guestName || '').trim().slice(0, 40);
    if (guestName) player = { id: `guest_${crypto.createHash('sha1').update(`${guestName}:${req.ip}`).digest('hex').slice(0, 16)}`, name: guestName, username: '', guest: true };
  }
  if (!player) return res.status(401).json({ error: 'Telegram sign-in failed. Please open the quiz from the Telegram bot.' });
  res.cookie(PLAYER_COOKIE, signPlayer(player), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  });
  res.json({ player });
});

app.post('/api/player/join', requirePlayer, (req, res) => {
  try {
    const sessionCode = String(req.body.code || '').trim().toUpperCase();
    let joined;
    updateStore(store => {
      const session = findSession(store, sessionCode);
      if (!session) throw new Error('Quiz code not found.');
      session.participants ||= {};
      session.participants[req.player.id] ||= {
        id: req.player.id,
        name: req.player.name,
        username: req.player.username || '',
        joinedAt: new Date().toISOString(),
        score: 0,
        correct: 0,
        answers: {}
      };
      joined = publicSessionState(session, req.player.id);
    });
    res.json(joined);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/player/session/:code', requirePlayer, (req, res) => {
  const store = loadStore();
  const session = findSession(store, req.params.code);
  if (!session) return res.status(404).json({ error: 'Quiz not found.' });
  if (!session.participants?.[req.player.id]) return res.status(403).json({ error: 'Join this quiz first.' });
  res.json(publicSessionState(session, req.player.id));
});

app.post('/api/player/session/:code/answer', requirePlayer, (req, res) => {
  try {
    let response;
    updateStore(store => {
      const session = findSession(store, req.params.code);
      if (!session) throw new Error('Quiz not found.');
      const participant = session.participants?.[req.player.id];
      if (!participant) throw new Error('Join this quiz first.');
      const state = timelineState(session);
      if (state.phase !== 'question') throw new Error('This question is no longer accepting answers.');
      const question = session.questions[state.index];
      if (String(req.body.questionId) !== question.id) throw new Error('The quiz has moved to another question.');
      if (participant.answers[question.id]) throw new Error('Your answer has already been recorded.');
      const optionIndex = Number(req.body.optionIndex);
      if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= question.options.length) throw new Error('Invalid answer option.');
      const responseMs = Math.max(0, Date.now() - state.questionStartedAt);
      const correct = optionIndex === question.correctIndex;
      let points = 0;
      if (correct) {
        if (session.scoringMode === 'classic') points = 1;
        else {
          const duration = questionDurationMs(question, session);
          points = Math.max(500, Math.min(1000, 500 + Math.round(500 * (1 - responseMs / duration))));
        }
      }
      participant.answers[question.id] = { optionIndex, correct, points, responseMs, answeredAt: new Date().toISOString() };
      participant.score = Number(participant.score || 0) + points;
      participant.correct = Number(participant.correct || 0) + (correct ? 1 : 0);
      response = {
        correct,
        points,
        correctIndex: question.correctIndex,
        explanation: question.explanation,
        score: participant.score,
        streak: calculateStreak(session, participant, state.index)
      };
    });
    res.json(response);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

function calculateStreak(session, participant, currentIndex) {
  let streak = 0;
  for (let i = currentIndex; i >= 0; i--) {
    const answer = participant.answers?.[session.questions[i].id];
    if (!answer?.correct) break;
    streak++;
  }
  return streak;
}

app.post('/telegram/webhook', async (req, res) => {
  if (process.env.BOT_TOKEN && req.get('x-telegram-bot-api-secret-token') !== webhookSecret()) return res.sendStatus(403);
  res.sendStatus(200);
  try {
    const message = req.body?.message;
    if (!message?.chat) return;
    const text = String(message.text || '');
    const command = text.split(/\s+/)[0].split('@')[0].toLowerCase();
    if (command === '/quizsetup' && ['group', 'supergroup'].includes(message.chat.type)) {
      updateStore(store => {
        const chatId = String(message.chat.id);
        const existing = store.chats.find(chat => chat.id === chatId);
        const record = { id: chatId, title: message.chat.title || `Group ${chatId}`, type: message.chat.type, updatedAt: new Date().toISOString() };
        if (existing) Object.assign(existing, record); else store.chats.unshift(record);
      });
      await telegramApi('sendMessage', {
        chat_id: message.chat.id,
        text: '✅ This group is now connected to Hermit Quiz Arena. Create and announce quizzes from the admin page.'
      });
    } else if (command === '/start' && message.chat.type === 'private') {
      const url = miniAppLink('');
      await telegramApi('sendMessage', {
        chat_id: message.chat.id,
        text: 'Welcome to Hermit Quiz Arena! Tap below to open the quiz app.',
        reply_markup: { inline_keyboard: [[{ text: '🎮 Open Quiz Arena', url }]] }
      });
    }
  } catch (error) {
    console.error('Webhook error:', error.message);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: 'Something went wrong. Check the Render logs for details.' });
});

setInterval(() => {
  try {
    const store = loadStore();
    for (const session of store.sessions) {
      if (session.status === 'live' && timelineState(session).phase === 'finished') finishSessionById(session.id, 'timer');
    }
  } catch (error) {
    console.error('Session scheduler error:', error.message);
  }
}, 1500).unref();

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Hermit Quiz Arena running on port ${PORT}`);
  if (process.env.PUBLIC_URL && process.env.BOT_TOKEN) {
    try {
      await setWebhook();
      console.log('Telegram webhook configured.');
    } catch (error) {
      console.error('Webhook setup failed:', error.message);
    }
  }
});

module.exports = { app, timelineState, leaderboard, prepareQuestions };
