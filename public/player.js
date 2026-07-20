(() => {
  let tg = window.Telegram?.WebApp || null;

  function refreshTelegramWebApp() {
    tg = window.Telegram?.WebApp || tg;
    return tg;
  }

  function initialiseTelegramWebApp() {
    const webApp = refreshTelegramWebApp();
    if (!webApp) return;
    try {
      webApp.ready();
      webApp.expand();
    } catch {}
  }

  initialiseTelegramWebApp();

  const $ = id => document.getElementById(id);
  const screens = ['authCard', 'joinCard', 'lobbyCard', 'quizCard', 'finalCard'];
  let currentCode = '';
  let pollTimer = null;
  let clockTimer = null;
  let lastQuestionId = null;
  let latestState = null;
  let answering = false;

  function show(id) {
    screens.forEach(screen => $(screen).classList.toggle('hidden', screen !== id));
  }

  function message(el, text, type = '') {
    el.textContent = text;
    el.className = `notice ${type}`.trim();
    el.classList.remove('hidden');
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function getTelegramInitData() {
    /* Allow a moment for the Telegram bridge to initialise on slower devices. */
    for (let attempt = 0; attempt < 20; attempt++) {
      const webApp = refreshTelegramWebApp();
      if (webApp?.initData) return webApp.initData;
      await delay(100);
    }
    return refreshTelegramWebApp()?.initData || '';
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      ...options
    });

    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  function startParam() {
    const params = new URLSearchParams(location.search);
    const webApp = refreshTelegramWebApp();
    return webApp?.initDataUnsafe?.start_param || params.get('tgWebAppStartParam') || params.get('code') || '';
  }

  async function authenticate(guestName = '') {
    try {
      initialiseTelegramWebApp();
      const initData = guestName ? '' : await getTelegramInitData();
      const data = await api('/api/player/auth', {
        method: 'POST',
        body: JSON.stringify({ initData, guestName })
      });

      const initialCode = startParam().trim().toUpperCase();
      $('quizCode').value = initialCode;
      show('joinCard');
      if (initialCode) joinQuiz();
      return data;
    } catch (error) {
      message($('authStatus'), error.message, 'error');
      try {
        const config = await api('/api/public/config');
        if (config.allowGuests) $('guestBox').classList.remove('hidden');
      } catch {}
    }
  }

  async function joinQuiz() {
    const code = $('quizCode').value.trim().toUpperCase();
    if (!code) return message($('joinMessage'), 'Enter the quiz code.', 'error');
    $('joinButton').disabled = true;

    try {
      const state = await api('/api/player/join', {
        method: 'POST',
        body: JSON.stringify({ code })
      });
      currentCode = code;
      render(state);
      beginPolling();
    } catch (error) {
      message($('joinMessage'), error.message, 'error');
    } finally {
      $('joinButton').disabled = false;
    }
  }

  function beginPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(loadState, 800);
    loadState();
  }

  async function loadState() {
    if (!currentCode || answering) return;
    try {
      const state = await api(`/api/player/session/${encodeURIComponent(currentCode)}`);
      render(state);
    } catch (error) {
      console.warn(error.message);
    }
  }

  function render(state) {
    latestState = state;
    if (state.phase === 'lobby' || state.phase === 'countdown') return renderLobby(state);
    if (state.phase === 'question' || state.phase === 'feedback') return renderQuestion(state);
    if (state.phase === 'finished') return renderFinal(state);
  }

  function renderLobby(state) {
    show('lobbyCard');
    $('lobbyTitle').textContent = state.title;
    $('lobbyPlayers').textContent = state.participantCount;
    $('lobbyQuestions').textContent = state.questionCount;
    $('lobbyTimer').textContent = `${state.timerSeconds}s`;
    if (state.phase === 'countdown') {
      const seconds = Math.max(1, Math.ceil((Number(state.startsAt) - Date.now()) / 1000));
      $('lobbyMessage').textContent = `Starting in ${seconds}…`;
    } else {
      $('lobbyMessage').textContent = 'You are in. The host will begin shortly.';
    }
  }

  function renderQuestion(state) {
    show('quizCard');
    const q = state.question;
    $('questionNumber').textContent = `Question ${q.number} of ${state.questionCount}`;
    $('scoreText').textContent = `${state.me?.score || 0} ${state.scoringMode === 'classic' ? 'points' : 'pts'}`;
    $('categoryText').textContent = [q.subject, q.topic || q.category, q.difficulty, q.marks ? `${q.marks} mark${Number(q.marks) === 1 ? '' : 's'}` : ''].filter(Boolean).join(' • ');
    const image = $('questionImage');
    if (q.imageUrl) {
      image.src = q.imageUrl;
      image.classList.remove('hidden');
      image.onerror = () => image.classList.add('hidden');
    } else {
      image.removeAttribute('src');
      image.classList.add('hidden');
    }
    $('questionText').textContent = q.text;

    if (lastQuestionId !== q.id) {
      lastQuestionId = q.id;
      $('feedbackBox').className = 'feedback hidden';
      $('feedbackBox').innerHTML = '';
    }

    renderOptions(state);
    startClock(q.answerEndsAt);

    if (state.feedback) {
      showFeedback(state.feedback, false);
      $('liveBoardWrap').classList.remove('hidden');
      renderLeaderboard($('liveLeaderboard'), state.leaderboard.slice(0, 3), state.me?.id);
    } else {
      $('liveBoardWrap').classList.add('hidden');
    }
  }

  function renderOptions(state) {
    const q = state.question;
    const existing = [...$('options').querySelectorAll('button')];
    if (existing.length !== q.options.length || existing[0]?.dataset.questionId !== q.id) {
      $('options').innerHTML = '';
      q.options.forEach((text, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'option';
        button.dataset.index = String(index);
        button.dataset.questionId = q.id;
        button.innerHTML = `<span class="letter">${String.fromCharCode(65 + index)}</span><span></span>`;
        button.lastElementChild.textContent = text;
        button.addEventListener('click', () => submitAnswer(q.id, index));
        $('options').appendChild(button);
      });
    }

    [...$('options').children].forEach((button, index) => {
      button.disabled = q.answered || state.phase !== 'question';
      button.classList.toggle('selected', q.selectedIndex === index);
      button.classList.remove('correct', 'wrong');
      if (state.feedback) {
        if (index === state.feedback.correctIndex) button.classList.add('correct');
        if (q.selectedIndex === index && state.feedback.correct === false) button.classList.add('wrong');
      }
    });
  }

  async function submitAnswer(questionId, optionIndex) {
    if (answering) return;
    answering = true;
    [...$('options').children].forEach(button => { button.disabled = true; });
    const selected = $('options').children[optionIndex];
    selected?.classList.add('selected');

    try {
      const result = await api(`/api/player/session/${encodeURIComponent(currentCode)}/answer`, {
        method: 'POST',
        body: JSON.stringify({ questionId, optionIndex })
      });
      if (latestState?.question?.id === questionId) {
        latestState.question.answered = true;
        latestState.question.selectedIndex = optionIndex;
        latestState.feedback = result;
        latestState.me.score = result.score;
      }
      markAnswer(optionIndex, result.correctIndex, result.correct);
      showFeedback(result, true);
      $('scoreText').textContent = `${result.score} ${latestState?.scoringMode === 'classic' ? 'points' : 'pts'}`;
      const webApp = refreshTelegramWebApp();
      if (webApp?.HapticFeedback) {
        try { webApp.HapticFeedback.notificationOccurred(result.correct ? 'success' : 'error'); } catch {}
      }
    } catch (error) {
      showFeedback({ correct: false, points: 0, explanation: error.message, correctIndex: -1 }, false, true);
    } finally {
      answering = false;
    }
  }

  function markAnswer(selectedIndex, correctIndex, correct) {
    [...$('options').children].forEach((button, index) => {
      if (index === correctIndex) button.classList.add('correct');
      if (index === selectedIndex && !correct) button.classList.add('wrong', 'shake');
      button.disabled = true;
    });
  }

  function showFeedback(feedback, animate = false, isError = false) {
    const box = $('feedbackBox');
    const correct = feedback.correct === true;
    box.className = `feedback ${correct ? 'correct' : 'wrong'}`;
    const heading = isError ? 'Answer not recorded' : correct ? 'Correct!' : feedback.correct === false ? 'Not quite' : 'Time is up';
    const icon = isError ? '⚠️' : correct ? '🎉' : '❌';
    const points = correct ? `<p><strong>+${feedback.points} points</strong>${feedback.streak > 1 ? ` • 🔥 ${feedback.streak} streak` : ''}</p>` : '';
    const explanation = feedback.explanation ? '<p class="muted small"></p>' : '';
    box.innerHTML = `<div class="feedback-icon">${icon}</div><h3>${heading}</h3>${points}${explanation}`;
    if (feedback.explanation) box.querySelector('p.muted').textContent = feedback.explanation;
    if (correct && animate) burstConfetti();
  }

  function startClock(answerEndsAt) {
    clearInterval(clockTimer);
    const update = () => {
      const remaining = Math.max(0, Number(answerEndsAt) - Date.now());
      const seconds = Math.ceil(remaining / 1000);
      $('timerText').textContent = `00:${String(seconds).padStart(2, '0')}`;
      const q = latestState?.question;
      const total = Math.max(1, Number(q?.answerEndsAt || 0) - Number(q?.questionStartedAt || latestState?.serverNow || Date.now()));
      const elapsedRatio = 1 - remaining / total;
      $('timerBar').style.width = `${Math.max(0, Math.min(100, elapsedRatio * 100))}%`;
      if (!remaining) clearInterval(clockTimer);
    };
    update();
    clockTimer = setInterval(update, 100);
  }

  function renderFinal(state) {
    clearInterval(clockTimer);
    show('finalCard');
    $('finalTitle').textContent = state.title;
    $('finalRank').textContent = state.me?.rank ? `#${state.me.rank}` : '—';
    $('finalScore').textContent = state.me?.score ?? 0;
    const answered = state.me?.answered || 0;
    $('finalAccuracy').textContent = answered ? `${Math.round((state.me.correct / answered) * 100)}%` : '0%';
    renderLeaderboard($('finalLeaderboard'), state.leaderboard, state.me?.id);
  }

  function renderLeaderboard(container, rows, myId) {
    container.innerHTML = '';
    rows.forEach((row, index) => {
      const div = document.createElement('div');
      div.className = `leader-row ${row.id === myId ? 'me' : ''}`;
      const medal = ['🥇', '🥈', '🥉'][index] || `${index + 1}`;
      div.innerHTML = `<div class="rank">${medal}</div><div><strong></strong><div class="small muted">${row.correct} correct</div></div><div class="score">${row.score}</div>`;
      div.querySelector('strong').textContent = row.name;
      container.appendChild(div);
    });
    if (!rows.length) container.innerHTML = '<div class="notice">No scores yet.</div>';
  }

  function burstConfetti() {
    const container = $('confetti');
    container.innerHTML = '';
    const colours = ['#7c5cff', '#24c8a5', '#ffbd4a', '#ff5d73', '#ffffff'];
    for (let i = 0; i < 48; i++) {
      const piece = document.createElement('i');
      piece.style.setProperty('--x', `${Math.random() * 100}%`);
      piece.style.setProperty('--r', `${Math.random() * 360}deg`);
      piece.style.setProperty('--c', colours[i % colours.length]);
      piece.style.animationDelay = `${Math.random() * .25}s`;
      container.appendChild(piece);
    }
    setTimeout(() => { container.innerHTML = ''; }, 1900);
  }

  $('joinButton').addEventListener('click', joinQuiz);
  $('quizCode').addEventListener('keydown', event => { if (event.key === 'Enter') joinQuiz(); });
  $('guestLogin').addEventListener('click', () => authenticate($('guestName').value.trim()));
  $('guestName').addEventListener('keydown', event => { if (event.key === 'Enter') authenticate($('guestName').value.trim()); });

  authenticate();
})();
