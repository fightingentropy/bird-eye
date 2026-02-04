const tweetsEl = document.querySelector('[data-tweets]');
const refreshButton = document.querySelector('[data-refresh]');
const statusEl = document.querySelector('[data-status]');
const metaEl = document.querySelector('[data-meta]');
const errorEl = document.querySelector('[data-error]');
const commandEl = document.querySelector('[data-command]');
const commandInput = document.querySelector('[data-command-input]');
const commandHelp = document.querySelector('[data-command-help]');
const applyButton = document.querySelector('[data-apply]');
const sortSelect = document.querySelector('[data-sort]');
const countSelect = document.querySelector('[data-count]');
const searchInput = document.querySelector('[data-search]');
const priceUpdatedEl = document.querySelector('[data-price-updated]');
const summaryButton = document.querySelector('[data-summary-refresh]');
const summaryUpdatedEl = document.querySelector('[data-summary-updated]');
const summaryListEl = document.querySelector('[data-summary-list]');
const summaryLeadEl = document.querySelector('[data-summary-lead]');
const summaryStatusEl = document.querySelector('[data-summary-status]');
const summaryTitleEl = document.querySelector('[data-summary-title]');
const chatInputEl = document.querySelector('[data-chat-input]');
const chatAskButton = document.querySelector('[data-chat-ask]');
const chatAnswerEl = document.querySelector('[data-chat-answer]');
const chatStatusEl = document.querySelector('[data-chat-status]');
const priceEls = {
  BTC: document.querySelector('[data-price="BTC"]'),
  ETH: document.querySelector('[data-price="ETH"]'),
  HYPE: document.querySelector('[data-price="HYPE"]')
};
const priceChangeEls = {
  BTC: document.querySelector('[data-change="BTC"]'),
  ETH: document.querySelector('[data-change="ETH"]'),
  HYPE: document.querySelector('[data-change="HYPE"]')
};

const DEFAULT_COMMAND = 'bird list-timeline 1933193197817135501 -n 100 --json';
const STORAGE_KEY = 'bird-dashboard-command';
const SORT_KEY = 'bird-dashboard-sort';
const COUNT_KEY = 'bird-dashboard-count';
const SEARCH_KEY = 'bird-dashboard-search';
const SUMMARY_CACHE_KEY = 'bird-dashboard-summary-cache';
const DEFAULT_COUNT = 100;
let activeCommand = DEFAULT_COMMAND;
let currentTweets = [];
let summaryInFlight = false;
let activeSummaryFilter = null;
let chatInFlight = false;
const LEGACY_COMMANDS = [
  'bird home --following -n 10 --json',
  'bird home -n 10 --json',
  'bird list-timeline 1933193197817135501 -n 10 --json'
];

const numberFormat = new Intl.NumberFormat(undefined, { notation: 'compact' });
const BINANCE_STREAM_URL =
  'wss://fstream.binance.com/stream?streams=btcusdt@ticker/ethusdt@ticker/hypeusdt@ticker';
const BINANCE_RECONNECT_MS = 3000;

function setStatus(message) {
  if (!statusEl) {
    return;
  }

  statusEl.textContent = message;
}

function setMeta(message) {
  if (!metaEl) {
    return;
  }

  metaEl.textContent = message;
}

function setCommand(message) {
  if (!commandEl) {
    return;
  }

  commandEl.textContent = message ? `Command: ${message}` : 'Command: --';
}

function setError(message) {
  if (!errorEl) {
    return;
  }

  if (!message) {
    errorEl.hidden = true;
    errorEl.textContent = '';
    return;
  }

  errorEl.hidden = false;
  errorEl.textContent = message;
}

function setCommandHelp(message, isError = false) {
  if (!commandHelp) {
    return;
  }

  commandHelp.textContent = message || '';
  commandHelp.style.color = isError ? '#f6c8b5' : '';
}

function setLoading(isLoading) {
  if (refreshButton) {
    refreshButton.disabled = isLoading;
    refreshButton.setAttribute('aria-busy', isLoading ? 'true' : 'false');
  }
  document.body.classList.toggle('is-loading', isLoading);
  if (applyButton) {
    applyButton.disabled = isLoading;
  }
}

function formatTime(iso) {
  if (!iso) {
    return 'Unknown time';
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }

  return date.toLocaleString();
}

function formatCount(value) {
  if (typeof value !== 'number') {
    return '0';
  }

  return numberFormat.format(value);
}

function formatPrice(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '$--';
  }

  let decimals = 2;
  if (value < 1) {
    decimals = 4;
  } else if (value < 10) {
    decimals = 3;
  }

  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })}`;
}

function setPriceUpdated(message) {
  if (!priceUpdatedEl) {
    return;
  }

  priceUpdatedEl.textContent = message;
}

function setSummaryUpdated(message) {
  if (!summaryUpdatedEl) {
    return;
  }

  summaryUpdatedEl.textContent = message || '';
}

function setSummaryStatus(message) {
  if (!summaryStatusEl) {
    return;
  }

  summaryStatusEl.textContent = message || '';
}

function setChatStatus(message) {
  if (!chatStatusEl) {
    return;
  }
  chatStatusEl.textContent = message || '';
}

function setChatLoading(isLoading) {
  if (!chatAskButton) {
    return;
  }
  chatAskButton.disabled = isLoading;
  chatAskButton.setAttribute('aria-busy', isLoading ? 'true' : 'false');
}

function setChatAnswer(message) {
  if (!chatAnswerEl) {
    return;
  }
  chatAnswerEl.textContent = message || '';
}

function setSummaryLoading(isLoading) {
  if (!summaryButton) {
    return;
  }

  summaryButton.disabled = isLoading;
  summaryButton.setAttribute('aria-busy', isLoading ? 'true' : 'false');
}

function clearSummaryList() {
  if (!summaryListEl) {
    return;
  }

  summaryListEl.innerHTML = '';
}

function renderSummary(summary) {
  if (!summaryListEl) {
    return;
  }

  clearSummaryList();

  if (summaryTitleEl && summary && summary.title) {
    summaryTitleEl.textContent = summary.title;
  }

  if (summaryLeadEl) {
    summaryLeadEl.textContent = '';
  }

  const topics = summary && Array.isArray(summary.topics) ? summary.topics : [];
  if (topics.length === 0) {
    return;
  }

  activeSummaryFilter = null;

  topics.forEach((topic, index) => {
    const item = document.createElement('div');
    item.className = 'summary-item';
    item.dataset.summaryIndex = String(index);

    const header = document.createElement('div');
    header.className = 'summary-topic';

    const name = document.createElement('span');
    name.textContent = topic && topic.topic ? topic.topic : 'Topic';

    const count = document.createElement('span');
    count.className = 'summary-count';
    count.textContent =
      topic && typeof topic.count === 'number' ? `${topic.count} tweets` : '--';

    header.appendChild(name);
    header.appendChild(count);

    const text = document.createElement('p');
    text.className = 'summary-text';
    text.textContent =
      topic && topic.summary ? topic.summary : 'Summary unavailable for this topic.';

    item.appendChild(header);
    item.appendChild(text);

    item.addEventListener('click', () => {
      const isActive = activeSummaryFilter && activeSummaryFilter.index === index;
      activeSummaryFilter = isActive
        ? null
        : {
            index,
            topic: topic && topic.topic ? topic.topic : '',
            summary: topic && topic.summary ? topic.summary : '',
            indices: Array.isArray(topic && topic.indices) ? topic.indices : []
          };
      updateSummarySelection();
      renderWithSort();
    });

    summaryListEl.appendChild(item);
  });

  updateSummarySelection();
}

function updatePriceLabel(symbol, value) {
  const el = priceEls[symbol];
  if (!el) {
    return;
  }

  el.textContent = formatPrice(value);
}

function updatePriceChange(symbol, change) {
  const el = priceChangeEls[symbol];
  if (!el) {
    return;
  }

  if (typeof change !== 'number' || Number.isNaN(change)) {
    el.textContent = '--';
    el.classList.remove('is-up', 'is-down');
    return;
  }

  const sign = change > 0 ? '+' : '';
  el.textContent = `${sign}${change.toFixed(2)}%`;
  el.classList.toggle('is-up', change > 0);
  el.classList.toggle('is-down', change < 0);
}

function startBinancePriceStream() {
  if (!priceUpdatedEl || typeof WebSocket === 'undefined') {
    return;
  }

  let socket;
  let reconnectTimer;

  const connect = () => {
    clearTimeout(reconnectTimer);
    socket = new WebSocket(BINANCE_STREAM_URL);

    socket.addEventListener('open', () => {
      setPriceUpdated('Updated just now');
    });

    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data);
        const data = payload && payload.data ? payload.data : payload;
        const symbol = data && data.s ? data.s.toUpperCase() : '';
        const priceValue = data && data.c ? Number.parseFloat(data.c) : NaN;
        const percentChange = data && data.P ? Number.parseFloat(data.P) : NaN;

        if (symbol === 'BTCUSDT') {
          updatePriceLabel('BTC', priceValue);
          updatePriceChange('BTC', percentChange);
          setPriceUpdated(`Updated ${new Date().toLocaleTimeString()}`);
        } else if (symbol === 'ETHUSDT') {
          updatePriceLabel('ETH', priceValue);
          updatePriceChange('ETH', percentChange);
          setPriceUpdated(`Updated ${new Date().toLocaleTimeString()}`);
        } else if (symbol === 'HYPEUSDT') {
          updatePriceLabel('HYPE', priceValue);
          updatePriceChange('HYPE', percentChange);
          setPriceUpdated(`Updated ${new Date().toLocaleTimeString()}`);
        }
      } catch (error) {
        setPriceUpdated('Price stream error');
      }
    });

    socket.addEventListener('close', () => {
      setPriceUpdated('Reconnecting...');
      reconnectTimer = setTimeout(connect, BINANCE_RECONNECT_MS);
    });

    socket.addEventListener('error', () => {
      setPriceUpdated('Price stream error');
      socket.close();
    });
  };

  connect();
}

function updateSummarySelection() {
  if (!summaryListEl) {
    return;
  }

  Array.from(summaryListEl.children).forEach((child) => {
    if (!child || !child.classList) {
      return;
    }
    const index = Number.parseInt(child.dataset.summaryIndex, 10);
    const isActive = activeSummaryFilter && activeSummaryFilter.index === index;
    child.classList.toggle('is-active', Boolean(isActive));
  });
}

function buildTopicKeywords(filter) {
  if (!filter) {
    return [];
  }
  const combined = `${filter.topic || ''} ${filter.summary || ''}`.toLowerCase();
  return combined
    .split(/[^a-z0-9]+/g)
    .map((word) => word.trim())
    .filter((word) => word.length > 2);
}

function filterTweetsBySummary(tweets) {
  if (!activeSummaryFilter) {
    return tweets;
  }
  if (Array.isArray(activeSummaryFilter.indices) && activeSummaryFilter.indices.length > 0) {
    return tweets.filter((_, index) => activeSummaryFilter.indices.includes(index));
  }
  const keywords = buildTopicKeywords(activeSummaryFilter);
  if (keywords.length === 0) {
    return tweets;
  }
  return tweets.filter((tweet) => {
    const text = tweet && tweet.text ? tweet.text.toLowerCase() : '';
    return keywords.some((keyword) => text.includes(keyword));
  });
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function buildSummaryKey(tweets) {
  const basis = tweets
    .map((tweet, index) => {
      const id = tweet && tweet.id ? tweet.id : String(index);
      const createdAt = tweet && tweet.createdAt ? tweet.createdAt : '';
      const text = tweet && tweet.text ? tweet.text.slice(0, 32) : '';
      return `${id}:${createdAt}:${text}`;
    })
    .join('|');
  return `v1:${hashString(basis)}`;
}

function loadSummaryCache() {
  try {
    const raw = localStorage.getItem(SUMMARY_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    return {};
  }
}

function saveSummaryCache(nextCache) {
  try {
    localStorage.setItem(SUMMARY_CACHE_KEY, JSON.stringify(nextCache));
  } catch (error) {
    // ignore storage errors
  }
}

function storeSummaryInCache(key, summary) {
  if (!key || !summary) {
    return;
  }
  const cache = loadSummaryCache();
  cache[key] = {
    summary,
    storedAt: Date.now()
  };
  saveSummaryCache(cache);
}

function getSummaryFromCache(key) {
  if (!key) {
    return null;
  }
  const cache = loadSummaryCache();
  return cache && cache[key] ? cache[key].summary : null;
}

async function getSummaryTweets() {
  if (!Array.isArray(currentTweets) || currentTweets.length === 0) {
    throw new Error('No tweets are loaded yet.');
  }
  if (currentTweets.length < 100) {
    throw new Error('Load 100 tweets in the feed before summarizing.');
  }
  return currentTweets.slice(0, 100);
}

async function getChatTweets() {
  if (!Array.isArray(currentTweets) || currentTweets.length === 0) {
    throw new Error('No tweets are loaded yet.');
  }
  if (currentTweets.length < 100) {
    throw new Error('Load 100 tweets in the feed before asking questions.');
  }
  return currentTweets.slice(0, 100);
}

async function fetchSummary({ silent = false } = {}) {
  if (summaryInFlight) {
    return;
  }

  summaryInFlight = true;
  if (!silent) {
    setSummaryStatus('Summarizing 100 latest tweets...');
  }
  setSummaryLoading(true);

  try {
    const tweets = await getSummaryTweets();
    const key = buildSummaryKey(tweets);
    const response = await fetch('/api/tweet-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tweets, key })
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload && payload.error ? payload.error : 'Summary request failed.');
    }

    renderSummary(payload.summary);
    storeSummaryInCache(key, payload.summary);
    const fetchedAt = payload.fetchedAt ? new Date(payload.fetchedAt) : new Date();
    setSummaryUpdated(`Updated ${fetchedAt.toLocaleTimeString()}`);
    setSummaryStatus(`Summarized ${payload.count || tweets.length || 0} tweets.`);
  } catch (error) {
    clearSummaryList();
    if (summaryLeadEl) {
      summaryLeadEl.textContent = 'Summary failed. Try again.';
    }
    setSummaryStatus(error && error.message ? error.message : 'Summary failed.');
  } finally {
    setSummaryLoading(false);
    summaryInFlight = false;
  }
}

async function askChatQuestion(question) {
  if (chatInFlight) {
    return;
  }
  const trimmed = question ? question.trim() : '';
  if (!trimmed) {
    setChatStatus('Enter a question to ask Codex.');
    return;
  }

  chatInFlight = true;
  setChatLoading(true);
  setChatStatus('Asking Codex about the latest tweets...');

  try {
    const tweets = await getChatTweets();
    const response = await fetch('/api/tweet-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: trimmed, tweets })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload && payload.error ? payload.error : 'Chat request failed.');
    }
    setChatAnswer(payload.answer || 'No answer returned.');
    setChatStatus('Answered.');
  } catch (error) {
    setChatAnswer('Answer failed. Try again.');
    setChatStatus(error && error.message ? error.message : 'Chat failed.');
  } finally {
    setChatLoading(false);
    chatInFlight = false;
  }
}

function clearTweets() {
  if (!tweetsEl) {
    return;
  }

  tweetsEl.innerHTML = '';
}

function createMetric(label, value) {
  const metric = document.createElement('div');
  metric.className = 'tweet-metric';
  metric.textContent = `${label} ${formatCount(value)}`;
  return metric;
}

function renderTweets(tweets, emptyMessage = 'No tweets found in the feed.') {
  if (!tweetsEl) {
    return;
  }

  clearTweets();

  if (!tweets || tweets.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = emptyMessage;
    tweetsEl.appendChild(empty);
    return;
  }

  tweets.forEach((tweet, index) => {
    const card = document.createElement('article');
    card.className = 'tweet-card';
    card.style.setProperty('--delay', `${index * 0.05}s`);

    const header = document.createElement('div');
    header.className = 'tweet-header';

    const author = document.createElement('div');
    author.className = 'tweet-author';

    const name = document.createElement('div');
    name.className = 'tweet-name';
    name.textContent =
      tweet.author && tweet.author.name ? tweet.author.name : 'Unknown author';

    const handle = document.createElement('div');
    handle.className = 'tweet-handle';
    if (tweet.author && tweet.author.username) {
      handle.textContent = `@${tweet.author.username}`;
    }

    author.appendChild(name);
    if (handle.textContent) {
      author.appendChild(handle);
    }

    const time = document.createElement('div');
    time.className = 'tweet-time';
    time.textContent = formatTime(tweet.createdAt);

    header.appendChild(author);
    header.appendChild(time);

    const text = document.createElement('p');
    text.className = 'tweet-text';
    text.textContent = tweet.text || 'No text available.';

    const footer = document.createElement('div');
    footer.className = 'tweet-footer';

    const metrics = document.createElement('div');
    metrics.className = 'tweet-metrics';
    metrics.appendChild(
      createMetric('Replies', tweet.metrics ? tweet.metrics.replyCount : 0)
    );
    metrics.appendChild(
      createMetric('Retweets', tweet.metrics ? tweet.metrics.retweetCount : 0)
    );
    metrics.appendChild(createMetric('Likes', tweet.metrics ? tweet.metrics.likeCount : 0));

    footer.appendChild(metrics);

    if (tweet.url) {
      const link = document.createElement('a');
      link.className = 'tweet-link';
      link.href = tweet.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'View on X';
      footer.appendChild(link);
    }

    card.appendChild(header);
    card.appendChild(text);
    card.appendChild(footer);

    tweetsEl.appendChild(card);
  });
}

function sortTweets(tweets, mode) {
  if (!Array.isArray(tweets)) {
    return [];
  }

  if (mode === 'likes') {
    return [...tweets].sort((a, b) => {
      const aLikes = a && a.metrics && typeof a.metrics.likeCount === 'number' ? a.metrics.likeCount : 0;
      const bLikes = b && b.metrics && typeof b.metrics.likeCount === 'number' ? b.metrics.likeCount : 0;
      return bLikes - aLikes;
    });
  }

  return tweets;
}

function getCountFromCommand(command) {
  if (!command) {
    return null;
  }

  const match = command.match(/(?:^|\s)(?:-n|--count)\s+(\d+)/);
  if (!match) {
    return null;
  }

  const count = Number.parseInt(match[1], 10);
  return Number.isNaN(count) ? null : count;
}

function ensureCountOption(count) {
  if (!countSelect) {
    return;
  }

  const value = String(count);
  const hasOption = Array.from(countSelect.options).some((option) => option.value === value);
  if (!hasOption) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    countSelect.appendChild(option);
  }
}

function setCountOnCommand(command, count) {
  if (!command || !count) {
    return command;
  }

  const nextCount = Math.max(1, Math.min(100, count));
  if (/(?:-n|--count)\s+\d+/.test(command)) {
    return command.replace(/(?:-n|--count)\s+\d+/, `-n ${nextCount}`);
  }

  if (/\s--json/.test(command)) {
    return command.replace(/\s--json/, ` -n ${nextCount} --json`);
  }

  return `${command} -n ${nextCount}`;
}

function syncCountSelect(command) {
  if (!countSelect) {
    return;
  }

  const count = getCountFromCommand(command);
  if (!count) {
    return;
  }

  ensureCountOption(count);
  countSelect.value = String(count);
}

function applyCountSelection(count, { shouldFetch } = { shouldFetch: true }) {
  if (!Number.isInteger(count)) {
    return;
  }

  const nextCommand = setCountOnCommand(activeCommand, count);
  if (nextCommand) {
    activeCommand = nextCommand;
    localStorage.setItem(STORAGE_KEY, nextCommand);
    if (commandInput) {
      commandInput.value = nextCommand;
    }
  }

  localStorage.setItem(COUNT_KEY, String(count));
  syncCountSelect(activeCommand);

  if (shouldFetch) {
    fetchTweets({ refresh: true });
  }
}

function getSearchTerm() {
  if (!searchInput) {
    return '';
  }

  return searchInput.value.trim().toLowerCase();
}

function filterTweets(tweets, term) {
  if (!term) {
    return tweets;
  }

  return tweets.filter((tweet) => {
    const text = tweet && tweet.text ? tweet.text : '';
    const name = tweet && tweet.author && tweet.author.name ? tweet.author.name : '';
    const username = tweet && tweet.author && tweet.author.username ? tweet.author.username : '';
    return `${text} ${name} ${username}`.toLowerCase().includes(term);
  });
}

function renderWithSort() {
  if (!sortSelect || sortSelect.value === 'latest') {
    const summaryFiltered = filterTweetsBySummary(currentTweets);
    const filtered = filterTweets(summaryFiltered, getSearchTerm());
    const emptyMessage = activeSummaryFilter
      ? 'No tweets match this topic.'
      : getSearchTerm()
      ? 'No tweets match your search.'
      : undefined;
    renderTweets(filtered, emptyMessage);
    return;
  }

  const sorted = [...currentTweets].sort((a, b) => {
    const aLikes = a && a.metrics && typeof a.metrics.likeCount === 'number' ? a.metrics.likeCount : 0;
    const bLikes = b && b.metrics && typeof b.metrics.likeCount === 'number' ? b.metrics.likeCount : 0;
    return bLikes - aLikes;
  });
  const summaryFiltered = filterTweetsBySummary(sorted);
  const filtered = filterTweets(summaryFiltered, getSearchTerm());
  const emptyMessage = activeSummaryFilter
    ? 'No tweets match this topic.'
    : getSearchTerm()
    ? 'No tweets match your search.'
    : undefined;
  renderTweets(filtered, emptyMessage);
}

async function fetchTweets(options = {}) {
  setError('');
  setLoading(true);
  setStatus('Fetching latest tweets...');

  try {
    const params = new URLSearchParams();
    if (options.refresh) {
      params.set('refresh', '1');
    }
    if (activeCommand) {
      params.set('cmd', activeCommand);
    }
    const queryString = params.toString();
    const response = await fetch(`/api/tweets${queryString ? `?${queryString}` : ''}`, {
      cache: 'no-store'
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload && payload.error ? payload.error : 'Request failed.');
    }

    currentTweets = payload.tweets || [];
    renderWithSort();
    if (Array.isArray(currentTweets) && currentTweets.length >= 100) {
      const summaryKey = buildSummaryKey(currentTweets.slice(0, 100));
      const cachedSummary = getSummaryFromCache(summaryKey);
      if (cachedSummary) {
        renderSummary(cachedSummary);
        setSummaryUpdated('Cached summary');
        setSummaryStatus('Loaded from cache.');
      }
    }

    const fetchedAt = payload.meta && payload.meta.fetchedAt ? new Date(payload.meta.fetchedAt) : new Date();
    const count =
      payload.meta && typeof payload.meta.count === 'number'
        ? payload.meta.count
        : payload.tweets
        ? payload.tweets.length
        : 0;
    const source = payload.meta && payload.meta.source ? payload.meta.source : 'home';
    const command = payload.meta && payload.meta.command ? payload.meta.command : '';

    setStatus(`Last updated ${fetchedAt.toLocaleTimeString()}.`);
    setMeta(`Showing ${count} tweets from ${source} feed.`);
    setCommand(command);
    if (command && commandInput) {
      activeCommand = command;
      commandInput.value = command;
      localStorage.setItem(STORAGE_KEY, command);
      setCommandHelp('Command applied.', false);
      syncCountSelect(command);
    }
  } catch (error) {
    setError(error && error.message ? error.message : 'Failed to fetch tweets.');
    setStatus('Fetch failed.');
    setMeta('Last updated: --');
    setCommand('');
    setCommandHelp('Command rejected. Check allowed flags.', true);
    currentTweets = [];
    renderWithSort();
  } finally {
    setLoading(false);
  }
}

function applyCommand() {
  if (!commandInput) {
    return;
  }

  const nextCommand = commandInput.value.trim() || DEFAULT_COMMAND;
  activeCommand = nextCommand;
  localStorage.setItem(STORAGE_KEY, nextCommand);
  const nextCount = getCountFromCommand(nextCommand);
  if (nextCount) {
    localStorage.setItem(COUNT_KEY, String(nextCount));
  }
  syncCountSelect(nextCommand);
  setCommandHelp('Applying command...', false);
  fetchTweets({ refresh: true });
}

if (refreshButton) {
  refreshButton.addEventListener('click', () => fetchTweets({ refresh: true }));
}
if (applyButton) {
  applyButton.addEventListener('click', applyCommand);
}
if (commandInput) {
  commandInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyCommand();
    }
  });
}

if (sortSelect) {
  sortSelect.addEventListener('change', () => {
    localStorage.setItem(SORT_KEY, sortSelect.value);
    renderWithSort();
  });
}

if (countSelect) {
  countSelect.addEventListener('change', () => {
    const nextCount = Number.parseInt(countSelect.value, 10);
    applyCountSelection(nextCount, { shouldFetch: true });
  });
}

if (searchInput) {
  searchInput.addEventListener('input', () => {
    localStorage.setItem(SEARCH_KEY, searchInput.value);
    renderWithSort();
  });
}

if (summaryButton) {
  summaryButton.addEventListener('click', () => fetchSummary());
}
if (chatAskButton) {
  chatAskButton.addEventListener('click', () => {
    askChatQuestion(chatInputEl ? chatInputEl.value : '');
  });
}
if (chatInputEl) {
  chatInputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      askChatQuestion(chatInputEl.value);
    }
  });
}

const storedCommand = localStorage.getItem(STORAGE_KEY);
let legacyCommandDetected = false;
if (storedCommand) {
  if (LEGACY_COMMANDS.includes(storedCommand)) {
    localStorage.setItem(STORAGE_KEY, DEFAULT_COMMAND);
    activeCommand = DEFAULT_COMMAND;
    legacyCommandDetected = true;
  } else {
    activeCommand = storedCommand;
  }
} else {
  localStorage.setItem(STORAGE_KEY, DEFAULT_COMMAND);
}
const storedCount = localStorage.getItem(COUNT_KEY);
let initialCount = storedCount ? Number.parseInt(storedCount, 10) : null;
if (legacyCommandDetected) {
  initialCount = DEFAULT_COUNT;
  localStorage.setItem(COUNT_KEY, String(DEFAULT_COUNT));
}
if (!Number.isInteger(initialCount)) {
  initialCount = getCountFromCommand(activeCommand) || DEFAULT_COUNT;
}
applyCountSelection(initialCount, { shouldFetch: false });
const storedSort = localStorage.getItem(SORT_KEY);
if (sortSelect && storedSort) {
  sortSelect.value = storedSort;
}
const storedSearch = localStorage.getItem(SEARCH_KEY);
if (searchInput && storedSearch) {
  searchInput.value = storedSearch;
}
if (commandInput) {
  commandInput.value = activeCommand;
}
if (tweetsEl) {
  fetchTweets();
}

if (priceUpdatedEl) {
  startBinancePriceStream();
}
