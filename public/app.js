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

const DEFAULT_COMMAND = 'bird list-timeline 1933193197817135501 -n 50 --json';
const STORAGE_KEY = 'bird-dashboard-command';
const SORT_KEY = 'bird-dashboard-sort';
const COUNT_KEY = 'bird-dashboard-count';
const SEARCH_KEY = 'bird-dashboard-search';
const DEFAULT_COUNT = 50;
let activeCommand = DEFAULT_COMMAND;
let currentTweets = [];
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

  const nextCount = Math.max(1, Math.min(50, count));
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
    const filtered = filterTweets(currentTweets, getSearchTerm());
    const emptyMessage = getSearchTerm() ? 'No tweets match your search.' : undefined;
    renderTweets(filtered, emptyMessage);
    return;
  }

  const sorted = [...currentTweets].sort((a, b) => {
    const aLikes = a && a.metrics && typeof a.metrics.likeCount === 'number' ? a.metrics.likeCount : 0;
    const bLikes = b && b.metrics && typeof b.metrics.likeCount === 'number' ? b.metrics.likeCount : 0;
    return bLikes - aLikes;
  });
  const filtered = filterTweets(sorted, getSearchTerm());
  const emptyMessage = getSearchTerm() ? 'No tweets match your search.' : undefined;
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
