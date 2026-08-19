const POOL_CAP = 250;
const MAX_MISS = 100; // miss points cap per question (also used for "not found" guesses); lower total = better

const ROSTER_FILES = {
  NFL: 'data/nfl_all_players.json',
  NBA: 'data/nba_all_players.json',
};

const state = {
  categories: [],   // { key, sport, category, unit, source, leaders: [{rank,name,value}] }
  rosters: {},       // { NFL: [name, ...], NBA: [name, ...] } — partial, may not cover every letter yet
  selected: new Set(),
  rounds: 10,
  questions: [],
  currentIndex: -1,
  score: 0,
  history: [],
};

const el = {
  sportGroups: document.getElementById('sportGroups'),
  selectAllBtn: document.getElementById('selectAllBtn'),
  selectNoneBtn: document.getElementById('selectNoneBtn'),
  roundsInput: document.getElementById('roundsInput'),
  startBtn: document.getElementById('startBtn'),
  setupError: document.getElementById('setupError'),
  setupScreen: document.getElementById('setup'),
  gameScreen: document.getElementById('game'),
  summaryScreen: document.getElementById('summary'),
  progressLabel: document.getElementById('progressLabel'),
  scoreLabel: document.getElementById('scoreLabel'),
  questionSport: document.getElementById('questionSport'),
  questionText: document.getElementById('questionText'),
  guessForm: document.getElementById('guessForm'),
  guessInput: document.getElementById('guessInput'),
  playerOptions: document.getElementById('playerOptions'),
  resultCard: document.getElementById('resultCard'),
  resultHeadline: document.getElementById('resultHeadline'),
  resultDetail: document.getElementById('resultDetail'),
  nearbyList: document.getElementById('nearbyList'),
  nextBtn: document.getElementById('nextBtn'),
  summaryScore: document.getElementById('summaryScore'),
  summaryHistory: document.getElementById('summaryHistory'),
  playAgainBtn: document.getElementById('playAgainBtn'),
};

init();

async function init() {
  try {
    const manifest = await fetchJSON('data/manifest.json');
    const loaded = await Promise.all(manifest.map(async (entry) => {
      const data = await fetchJSON('data/' + entry.file);
      return { key: entry.file, ...data };
    }));
    state.categories = loaded.filter(c => Array.isArray(c.leaders) && c.leaders.length > 0);
    renderSetup();
  } catch (err) {
    el.sportGroups.innerHTML = `<p class="error-text">Couldn't load category data: ${escapeHtml(err.message)}</p>`;
  }

  await Promise.all(Object.entries(ROSTER_FILES).map(async ([sport, path]) => {
    try {
      const data = await fetchJSON(path);
      state.rosters[sport] = data.players || [];
    } catch (err) {
      state.rosters[sport] = []; // roster file missing/partial is non-fatal — falls back to category-only suggestions
    }
  }));
}

function fetchJSON(path) {
  return fetch(path, { cache: 'no-store' }).then(r => {
    if (!r.ok) throw new Error(`${path} (${r.status})`);
    return r.json();
  });
}

function renderSetup() {
  const bySport = groupBy(state.categories, c => c.sport);
  el.sportGroups.innerHTML = '';
  for (const [sport, cats] of Object.entries(bySport)) {
    const group = document.createElement('div');
    group.className = 'sport-group';
    const heading = document.createElement('h3');
    heading.textContent = sport;
    group.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'category-grid';
    for (const cat of cats) {
      const label = document.createElement('label');
      label.className = 'category-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.key = cat.key;
      cb.addEventListener('change', onCategoryToggle);
      state.selected.add(cat.key);
      label.appendChild(cb);
      const span = document.createElement('span');
      span.textContent = cat.category;
      label.appendChild(span);
      const count = document.createElement('span');
      count.className = 'count';
      const maxRank = Math.max(...getPool(cat).map(p => p.rank));
      count.textContent = `top ${maxRank}`;
      label.appendChild(count);
      grid.appendChild(label);
    }
    group.appendChild(grid);
    el.sportGroups.appendChild(group);
  }
  updateStartEnabled();
}

function onCategoryToggle(e) {
  const key = e.target.dataset.key;
  if (e.target.checked) state.selected.add(key);
  else state.selected.delete(key);
  updateStartEnabled();
}

function updateStartEnabled() {
  el.startBtn.disabled = state.selected.size === 0;
}

el.selectAllBtn.addEventListener('click', () => {
  document.querySelectorAll('.category-check input').forEach(cb => {
    cb.checked = true;
    state.selected.add(cb.dataset.key);
  });
  updateStartEnabled();
});

el.selectNoneBtn.addEventListener('click', () => {
  document.querySelectorAll('.category-check input').forEach(cb => {
    cb.checked = false;
  });
  state.selected.clear();
  updateStartEnabled();
});

el.startBtn.addEventListener('click', () => {
  const rounds = parseInt(el.roundsInput.value, 10);
  if (!rounds || rounds < 1) {
    el.setupError.textContent = 'Enter a valid number of questions.';
    return;
  }
  el.setupError.textContent = '';
  state.rounds = rounds;
  startGame();
});

function getPool(cat) {
  return cat.leaders.filter(p => p.rank <= POOL_CAP);
}

function getRanks(pool) {
  return [...new Set(pool.map(p => p.rank))].sort((a, b) => a - b);
}

function getSuggestionNames(cat) {
  const roster = state.rosters[cat.sport] || [];
  const catNames = getPool(cat).map(p => p.name);
  return [...new Set([...roster, ...catNames])];
}

function startGame() {
  const catPool = state.categories.filter(c => state.selected.has(c.key));
  state.questions = [];
  for (let i = 0; i < state.rounds; i++) {
    const cat = catPool[Math.floor(Math.random() * catPool.length)];
    const ranks = getRanks(getPool(cat));
    const rank = ranks[Math.floor(Math.random() * ranks.length)];
    state.questions.push({ cat, rank });
  }
  state.currentIndex = -1;
  state.score = 0;
  state.history = [];
  el.setupScreen.classList.add('hidden');
  el.summaryScreen.classList.add('hidden');
  el.gameScreen.classList.remove('hidden');
  nextQuestion();
}

function nextQuestion() {
  state.currentIndex++;
  if (state.currentIndex >= state.questions.length) {
    showSummary();
    return;
  }
  const { cat, rank } = state.questions[state.currentIndex];
  el.progressLabel.textContent = `Question ${state.currentIndex + 1} of ${state.questions.length}`;
  el.scoreLabel.textContent = `Total miss: ${state.score} (lower is better)`;
  el.questionSport.textContent = `${cat.sport} — ${cat.category}`;
  el.questionText.textContent = `Who is the ${ordinal(rank)} most all-time in ${cat.category.toLowerCase()}?`;
  el.guessInput.value = '';
  el.playerOptions.innerHTML = shuffle(getSuggestionNames(cat))
    .map(name => `<option value="${escapeHtml(name)}">`)
    .join('');
  el.resultCard.classList.add('hidden');
  el.guessForm.classList.remove('hidden');
  el.guessInput.focus();
}

el.guessForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const guess = el.guessInput.value.trim();
  if (!guess) return;
  submitGuess(guess);
});

function submitGuess(guess) {
  const { cat, rank } = state.questions[state.currentIndex];
  const pool = getPool(cat);
  const targets = pool.filter(p => p.rank === rank);
  const matched = matchPlayer(guess, pool);

  let diff = null;
  let points;
  if (matched) {
    diff = Math.abs(matched.rank - rank);
    points = Math.min(MAX_MISS, diff);
  } else {
    points = MAX_MISS; // not found = worst-case miss
  }
  state.score += points;
  state.history.push({
    category: cat.category, sport: cat.sport, rank, targets, guess, matched, diff, points,
  });

  renderResult({ cat, rank, targets, guess, matched, diff, points, pool });
}

function renderResult({ cat, rank, targets, guess, matched, diff, points, pool }) {
  el.scoreLabel.textContent = `Total miss: ${state.score} (lower is better)`;
  el.guessForm.classList.add('hidden');
  el.resultCard.classList.remove('hidden');

  let bucket = 'bad';
  if (points <= 10) bucket = 'good';
  else if (points <= 40) bucket = 'mid';

  el.resultHeadline.className = `result-headline ${bucket}`;
  if (!matched) {
    el.resultHeadline.textContent = `"${guess}" not found in the top ${pool.length} — +${points} miss`;
  } else if (diff === 0) {
    el.resultHeadline.textContent = `Exact! +0 miss`;
  } else {
    el.resultHeadline.textContent = `Off by ${diff} spot${diff === 1 ? '' : 's'} — +${points} miss`;
  }

  const targetNames = targets.map(t => t.name).join(' / ');
  const targetValueStr = targets.length ? `${formatValue(targets[0].value)} ${cat.unit}` : '';
  let detail = `The ${ordinal(rank)} most is <b>${escapeHtml(targetNames)}</b> (${escapeHtml(targetValueStr)}).`;
  if (matched && matched.rank !== rank) {
    detail += ` Your guess, <b>${escapeHtml(matched.name)}</b>, ranks ${ordinal(matched.rank)}.`;
  } else if (matched && matched.rank === rank) {
    detail += ` You nailed it.`;
  }
  el.resultDetail.innerHTML = detail;

  el.nearbyList.innerHTML = '';
  const maxRank = Math.max(...pool.map(p => p.rank));
  const lo = Math.max(1, rank - 3);
  const hi = Math.min(maxRank, rank + 3);
  const nearby = pool
    .filter(p => p.rank >= lo && p.rank <= hi)
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  for (const p of nearby) {
    const li = document.createElement('li');
    const classes = [];
    if (p.rank === rank) classes.push('target');
    if (matched && p.rank === matched.rank) classes.push('guessed');
    li.className = classes.join(' ');
    li.innerHTML = `<span class="rank">#${p.rank}</span><span>${escapeHtml(p.name)}</span><span>${escapeHtml(formatValue(p.value))}</span>`;
    el.nearbyList.appendChild(li);
  }
  if (matched && (matched.rank < lo || matched.rank > hi)) {
    const li = document.createElement('li');
    li.className = 'guessed';
    li.innerHTML = `<span class="rank">#${matched.rank}</span><span>${escapeHtml(matched.name)}</span><span>${escapeHtml(formatValue(matched.value))}</span>`;
    el.nearbyList.appendChild(li);
  }
}

el.nextBtn.addEventListener('click', nextQuestion);

function showSummary() {
  el.gameScreen.classList.add('hidden');
  el.summaryScreen.classList.remove('hidden');
  const avg = state.score / state.history.length;
  el.summaryScore.textContent = `${state.score} total miss (avg ${avg.toFixed(1)} spots/question — lower is better)`;
  el.summaryHistory.innerHTML = '';
  state.history.forEach((h, i) => {
    const row = document.createElement('div');
    row.className = 'summary-row';
    const guessedName = h.matched ? h.matched.name : `"${h.guess}" (not found)`;
    const targetNames = h.targets.map(t => t.name).join(' / ');
    row.innerHTML = `<span>${i + 1}. ${escapeHtml(h.sport)} ${escapeHtml(h.category)} — ${ordinal(h.rank)}: <b>${escapeHtml(targetNames)}</b> · you said ${escapeHtml(guessedName)}</span><span class="pts">+${h.points}</span>`;
    el.summaryHistory.appendChild(row);
  });
}

el.playAgainBtn.addEventListener('click', () => {
  el.summaryScreen.classList.add('hidden');
  el.setupScreen.classList.remove('hidden');
});

// ---------- matching ----------

function normalizeName(str) {
  return str
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchPlayer(guess, pool) {
  const norm = normalizeName(guess);
  if (!norm) return null;

  const exact = pool.find(p => normalizeName(p.name) === norm);
  if (exact) return exact;

  const lastNameHits = pool.filter(p => {
    const tokens = normalizeName(p.name).split(' ');
    return tokens.includes(norm);
  });
  if (lastNameHits.length === 1) return lastNameHits[0];

  let best = null;
  let bestDist = Infinity;
  let secondBestDist = Infinity;
  for (const p of pool) {
    const d = levenshtein(norm, normalizeName(p.name));
    if (d < bestDist) {
      secondBestDist = bestDist;
      bestDist = d;
      best = p;
    } else if (d < secondBestDist) {
      secondBestDist = d;
    }
  }
  const threshold = Math.max(2, Math.floor(norm.length * 0.3));
  if (best && bestDist <= threshold && bestDist < secondBestDist) return best;
  return null;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

// ---------- helpers ----------

function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function formatValue(v) {
  return typeof v === 'number' ? v.toLocaleString('en-US') : v;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function groupBy(arr, fn) {
  return arr.reduce((acc, item) => {
    const k = fn(item);
    (acc[k] = acc[k] || []).push(item);
    return acc;
  }, {});
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
