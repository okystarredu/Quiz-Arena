(() => {
  const $ = id => document.getElementById(id);
  let sets = [];
  let chats = [];
  let sessions = [];
  let editingSet = null;
  let createdSession = null;

  async function api(url, options = {}) {
    const fetchOptions = { credentials: 'include', ...options };
    if (options.body && !(options.body instanceof FormData)) {
      fetchOptions.headers = { 'content-type': 'application/json', ...(options.headers || {}) };
    }
    const response = await fetch(url, fetchOptions);
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  function notice(el, text, type = '') {
    el.textContent = text;
    el.className = `notice ${type}`.trim();
    el.classList.remove('hidden');
  }

  function activateTab(name) {
    document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === name));
    ['dashboard', 'questions', 'create', 'sessions'].forEach(tab => {
      $(`tab-${tab}`).classList.toggle('hidden', tab !== name);
    });
    if (name === 'questions') loadSets();
    if (name === 'create') refreshCreateOptions();
    if (name === 'sessions') loadSessions();
  }

  async function login() {
    $('loginButton').disabled = true;
    try {
      await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('adminPassword').value }) });
      await openAdmin();
    } catch (error) {
      notice($('loginMessage'), error.message, 'error');
    } finally {
      $('loginButton').disabled = false;
    }
  }

  async function openAdmin() {
    try {
      const status = await api('/api/admin/status');
      $('loginView').classList.add('hidden');
      $('adminView').classList.remove('hidden');
      renderStatus(status);
      await Promise.all([loadSets(), loadChats(), loadSessions()]);
    } catch {
      $('loginView').classList.remove('hidden');
      $('adminView').classList.add('hidden');
    }
  }

  function renderStatus(status) {
    $('metricSets').textContent = status.setCount;
    $('metricSessions').textContent = status.sessionCount;
    $('metricChats').textContent = status.chatCount;
    if (status.configured && status.bot && !status.bot.error) {
      notice($('systemStatus'), `Ready. Connected as @${status.bot.username}. Public app: ${status.publicUrl}`, 'success');
    } else {
      const problem = status.bot?.error || 'BOT_TOKEN, BOT_USERNAME or PUBLIC_URL is missing.';
      notice($('systemStatus'), `Setup incomplete: ${problem}`, 'error');
    }
  }

  async function loadSets() {
    sets = await api('/api/admin/sets');
    renderSets();
    refreshCreateOptions();
  }

  function renderSets() {
    const container = $('setsList');
    container.innerHTML = '';
    sets.forEach(set => {
      const item = document.createElement('div');
      item.className = 'list-item';
      item.innerHTML = `
        <div class="list-head">
          <div><strong></strong><div class="small muted">${set.questions.length} questions${set.description ? ` • ${escapeHtml(set.description)}` : ''}</div></div>
          <span class="badge">QUESTION SET</span>
        </div>
        <div class="actions" style="margin-top:11px">
          <button class="btn small-btn edit-set" type="button">Review & edit</button>
          <button class="btn small-btn delete-set danger" type="button">Delete</button>
        </div>`;
      item.querySelector('strong').textContent = set.name;
      item.querySelector('.edit-set').addEventListener('click', () => openEditor(set.id));
      item.querySelector('.delete-set').addEventListener('click', () => deleteSet(set.id, set.name));
      container.appendChild(item);
    });
    if (!sets.length) container.innerHTML = '<div class="notice">No question sets yet. Import your first CSV, TXT, DOCX or JSON file above.</div>';
  }

  function openEditor(setId) {
    const source = sets.find(set => set.id === setId);
    editingSet = JSON.parse(JSON.stringify(source));
    $('editorCard').classList.remove('hidden');
    $('editorTitle').textContent = 'Edit question set';
    $('editorSetName').value = editingSet.name;
    renderEditorQuestions();
    $('editorCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderEditorQuestions() {
    $('editorCount').textContent = `${editingSet.questions.length} questions`;
    const container = $('questionEditor');
    container.innerHTML = '';
    editingSet.questions.forEach((question, index) => {
      const row = document.createElement('div');
      row.className = 'editor-row';
      row.innerHTML = `
        <div class="list-head"><strong>Question ${index + 1}</strong><button class="btn small-btn danger remove-question" type="button">Remove</button></div>
        <div class="field" style="margin-top:9px"><label>Question</label><textarea class="question-text" rows="2"></textarea></div>
        <div class="editor-options"></div>
        <div class="actions option-actions" style="margin-top:9px">
          <button class="btn small-btn add-option" type="button">Add option</button>
          <button class="btn small-btn remove-option" type="button">Remove last option</button>
        </div>
        <div class="grid two" style="margin-top:9px">
          <div class="field"><label>Correct answer</label><select class="correct-answer"></select></div>
          <div class="field"><label>Time limit in seconds (0 = session timer)</label><input class="input question-time" type="number" min="0" max="300"></div>
          <div class="field"><label>Subject</label><input class="input subject"></div>
          <div class="field"><label>Topic</label><input class="input topic"></div>
          <div class="field"><label>Difficulty</label><select class="difficulty"><option>Easy</option><option>Medium</option><option>Hard</option></select></div>
          <div class="field"><label>Marks</label><input class="input marks" type="number" min="1" max="100"></div>
        </div>
        <div class="field" style="margin-top:9px"><label>Image URL (optional)</label><input class="input image-url" type="url" placeholder="https://example.com/image.jpg"></div>
        <div class="field" style="margin-top:9px"><label>Explanation (optional)</label><textarea class="explanation" rows="2"></textarea></div>`;
      row.querySelector('.question-text').value = question.question;
      row.querySelector('.explanation').value = question.explanation || '';
      row.querySelector('.question-time').value = question.timeSeconds || 0;
      row.querySelector('.subject').value = question.subject || '';
      row.querySelector('.topic').value = question.topic || question.category || '';
      row.querySelector('.difficulty').value = question.difficulty || 'Medium';
      row.querySelector('.marks').value = question.marks || 1;
      row.querySelector('.image-url').value = question.imageUrl || '';
      const optionsContainer = row.querySelector('.editor-options');
      const correctSelect = row.querySelector('.correct-answer');
      question.options.forEach((option, optionIndex) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'field';
        wrapper.innerHTML = `<label>Option ${String.fromCharCode(65 + optionIndex)}</label><input class="input option-text">`;
        wrapper.querySelector('input').value = option;
        optionsContainer.appendChild(wrapper);
        const opt = document.createElement('option');
        opt.value = String(optionIndex);
        opt.textContent = `Option ${String.fromCharCode(65 + optionIndex)}`;
        correctSelect.appendChild(opt);
      });
      correctSelect.value = String(question.correctIndex);
      row.querySelector('.add-option').addEventListener('click', () => {
        captureEditor();
        const target = editingSet.questions[index];
        if (target.options.length >= 6) return notice($('editorMessage'), 'A question can have at most 6 options.', 'error');
        target.options.push(`Option ${String.fromCharCode(65 + target.options.length)}`);
        renderEditorQuestions();
      });
      row.querySelector('.remove-option').addEventListener('click', () => {
        captureEditor();
        const target = editingSet.questions[index];
        if (target.options.length <= 2) return notice($('editorMessage'), 'A question must have at least 2 options.', 'error');
        target.options.pop();
        if (target.correctIndex >= target.options.length) target.correctIndex = 0;
        renderEditorQuestions();
      });
      row.querySelector('.remove-question').addEventListener('click', () => {
        if (editingSet.questions.length <= 1) return notice($('editorMessage'), 'A set must contain at least one question.', 'error');
        captureEditor();
        editingSet.questions.splice(index, 1);
        renderEditorQuestions();
      });
      container.appendChild(row);
    });
  }

  function captureEditor() {
    if (!editingSet) return;
    const rows = [...$('questionEditor').children];
    editingSet.name = $('editorSetName').value.trim() || editingSet.name;
    editingSet.questions = rows.map((row, index) => ({
      ...editingSet.questions[index],
      question: row.querySelector('.question-text').value.trim(),
      options: [...row.querySelectorAll('.option-text')].map(input => input.value.trim()).filter(Boolean),
      correctIndex: Number(row.querySelector('.correct-answer').value),
      explanation: row.querySelector('.explanation').value.trim(),
      subject: row.querySelector('.subject').value.trim(),
      topic: row.querySelector('.topic').value.trim(),
      category: row.querySelector('.topic').value.trim(),
      difficulty: row.querySelector('.difficulty').value,
      marks: Number(row.querySelector('.marks').value || 1),
      imageUrl: row.querySelector('.image-url').value.trim(),
      timeSeconds: Number(row.querySelector('.question-time').value || 0)
    }));
  }

  async function saveEditingSet() {
    captureEditor();
    $('saveSet').disabled = true;
    try {
      const updated = await api(`/api/admin/sets/${editingSet.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editingSet.name, description: editingSet.description, questions: editingSet.questions })
      });
      editingSet = JSON.parse(JSON.stringify(updated));
      notice($('editorMessage'), 'Changes saved.', 'success');
      await loadSets();
    } catch (error) {
      notice($('editorMessage'), error.message, 'error');
    } finally {
      $('saveSet').disabled = false;
    }
  }

  function addQuestion() {
    captureEditor();
    editingSet.questions.push({
      id: `new_${Date.now()}`,
      question: 'New question',
      options: ['Option A', 'Option B', 'Option C', 'Option D'],
      correctIndex: 0,
      explanation: '',
      subject: '',
      topic: '',
      category: '',
      difficulty: 'Medium',
      marks: 1,
      imageUrl: '',
      timeSeconds: 0
    });
    renderEditorQuestions();
    $('questionEditor').lastElementChild?.scrollIntoView({ behavior: 'smooth' });
  }

  async function deleteSet(setId, name) {
    if (!confirm(`Delete "${name}"? Existing sessions will remain available.`)) return;
    await api(`/api/admin/sets/${setId}`, { method: 'DELETE' });
    await loadSets();
  }

  async function importQuestions(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = new FormData(form);
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const imported = await api('/api/admin/sets/import', { method: 'POST', body });
      notice($('importMessage'), `Imported ${imported.questions.length} questions into "${imported.name}".`, 'success');
      form.reset();
      await loadSets();
    } catch (error) {
      notice($('importMessage'), error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function loadChats() {
    chats = await api('/api/admin/chats');
    refreshCreateOptions();
  }

  function refreshCreateOptions() {
    const currentSet = $('sessionSet').value;
    $('sessionSet').innerHTML = sets.map(set => `<option value="${set.id}">${escapeHtml(set.name)} (${set.questions.length})</option>`).join('');
    if (sets.some(set => set.id === currentSet)) $('sessionSet').value = currentSet;
    const currentChat = $('sessionChat').value;
    $('sessionChat').innerHTML = '<option value="">No group selected</option>' + chats.map(chat => `<option value="${chat.id}">${escapeHtml(chat.title)}</option>`).join('');
    if (chats.some(chat => chat.id === currentChat)) $('sessionChat').value = currentChat;
    syncQuestionCount();
  }

  function syncQuestionCount() {
    const set = sets.find(item => item.id === $('sessionSet').value);
    if (!set) return;
    $('questionCount').max = String(set.questions.length);
    if (Number($('questionCount').value) > set.questions.length) $('questionCount').value = set.questions.length;
    if (!$('sessionTitle').value.trim()) $('sessionTitle').value = set.name;
  }

  async function createSession() {
    if (!sets.length) return notice($('createMessage'), 'Import a question set first.', 'error');
    $('createSession').disabled = true;
    try {
      createdSession = await api('/api/admin/sessions', {
        method: 'POST',
        body: JSON.stringify({
          setId: $('sessionSet').value,
          title: $('sessionTitle').value.trim(),
          questionCount: Number($('questionCount').value),
          timerSeconds: Number($('timerSeconds').value),
          scoringMode: $('scoringMode').value,
          chatId: $('sessionChat').value,
          shuffleQuestions: $('shuffleQuestions').checked,
          shuffleAnswers: $('shuffleAnswers').checked
        })
      });
      $('createdSessionCard').classList.remove('hidden');
      $('createdCode').textContent = createdSession.code;
      $('createdQuestions').textContent = createdSession.questionCount;
      $('createdStatus').textContent = 'Lobby';
      notice($('createMessage'), `Lobby ${createdSession.code} is ready.`, 'success');
      await loadSessions();
    } catch (error) {
      notice($('createMessage'), error.message, 'error');
    } finally {
      $('createSession').disabled = false;
    }
  }

  async function announceSession(sessionId, chatId = '') {
    try {
      await api(`/api/admin/sessions/${sessionId}/announce`, { method: 'POST', body: JSON.stringify({ chatId }) });
      alert('The join button was posted in your Telegram group.');
      await loadSessions();
    } catch (error) {
      alert(error.message);
    }
  }

  async function startSession(sessionId) {
    if (!confirm('Start the quiz in 3 seconds? Players should already be in the lobby.')) return;
    try {
      await api(`/api/admin/sessions/${sessionId}/start`, { method: 'POST', body: JSON.stringify({ delaySeconds: 3 }) });
      if (createdSession?.id === sessionId) $('createdStatus').textContent = 'Live';
      await loadSessions();
      activateTab('sessions');
    } catch (error) {
      alert(error.message);
    }
  }

  async function finishSession(sessionId) {
    if (!confirm('End this quiz now and post final results?')) return;
    try {
      await api(`/api/admin/sessions/${sessionId}/finish`, { method: 'POST' });
      await loadSessions();
    } catch (error) {
      alert(error.message);
    }
  }

  async function loadSessions() {
    sessions = await api('/api/admin/sessions');
    renderSessions();
  }

  function renderSessions() {
    const container = $('sessionsList');
    container.innerHTML = '';
    sessions.forEach(session => {
      const item = document.createElement('div');
      item.className = 'list-item';
      const badgeClass = session.status === 'live' ? 'live' : session.status === 'finished' ? 'finished' : '';
      item.innerHTML = `
        <div class="list-head">
          <div><strong></strong><div class="small muted">Code ${session.code} • ${session.questionCount} questions • ${session.participantCount} players</div></div>
          <span class="badge ${badgeClass}">${session.status.toUpperCase()}</span>
        </div>
        <div class="actions" style="margin-top:11px"></div>
        <div class="mini-leaders leaderboard" style="margin-top:10px"></div>`;
      item.querySelector('strong').textContent = session.title;
      const actions = item.querySelector('.actions');
      if (session.status === 'lobby') {
        const announce = button('Announce', 'btn small-btn', () => announceSession(session.id, session.chatId));
        const start = button('Start', 'btn small-btn success', () => startSession(session.id));
        actions.append(announce, start);
      }
      if (session.status === 'live') actions.append(button('Finish now', 'btn small-btn danger', () => finishSession(session.id)));
      if (session.status === 'finished') {
        const download = document.createElement('a');
        download.className = 'btn small-btn';
        download.textContent = 'Download CSV';
        download.href = `/api/admin/sessions/${session.id}/results.csv`;
        actions.append(download);
      }
      const leaders = item.querySelector('.mini-leaders');
      session.leaderboard.slice(0, 3).forEach((row, index) => {
        const line = document.createElement('div');
        line.className = 'leader-row';
        line.innerHTML = `<div class="rank">${['🥇','🥈','🥉'][index]}</div><div></div><div class="score">${row.score}</div>`;
        line.children[1].textContent = row.name;
        leaders.appendChild(line);
      });
      container.appendChild(item);
    });
    if (!sessions.length) container.innerHTML = '<div class="notice">No quiz sessions have been created yet.</div>';
  }

  function button(text, className, handler) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = className;
    el.textContent = text;
    el.addEventListener('click', handler);
    return el;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[ch]));
  }

  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));
  document.querySelectorAll('.go-tab').forEach(button => button.addEventListener('click', () => activateTab(button.dataset.target)));
  $('loginButton').addEventListener('click', login);
  $('adminPassword').addEventListener('keydown', event => { if (event.key === 'Enter') login(); });
  $('logoutButton').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }); location.reload(); });
  $('importForm').addEventListener('submit', importQuestions);
  $('refreshSets').addEventListener('click', loadSets);
  $('closeEditor').addEventListener('click', () => $('editorCard').classList.add('hidden'));
  $('saveSet').addEventListener('click', saveEditingSet);
  $('addQuestion').addEventListener('click', addQuestion);
  $('sessionSet').addEventListener('change', () => { $('sessionTitle').value = sets.find(set => set.id === $('sessionSet').value)?.name || ''; syncQuestionCount(); });
  $('createSession').addEventListener('click', createSession);
  $('announceCreated').addEventListener('click', () => createdSession && announceSession(createdSession.id, $('sessionChat').value || createdSession.chatId));
  $('startCreated').addEventListener('click', () => createdSession && startSession(createdSession.id));
  $('refreshSessions').addEventListener('click', loadSessions);

  openAdmin();
})();
