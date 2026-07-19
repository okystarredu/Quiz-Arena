const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const port = 32000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'hqa-test-'));
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: tempData,
    ADMIN_PASSWORD: 'test-password',
    APP_SECRET: 'test-app-secret-with-enough-length',
    ALLOW_GUESTS: 'true',
    NODE_ENV: 'development'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

child.stdout.on('data', chunk => process.stdout.write(chunk));
child.stderr.on('data', chunk => process.stderr.write(chunk));

function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

async function request(url, options = {}, cookie = '') {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${base}${url}`, { ...options, headers });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${body.error || body}`);
  return { response, body };
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const { body } = await request('/health');
      if (body.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start.');
}

(async () => {
  try {
    await waitForServer();

    const login = await request('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' })
    });
    const adminCookie = cookieFrom(login.response);
    assert(adminCookie.includes('hqa_admin='));

    const csv = fs.readFileSync(path.join(root, 'samples', 'questions_template.csv'));
    const form = new FormData();
    form.append('name', 'Smoke Test Set');
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'questions.csv');
    const imported = await request('/api/admin/sets/import', { method: 'POST', body: form }, adminCookie);
    assert.equal(imported.body.questions.length, 3);

    const sessionResult = await request('/api/admin/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        setId: imported.body.id,
        title: 'Smoke Quiz',
        questionCount: 3,
        timerSeconds: 20,
        scoringMode: 'speed',
        shuffleQuestions: false,
        shuffleAnswers: false
      })
    }, adminCookie);
    const session = sessionResult.body;
    assert.equal(session.status, 'lobby');

    const auth = await request('/api/player/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ guestName: 'Test Player' })
    });
    const playerCookie = cookieFrom(auth.response);
    assert(playerCookie.includes('hqa_player='));

    await request('/api/player/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: session.code })
    }, playerCookie);

    await request(`/api/admin/sessions/${session.id}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delaySeconds: 0 })
    }, adminCookie);

    let state = await request(`/api/player/session/${session.code}`, {}, playerCookie);
    if (state.body.phase === 'countdown') {
      await new Promise(resolve => setTimeout(resolve, 50));
      state = await request(`/api/player/session/${session.code}`, {}, playerCookie);
    }
    assert.equal(state.body.phase, 'question');
    assert.equal(state.body.question.number, 1);

    const answer = await request(`/api/player/session/${session.code}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questionId: state.body.question.id, optionIndex: 1 })
    }, playerCookie);
    assert.equal(answer.body.correct, true);
    assert(answer.body.points >= 500);

    await request(`/api/admin/sessions/${session.id}/finish`, { method: 'POST' }, adminCookie);
    const csvResult = await request(`/api/admin/sessions/${session.id}/results.csv`, {}, adminCookie);
    assert(csvResult.body.includes('Test Player'));
    assert(csvResult.body.includes('Score'));

    console.log('Smoke test passed: import, lobby, timed question, scoring and CSV export.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  }
})();
