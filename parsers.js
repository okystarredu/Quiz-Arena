const path = require('path');
const { parse } = require('csv-parse/sync');
const mammoth = require('mammoth');

function cleanText(value) {
  return String(value ?? '').replace(/\r/g, '').trim();
}

function normaliseQuestion(raw, index) {
  const question = cleanText(raw.question || raw.Question || raw.text || raw.Text);
  let options = raw.options;
  if (!Array.isArray(options)) {
    options = [
      raw.OptionA ?? raw.optionA ?? raw.A,
      raw.OptionB ?? raw.optionB ?? raw.B,
      raw.OptionC ?? raw.optionC ?? raw.C,
      raw.OptionD ?? raw.optionD ?? raw.D,
      raw.OptionE ?? raw.optionE ?? raw.E,
      raw.OptionF ?? raw.optionF ?? raw.F
    ].map(cleanText).filter(Boolean);
  } else {
    options = options.map(cleanText).filter(Boolean);
  }

  let correct = raw.correctIndex ?? raw.correct ?? raw.CorrectAnswer ?? raw.answer ?? raw.Answer;
  if (typeof correct === 'string') {
    const letter = correct.trim().toUpperCase();
    if (/^[A-F]$/.test(letter)) correct = letter.charCodeAt(0) - 65;
    else if (/^\d+$/.test(letter)) correct = Number(letter) - 1;
    else correct = options.findIndex(option => option.toLowerCase() === letter.toLowerCase());
  }
  correct = Number(correct);

  if (!question) throw new Error(`Question ${index + 1} has no question text.`);
  if (options.length < 2 || options.length > 6) throw new Error(`Question ${index + 1} must have 2 to 6 options.`);
  if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) {
    throw new Error(`Question ${index + 1} has an invalid correct answer.`);
  }

  const suppliedTime = Number(raw.timeSeconds || raw.TimeSeconds || raw.time || raw.Time || 0);

  return {
    id: `q_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
    question,
    options,
    correctIndex: correct,
    explanation: cleanText(raw.explanation || raw.Explanation),
    category: cleanText(raw.category || raw.Category),
    difficulty: cleanText(raw.difficulty || raw.Difficulty || 'Medium'),
    timeSeconds: suppliedTime > 0 ? Math.max(5, Math.min(300, suppliedTime)) : 0
  };
}

function parseCsv(buffer) {
  const records = parse(buffer.toString('utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  });
  return records.map(normaliseQuestion);
}

function parsePlainText(text) {
  const blocks = cleanText(text).split(/\n\s*\n(?=\s*(?:\d+[.)]\s+|Question\s*:))/i).filter(Boolean);
  const questions = [];
  for (const block of blocks) {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const raw = { options: [] };
    const first = lines.shift().replace(/^\d+[.)]\s*/, '');
    raw.question = first.replace(/^Question\s*:\s*/i, '');
    for (const line of lines) {
      const option = line.match(/^([A-F])[.)]\s*(.+)$/i);
      if (option) {
        raw.options.push(option[2].trim());
        continue;
      }
      const answer = line.match(/^(?:Answer|Correct Answer)\s*:\s*(.+)$/i);
      if (answer) { raw.answer = answer[1].trim(); continue; }
      const explanation = line.match(/^Explanation\s*:\s*(.+)$/i);
      if (explanation) { raw.explanation = explanation[1].trim(); continue; }
      const time = line.match(/^Time(?:Seconds)?\s*:\s*(\d+)/i);
      if (time) { raw.timeSeconds = Number(time[1]); continue; }
      const category = line.match(/^Category\s*:\s*(.+)$/i);
      if (category) { raw.category = category[1].trim(); continue; }
      if (raw.explanation) raw.explanation += ` ${line}`;
    }
    questions.push(normaliseQuestion(raw, questions.length));
  }
  return questions;
}

async function parseQuestionFile(file) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  if (extension === '.csv') return parseCsv(file.buffer);
  if (extension === '.txt') return parsePlainText(file.buffer.toString('utf8'));
  if (extension === '.json') {
    const parsed = JSON.parse(file.buffer.toString('utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.questions;
    if (!Array.isArray(list)) throw new Error('JSON must be an array or contain a questions array.');
    return list.map(normaliseQuestion);
  }
  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return parsePlainText(result.value);
  }
  throw new Error('Unsupported file. Use CSV, TXT, DOCX or JSON.');
}

module.exports = { parseQuestionFile, parsePlainText, parseCsv, normaliseQuestion };
