const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const BIRD_COMMAND = process.env.BIRD_COMMAND || 'bird';
const TWEET_COUNT = 10;
const REQUEST_TIMEOUT_MS = 20000;
const DEFAULT_LIST = '1933193197817135501';
const COMMAND_DISPLAY = `bird list-timeline ${DEFAULT_LIST} -n ${TWEET_COUNT} --json`;
const cacheByCommand = new Map();
const PRICE_CACHE_MS = 10000;
const PRICE_TIMEOUT_MS = 8000;
const PRICE_SYMBOLS = ['BTC', 'ETH', 'HYPE'];
let lastPricePayload = null;
let lastPriceFetchedAt = 0;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

async function runBird(args) {
  const process = Bun.spawn([BIRD_COMMAND, ...args], {
    stdout: 'pipe',
    stderr: 'pipe'
  });

  const stdoutPromise = new Response(process.stdout).text();
  const stderrPromise = new Response(process.stderr).text();

  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    stdoutPromise,
    stderrPromise
  ]);

  if (exitCode !== 0) {
    const message = stderr && stderr.trim() ? stderr.trim() : `bird exited with code ${exitCode}`;
    throw new Error(message);
  }

  return stdout;
}

function parseCommand(rawCommand) {
  if (!rawCommand) {
    return {
      args: ['list-timeline', DEFAULT_LIST, '-n', String(TWEET_COUNT), '--json'],
      display: COMMAND_DISPLAY
    };
  }

  const trimmed = rawCommand.trim();
  if (!trimmed.startsWith('bird ')) {
    return { error: 'Command must start with "bird ".' };
  }

  const parts = trimmed.split(/\s+/).slice(1);
  if (parts.length === 0) {
    return { error: 'Command is missing.' };
  }

  const command = parts[0];
  if (command !== 'home' && command !== 'list-timeline') {
    return { error: 'Only "bird home" and "bird list-timeline" are allowed here.' };
  }

  const args = [command];
  let count = TWEET_COUNT;
  let useFollowing = false;
  let listTarget = DEFAULT_LIST;

  if (command === 'list-timeline') {
    const target = parts[1];
    if (!target) {
      return { error: 'list-timeline requires a list ID or URL.' };
    }
    const match = target.match(/lists\/(\d+)/);
    listTarget = match ? match[1] : target;
    args.push(listTarget);
  }

  const startIndex = command === 'list-timeline' ? 2 : 1;

  for (let i = startIndex; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === '--following') {
      if (command !== 'home') {
        return { error: 'The --following flag is only valid for "bird home".' };
      }
      useFollowing = true;
      continue;
    }
    if (part === '-n' || part === '--count') {
      const value = parts[i + 1];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 50) {
        return { error: 'Count must be an integer between 1 and 50.' };
      }
      count = parsed;
      i += 1;
      continue;
    }
    if (part === '--json') {
      continue;
    }
    return { error: `Unsupported flag: ${part}` };
  }

  if (command === 'home') {
    if (useFollowing) {
      args.push('--following');
    }
  }
  args.push('-n', String(count), '--json');

  if (command === 'list-timeline') {
    return {
      args,
      display: `bird list-timeline ${listTarget} -n ${count} --json`
    };
  }

  return {
    args,
    display: `bird home${useFollowing ? ' --following' : ''} -n ${count} --json`
  };
}

async function fetchTweets(commandArgs) {
  const args = commandArgs || ['home', '-n', String(TWEET_COUNT), '--json'];
  const stdout = await withTimeout(
    runBird(args),
    REQUEST_TIMEOUT_MS,
    'bird request timed out.'
  );

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error('Failed to parse bird JSON output.');
  }
}

function buildPayload(raw, commandDisplay, countOverride) {
  const count = typeof countOverride === 'number' ? countOverride : TWEET_COUNT;
  const tweets = normalizeTweets(raw)
    .slice(0, count)
    .map(mapTweet);
  const isFollowing = commandDisplay && commandDisplay.includes('--following');
  const isList = commandDisplay && commandDisplay.includes('list-timeline');

  return {
    tweets,
    meta: {
      fetchedAt: new Date().toISOString(),
      count: tweets.length,
      source: isList ? 'list' : isFollowing ? 'following' : 'home',
      command: commandDisplay || COMMAND_DISPLAY
    }
  };
}

function normalizeTweets(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (data && Array.isArray(data.tweets)) {
    return data.tweets;
  }

  if (data && Array.isArray(data.items)) {
    return data.items;
  }

  return [];
}

function mapTweet(tweet) {
  const author = tweet.author || {};
  const username = author.username || '';
  const id = tweet.id || '';

  return {
    id,
    text: tweet.text || '',
    createdAt: tweet.createdAt || '',
    author: {
      username,
      name: author.name || ''
    },
    metrics: {
      replyCount: typeof tweet.replyCount === 'number' ? tweet.replyCount : 0,
      retweetCount: typeof tweet.retweetCount === 'number' ? tweet.retweetCount : 0,
      likeCount: typeof tweet.likeCount === 'number' ? tweet.likeCount : 0
    },
    url: username && id ? `https://x.com/${username}/status/${id}` : ''
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

async function fetchHyperliquidPrices() {
  const now = Date.now();
  if (lastPricePayload && now - lastPriceFetchedAt < PRICE_CACHE_MS) {
    return lastPricePayload;
  }

  const response = await withTimeout(
    fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'bird-eye/1.0'
      },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' })
    }),
    PRICE_TIMEOUT_MS,
    'Price request timed out.'
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Price request failed (${response.status}). ${text || response.statusText}`);
  }

  const payload = await response.json();
  const assetCtxs = Array.isArray(payload) ? payload[1] : [];
  const byCoin = new Map(
    Array.isArray(assetCtxs) ? assetCtxs.map((ctx) => [ctx.coin, ctx]) : []
  );
  const prices = {};

  PRICE_SYMBOLS.forEach((coin) => {
    const ctx = byCoin.get(coin);
    const value = ctx && ctx.markPx ? Number(ctx.markPx) : null;
    prices[coin] = Number.isFinite(value) ? value : null;
  });

  lastPricePayload = {
    fetchedAt: new Date().toISOString(),
    prices
  };
  lastPriceFetchedAt = now;
  return lastPricePayload;
}

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/api/tweets') {
      if (request.method !== 'GET') {
        return jsonResponse({ error: 'Method not allowed.' }, 405);
      }

      try {
        const shouldRefresh = url.searchParams.get('refresh') === '1';
        const commandParam = url.searchParams.get('cmd');
        const commandResult = parseCommand(commandParam);

        if (commandResult.error) {
          return jsonResponse({ error: commandResult.error }, 400);
        }

        const cacheKey = commandResult.display;

        if (!cacheByCommand.has(cacheKey) || shouldRefresh) {
          const raw = await fetchTweets(commandResult.args);
          const countArgIndex = commandResult.args.indexOf('-n');
          const countOverride =
            countArgIndex !== -1 ? Number(commandResult.args[countArgIndex + 1]) : TWEET_COUNT;
          const payload = buildPayload(raw, commandResult.display, countOverride);
          cacheByCommand.set(cacheKey, payload);
        }

        return jsonResponse(cacheByCommand.get(cacheKey));
      } catch (error) {
        return jsonResponse(
          { error: error && error.message ? error.message : 'Failed to fetch tweets.' },
          500
        );
      }
    }

    if (url.pathname === '/api/prices') {
      if (request.method !== 'GET') {
        return jsonResponse({ error: 'Method not allowed.' }, 405);
      }

      try {
        const payload = await fetchHyperliquidPrices();
        return jsonResponse(payload);
      } catch (error) {
        return jsonResponse(
          { error: error && error.message ? error.message : 'Failed to fetch prices.' },
          500
        );
      }
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed.', {
        status: 405,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    const rawPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const safePath = path
      .normalize(decodeURIComponent(rawPath))
      .replace(/^([.]{2}[\/])+/, '')
      .replace(/^[/\\]+/, '');
    const filePath = path.resolve(PUBLIC_DIR, safePath);

    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      return new Response('Forbidden.', {
        status: 403,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response('Not found.', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    const extension = path.extname(filePath);
    const contentType = MIME_TYPES[extension] || 'application/octet-stream';

    return new Response(file, {
      headers: { 'Content-Type': contentType }
    });
  }
});

console.log(`Bird dashboard running at http://localhost:${PORT}`);
