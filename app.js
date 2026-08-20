const POOL_CAP = 250;
const SHALLOW_QUESTION_CAP = 150; // categories with data only to ~250 get asked from a smaller range, to keep guesses further from the edge of what we can score accurately
const MAX_MISS = 100; // miss points cap per question (also used for "not found" guesses); lower total = better
const MISS_GOOD_MAX = 10; // miss <= this = "good" (green)
const MISS_MID_MAX = 40;  // miss <= this = "mid" (amber); above = "bad" (red)

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
  currentSuggestionPool: [],
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
  suggestList: document.getElementById('suggestList'),
  resultCard: document.getElementById('resultCard'),
  resultHeadline: document.getElementById('resultHeadline'),
  resultDetail: document.getElementById('resultDetail'),
  meterFill: document.getElementById('meterFill'),
  meterMarker: document.getElementById('meterMarker'),
  nearbyList: document.getElementById('nearbyList'),
  progressFill: document.getElementById('progressFill'),
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
    group.className = `sport-group ${sport.toLowerCase()}`;
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
      const maxRank = Math.max(...getQuestionPool(cat).map(p => p.rank));
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

// Questions only ever ask about ranks <= POOL_CAP (getPool), but some categories now carry
// far deeper data than that (e.g. NBA categories sourced from NBA.com go thousands deep).
// Use the full list for matching a *guess* so a near-boundary guess (e.g. asked about 230th,
// guessed someone who's actually 260th) gets scored on real distance instead of an automatic
// "not found" max-miss just because 260 is outside the askable range.
function getMatchPool(cat) {
  return cat.leaders;
}

// "Deep" = we have real ranked data past the usual top-250 cutoff (currently the 9 NBA
// categories sourced from NBA.com's full all-time grid). Everything else only has data to
// ~250, so we ask from a smaller range (SHALLOW_QUESTION_CAP) to stay further from the edge
// where an out-of-pool guess can't be scored on real distance.
function isDeepCategory(cat) {
  return cat.leaders.some(p => p.rank > POOL_CAP);
}

function getQuestionPool(cat) {
  const cap = isDeepCategory(cat) ? POOL_CAP : SHALLOW_QUESTION_CAP;
  return cat.leaders.filter(p => p.rank > 1 && p.rank <= cap); // rank 1 is too well-known to be a fun question
}

function getRanks(pool) {
  return [...new Set(pool.map(p => p.rank))].sort((a, b) => a - b);
}

function getSuggestionNames(cat) {
  const catNames = getPool(cat).map(p => p.name);
  const roster = state.rosters[cat.sport] || [];
  return [...new Set([...catNames, ...roster])];
}

function startGame() {
  const catPool = state.categories.filter(c => state.selected.has(c.key));
  state.questions = [];
  for (let i = 0; i < state.rounds; i++) {
    const cat = catPool[Math.floor(Math.random() * catPool.length)];
    const ranks = getRanks(getQuestionPool(cat));
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
  el.progressLabel.innerHTML = `Question <b>${state.currentIndex + 1}</b> of ${state.questions.length}`;
  el.scoreLabel.innerHTML = `Total miss <b>${state.score}</b>`;
  el.progressFill.style.width = `${(state.currentIndex / state.questions.length) * 100}%`;
  el.questionSport.textContent = `${cat.sport} — ${cat.category}`;
  el.questionText.textContent = `Who is the ${ordinal(rank)} most all-time in ${cat.category.toLowerCase()}?`;
  el.guessInput.value = '';
  state.currentSuggestionPool = getSuggestionNames(cat);
  hideSuggestions();
  el.resultCard.classList.add('hidden');
  el.guessForm.classList.remove('hidden');
  el.guessInput.focus();
}

el.guessForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const guess = el.guessInput.value.trim();
  if (!guess) return;
  hideSuggestions();
  submitGuess(guess);
});

// ---------- lightweight autocomplete (no native <datalist> — freezes mobile Safari with large lists) ----------

const SUGGEST_MAX = 8;

function hideSuggestions() {
  el.suggestList.classList.add('hidden');
  el.suggestList.innerHTML = '';
}

function showSuggestions(matches) {
  if (!matches.length) return hideSuggestions();
  el.suggestList.innerHTML = matches
    .map(name => `<div class="suggest-item" data-name="${escapeHtml(name)}">${escapeHtml(name)}</div>`)
    .join('');
  el.suggestList.classList.remove('hidden');
}

el.guessInput.addEventListener('input', () => {
  const norm = normalizeName(el.guessInput.value);
  if (!norm) return hideSuggestions();

  const starts = [];
  const contains = [];
  for (const name of state.currentSuggestionPool) {
    const normName = normalizeName(name);
    if (normName.startsWith(norm)) starts.push(name);
    else if (normName.includes(norm)) contains.push(name);
    if (starts.length >= SUGGEST_MAX) break;
  }
  const matches = [...starts, ...contains].slice(0, SUGGEST_MAX);
  showSuggestions(matches);
});

el.suggestList.addEventListener('mousedown', (e) => {
  const item = e.target.closest('.suggest-item');
  if (!item) return;
  e.preventDefault(); // keep focus in the input instead of blurring to the list
  el.guessInput.value = item.dataset.name;
  hideSuggestions();
  el.guessInput.focus();
});

el.guessInput.addEventListener('blur', () => {
  setTimeout(hideSuggestions, 150); // let a suggestion click/mousedown register first
});

el.guessInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideSuggestions();
});

function submitGuess(guess) {
  const { cat, rank } = state.questions[state.currentIndex];
  const pool = getPool(cat);
  const targets = pool.filter(p => p.rank === rank);
  const matched = matchPlayer(guess, getMatchPool(cat));

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

  renderResult({ cat, rank, targets, guess, matched, diff, points, pool, matchPoolSize: getMatchPool(cat).length });
}

function renderResult({ cat, rank, targets, guess, matched, diff, points, pool, matchPoolSize }) {
  el.scoreLabel.innerHTML = `Total miss <b>${state.score}</b>`;
  el.guessForm.classList.add('hidden');
  el.resultCard.classList.remove('hidden');

  let bucket = 'bad';
  if (points <= MISS_GOOD_MAX) bucket = 'good';
  else if (points <= MISS_MID_MAX) bucket = 'mid';
  const bucketColor = `var(--${bucket})`;

  el.resultHeadline.className = `result-headline ${bucket}`;
  let verdict;
  if (!matched) {
    verdict = matchPoolSize > pool.length
      ? `"${guess}" doesn't match any recorded ${cat.sport} player`
      : `"${guess}" not found in the top ${pool.length}`;
  } else if (diff === 0) {
    verdict = 'Exact!';
  } else {
    verdict = `Off by ${diff} spot${diff === 1 ? '' : 's'}`;
  }
  el.resultHeadline.innerHTML = `<span>${escapeHtml(verdict)}</span><span class="miss-num">+${points}</span>`;

  const targetNames = targets.map(t => t.name).join(' / ');
  const targetValueStr = targets.length ? `${formatValue(targets[0].value)} ${cat.unit}` : '';
  let detail = `The ${ordinal(rank)} most is <b>${escapeHtml(targetNames)}</b> (${escapeHtml(targetValueStr)}).`;
  if (matched && matched.rank !== rank) {
    detail += ` Your guess, <b>${escapeHtml(matched.name)}</b>, ranks ${ordinal(matched.rank)}.`;
  } else if (matched && matched.rank === rank) {
    detail += ` You nailed it.`;
  }
  el.resultDetail.innerHTML = detail;

  const meterPct = (points / MAX_MISS) * 100; // points is already capped at MAX_MISS, so this never exceeds 100
  el.meterFill.style.width = `${meterPct}%`;
  el.meterFill.style.background = bucketColor;
  el.meterMarker.style.left = `${meterPct}%`;
  el.meterMarker.style.background = bucketColor;

  el.nearbyList.innerHTML = '';
  const maxRank = Math.max(...pool.map(p => p.rank));
  const lo = Math.max(1, rank - 3);
  const hi = Math.min(maxRank, rank + 3);
  const nearby = pool
    .filter(p => p.rank >= lo && p.rank <= hi)
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

  const makeRow = (p, { isTarget = false, isGuess = false } = {}) => {
    const row = document.createElement('div');
    const classes = ['nearby-row'];
    if (isTarget) classes.push('target');
    if (isGuess) classes.push('guessed');
    row.className = classes.join(' ');
    if (isGuess) row.style.setProperty('--guess-color', bucketColor);
    const tag = isGuess ? '<span class="guess-tag">YOUR GUESS</span>' : '';
    row.innerHTML = `<span class="rank">#${p.rank}</span><span class="name">${escapeHtml(p.name)}${tag}</span><span class="value">${escapeHtml(formatValue(p.value))}</span>`;
    return row;
  };

  const guessAbove = matched && matched.rank < lo;
  const guessBelow = matched && matched.rank > hi;

  if (guessAbove) {
    el.nearbyList.appendChild(makeRow(matched, { isGuess: true }));
    const divider = document.createElement('div');
    divider.className = 'nearby-divider';
    divider.textContent = 'closer to the top';
    el.nearbyList.appendChild(divider);
  }

  for (const p of nearby) {
    el.nearbyList.appendChild(makeRow(p, {
      isTarget: p.rank === rank,
      isGuess: matched && p.rank === matched.rank,
    }));
  }

  if (guessBelow) {
    const divider = document.createElement('div');
    divider.className = 'nearby-divider';
    divider.textContent = 'further down';
    el.nearbyList.appendChild(divider);
    el.nearbyList.appendChild(makeRow(matched, { isGuess: true }));
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
