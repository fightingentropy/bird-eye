const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const BIRD_COMMAND = process.env.BIRD_COMMAND || 'bird';
const TWEET_COUNT = 200;
const TWEET_COUNT_FALLBACK = 102;
const REQUEST_TIMEOUT_MS = 60000;
const CODEX_TIMEOUT_MS = 60000;
const DEFAULT_LIST = '1933193197817135501';
const COMMAND_DISPLAY = `bird list-timeline ${DEFAULT_LIST} -n ${TWEET_COUNT} --json`;
const cacheByCommand = new Map();
const TWEET_CACHE_MS = 60 * 60 * 1000;
const TWEET_CACHE_MAX_ENTRIES = 30;
const summaryCacheByKey = new Map();
const SUMMARY_CACHE_MS = 60 * 60 * 1000;
const SUMMARY_CACHE_MAX_ENTRIES = 120;
const PRICE_CACHE_MS = 10000;
const PRICE_TIMEOUT_MS = 8000;
const PRICE_SYMBOLS = ['BTC', 'ETH', 'HYPE'];
let lastPricePayload = null;
let lastPriceFetchedAt = 0;
const DEFAULT_CODEX_MODEL = 'gpt-5.2-codex';
const DEFAULT_CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';

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

async function refreshBirdQueryIds() {
  const process = Bun.spawn([BIRD_COMMAND, 'query-ids'], {
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
    const message = stderr && stderr.trim() ? stderr.trim() : `bird query-ids exited with code ${exitCode}`;
    throw new Error(message);
  }
  return stdout;
}

function parseCommand(rawCommand) {
  if (!rawCommand) {
    return {
      args: ['list-timeline', DEFAULT_LIST, '-n', String(TWEET_COUNT), '--json'],
      display: COMMAND_DISPLAY,
      requestedCount: TWEET_COUNT
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
  let requestedCount = TWEET_COUNT;
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
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 200) {
        return { error: 'Count must be an integer between 1 and 200.' };
      }
      requestedCount = parsed;
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
  args.push('-n', String(requestedCount), '--json');

  if (command === 'list-timeline') {
    return {
      args,
      display: `bird list-timeline ${listTarget} -n ${requestedCount} --json`,
      requestedCount
    };
  }

  return {
    args,
    display: `bird home${useFollowing ? ' --following' : ''} -n ${requestedCount} --json`,
    requestedCount
  };
}

async function fetchTweets(commandArgs) {
  const args = commandArgs || ['home', '-n', String(TWEET_COUNT), '--json'];
  let stdout;
  try {
    stdout = await withTimeout(runBird(args), REQUEST_TIMEOUT_MS, 'bird request timed out.');
  } catch (error) {
    const message = error && error.message ? error.message : '';
    if (message.includes('Query: Unspecified') || message.includes('Dependency: Unspecified')) {
      await withTimeout(
        refreshBirdQueryIds(),
        REQUEST_TIMEOUT_MS,
        'bird query-ids request timed out.'
      );
      stdout = await withTimeout(runBird(args), REQUEST_TIMEOUT_MS, 'bird request timed out.');
    } else {
      throw error;
    }
  }

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

function pruneCacheMap(map, getTimestamp, maxAgeMs, maxEntries) {
  const now = Date.now();
  for (const [key, value] of map.entries()) {
    const ts = getTimestamp(value);
    if (!Number.isInteger(ts) || now - ts > maxAgeMs) {
      map.delete(key);
    }
  }

  if (map.size <= maxEntries) {
    return;
  }

  const oldestFirst = Array.from(map.entries()).sort(
    (a, b) => getTimestamp(a[1]) - getTimestamp(b[1])
  );
  const overflow = map.size - maxEntries;
  for (let i = 0; i < overflow; i += 1) {
    map.delete(oldestFirst[i][0]);
  }
}

function pruneTweetCache() {
  pruneCacheMap(
    cacheByCommand,
    (entry) => (entry && typeof entry.cachedAt === 'number' ? entry.cachedAt : 0),
    TWEET_CACHE_MS,
    TWEET_CACHE_MAX_ENTRIES
  );
}

function getTweetCacheEntry(cacheKey) {
  pruneTweetCache();
  const entry = cacheByCommand.get(cacheKey);
  if (!entry || typeof entry.cachedAt !== 'number') {
    return null;
  }
  return entry;
}

function setTweetCacheEntry(cacheKey, payload) {
  const entry = { ...payload, cachedAt: Date.now() };
  cacheByCommand.set(cacheKey, entry);
  pruneTweetCache();
  return cacheByCommand.get(cacheKey) || entry;
}

function argsWithCount(args, count) {
  const out = [...args];
  const idx = out.indexOf('-n');
  if (idx !== -1 && out[idx + 1] !== undefined) {
    out[idx + 1] = String(count);
  }
  return out;
}

async function getOrFetchTweetPayload(commandResult, { forceRefresh = false } = {}) {
  const cacheKey = commandResult.display;
  if (!forceRefresh) {
    const cached = getTweetCacheEntry(cacheKey);
    if (cached) {
      return cached;
    }
  }

  let raw;
  let countOverride =
    typeof commandResult.requestedCount === 'number'
      ? commandResult.requestedCount
      : TWEET_COUNT;
  try {
    raw = await fetchTweets(commandResult.args);
  } catch (err) {
    if (countOverride === TWEET_COUNT && TWEET_COUNT !== TWEET_COUNT_FALLBACK) {
      const fallbackArgs = argsWithCount(commandResult.args, TWEET_COUNT_FALLBACK);
      raw = await fetchTweets(fallbackArgs);
      countOverride = TWEET_COUNT_FALLBACK;
    } else {
      throw err;
    }
  }
  const display =
    countOverride === TWEET_COUNT_FALLBACK &&
    (commandResult.requestedCount === TWEET_COUNT || commandResult.requestedCount == null)
      ? commandResult.display.replace(`-n ${TWEET_COUNT}`, `-n ${TWEET_COUNT_FALLBACK}`)
      : commandResult.display;
  const payload = buildPayload(raw, display, countOverride);
  return setTweetCacheEntry(cacheKey, payload);
}

function pruneSummaryCache() {
  pruneCacheMap(
    summaryCacheByKey,
    (entry) => (entry && typeof entry.cachedAt === 'number' ? entry.cachedAt : 0),
    SUMMARY_CACHE_MS,
    SUMMARY_CACHE_MAX_ENTRIES
  );
}

function getSummaryCacheEntry(cacheKey) {
  if (!cacheKey) {
    return null;
  }
  pruneSummaryCache();
  const entry = summaryCacheByKey.get(cacheKey);
  return entry && entry.payload ? entry.payload : null;
}

function setSummaryCacheEntry(cacheKey, payload) {
  if (!cacheKey || !payload) {
    return;
  }
  summaryCacheByKey.set(cacheKey, {
    payload,
    cachedAt: Date.now()
  });
  pruneSummaryCache();
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

function readCodexToken() {
  const authFile =
    process.env.CODEX_AUTH_FILE || path.join(os.homedir(), '.codex', 'auth.json');
  let raw;
  try {
    raw = fs.readFileSync(authFile, 'utf8');
  } catch (error) {
    throw new Error(
      `Codex auth file not found. Expected at ${authFile}. Run "codex login" first.`
    );
  }
  const auth = JSON.parse(raw);
  const token = auth.access_token || (auth.tokens && auth.tokens.access_token);
  if (!token) {
    throw new Error('Codex auth file missing access_token.');
  }
  return token;
}

function buildSummaryPrompt(tweets) {
  const list = tweets
    .map((tweet, index) => {
      const author =
        tweet && tweet.author && tweet.author.username ? `@${tweet.author.username}` : 'unknown';
      const text = tweet && tweet.text ? tweet.text.replace(/\s+/g, ' ').trim() : '';
      return `${index + 1}. (${author}) ${text}`;
    })
    .join('\n');

  return `
Summarize the 102 tweets into a financial/trading brief.
Ignore off-topic content (memes, pure jokes, unrelated politics).
Focus on market headlines, important news, sentiment, positioning, and trade-relevant themes.
Output ONLY plain text in this exact format:

Title: <short title>
Overall: <1-2 sentence market summary>
Topics:
- <topic> | <count> | <short summary (<=18 words)> | idx: <comma-separated tweet numbers>
- <topic> | <count> | <short summary (<=18 words)>
- <topic> | <count> | <short summary (<=18 words)>
- <topic> | <count> | <short summary (<=18 words)>

Use 4-7 topics. Counts should add up to the number of included financial tweets.
Exclude non-financial tweets from counts. Use 1-based tweet numbers. Be concise and specific.

Tweets:
${list}
`.trim();
}

function buildChatPrompt(tweets, question) {
  const list = tweets
    .map((tweet, index) => {
      const author =
        tweet && tweet.author && tweet.author.username ? `@${tweet.author.username}` : 'unknown';
      const text = tweet && tweet.text ? tweet.text.replace(/\s+/g, ' ').trim() : '';
      return `${index + 1}. (${author}) ${text}`;
    })
    .join('\n');

  return `
You are answering a question about the 102 tweets below.
Be concise and specific. If you reference a tweet, include its number (e.g., "#12").
If the tweets do not contain enough information, say so clearly.

Question: ${question}

Tweets:
${list}
`.trim();
}

function extractCodexText(payload) {
  if (!payload) {
    return '';
  }
  if (typeof payload === 'string') {
    return payload;
  }
  if (typeof payload.output_text === 'string') {
    return payload.output_text;
  }
  if (Array.isArray(payload.output)) {
    const parts = [];
    payload.output.forEach((item) => {
      if (item && item.type === 'message' && Array.isArray(item.content)) {
        item.content.forEach((contentItem) => {
          if (!contentItem) {
            return;
          }
          if (contentItem.type === 'output_text' || contentItem.type === 'text') {
            if (typeof contentItem.text === 'string') {
              parts.push(contentItem.text);
            }
          }
        });
      }
    });
    if (parts.length > 0) {
      return parts.join('\n');
    }
  }
  if (
    payload.choices &&
    payload.choices[0] &&
    payload.choices[0].message &&
    typeof payload.choices[0].message.content === 'string'
  ) {
    return payload.choices[0].message.content;
  }
  return '';
}

function parseSummaryFromText(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const trimmed = text.trim();
  let jsonText = trimmed;
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonText = trimmed.slice(firstBrace, lastBrace + 1);
  }

  const tryParse = (value) => {
    try {
      return JSON.parse(value);
    } catch (error) {
      return null;
    }
  };

  let parsed = tryParse(jsonText);
  if (!parsed) {
    const repaired = jsonText.replace(/,\s*([}\]])/g, '$1');
    parsed = tryParse(repaired);
  }

  if (parsed && typeof parsed === 'object') {
    return parsed;
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const summary = {
    title: 'Topic Summary',
    overallSummary: '',
    topics: []
  };

  lines.forEach((line) => {
    if (line.toLowerCase().startsWith('title:')) {
      summary.title = line.slice(6).trim() || summary.title;
      return;
    }
    if (line.toLowerCase().startsWith('overall:')) {
      summary.overallSummary = line.slice(8).trim();
      return;
    }
    if (line.startsWith('- ')) {
      const content = line.slice(2).trim();
      const parts = content.split('|').map((part) => part.trim());
      if (parts.length >= 3) {
        const countValue = Number.parseInt(parts[1], 10);
        let summaryText = parts.slice(2).join(' | ') || '';
        let indices = [];
        const idxMatch = summaryText.match(/idx:\s*([0-9,\s]+)/i);
        if (idxMatch) {
          indices = idxMatch[1]
            .split(',')
            .map((value) => Number.parseInt(value.trim(), 10))
            .filter((value) => Number.isInteger(value) && value > 0)
            .map((value) => value - 1);
          summaryText = summaryText.replace(/idx:\s*[0-9,\s]+/i, '').trim();
          summaryText = summaryText.replace(/\|\s*$/g, '').trim();
        }
        summary.topics.push({
          topic: parts[0] || 'Topic',
          count: Number.isNaN(countValue) ? 0 : countValue,
          summary: summaryText,
          indices
        });
      }
    }
  });

  if (!summary.overallSummary && lines.length) {
    summary.overallSummary = lines[0];
  }

  return summary.topics.length || summary.overallSummary ? summary : null;
}

function extractJsonObjectText(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const start = text.indexOf('{');
  if (start === -1) {
    return null;
  }

  let braceCount = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) {
        escaped = true;
      }
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === '{') {
      braceCount += 1;
    } else if (ch === '}') {
      braceCount -= 1;
      if (braceCount === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function extractCodexTextFromStream(raw) {
  if (!raw || typeof raw !== 'string') {
    return '';
  }

  let output = '';
  let index = 0;
  while (index < raw.length) {
    const dataIndex = raw.indexOf('data:', index);
    if (dataIndex === -1) {
      break;
    }
    let cursor = dataIndex + 5;
    while (cursor < raw.length && /\s/.test(raw[cursor])) {
      cursor += 1;
    }
    if (raw[cursor] !== '{') {
      index = cursor + 1;
      continue;
    }

    let braceCount = 0;
    let inString = false;
    let escaped = false;
    let end = cursor;
    for (; end < raw.length; end += 1) {
      const ch = raw[end];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        if (inString) {
          escaped = true;
        }
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (ch === '{') {
        braceCount += 1;
      } else if (ch === '}') {
        braceCount -= 1;
        if (braceCount === 0) {
          end += 1;
          break;
        }
      }
    }

    const jsonText = raw.slice(cursor, end).trim();
    if (jsonText) {
      try {
        const payload = JSON.parse(jsonText);
        const delta =
          payload &&
          payload.type === 'response.output_text.delta' &&
          typeof payload.delta === 'string'
            ? payload.delta
            : '';
        if (delta) {
          output += delta;
        }
      } catch (error) {
        // ignore malformed stream chunks
      }
    }

    index = end;
  }

  return output.trim();
}

async function requestCodexText(prompt) {
  const token = readCodexToken();
  const url = process.env.CODEX_URL || DEFAULT_CODEX_URL;
  const model = process.env.CODEX_MODEL || DEFAULT_CODEX_MODEL;

  const response = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        model,
        instructions: '',
        stream: true,
        store: false,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: prompt }]
          }
        ]
      })
    }),
    CODEX_TIMEOUT_MS,
    'Codex request timed out.'
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Codex request failed (${response.status}). ${text || response.statusText}`);
  }

  const looksLikeStream = /\bevent:\s*\w+|\bdata:\s*\{/.test(text);
  let parsedPayload;
  if (!looksLikeStream) {
    try {
      parsedPayload = JSON.parse(text);
    } catch (error) {
      parsedPayload = text;
    }
  }

  const outputText = looksLikeStream
    ? extractCodexTextFromStream(text)
    : extractCodexText(parsedPayload);

  if (!outputText) {
    throw new Error('Codex response contained no text.');
  }

  return outputText;
}

async function requestCodexSummary(tweets) {
  if (!Array.isArray(tweets) || tweets.length === 0) {
    throw new Error('No tweets available to summarize.');
  }

  const prompt = buildSummaryPrompt(tweets.slice(0, 350));
  const outputText = await requestCodexText(prompt);

  let summary = parseSummaryFromText(outputText);
  if (!summary) {
    const extracted = extractJsonObjectText(outputText);
    summary = extracted ? parseSummaryFromText(extracted) : null;
  }
  if (!summary) {
    const repairPrompt = `
Reformat the text below into this exact format (plain text only) and keep the financial/trading focus:

Title: <short title>
Overall: <1-2 sentence market summary>
Topics:
- <topic> | <count> | <short summary (<=18 words)>
- <topic> | <count> | <short summary (<=18 words)>
- <topic> | <count> | <short summary (<=18 words)>
- <topic> | <count> | <short summary (<=18 words)>

Use 4-7 topics. Counts should add up to the number of included financial tweets. No extra lines.

Text to fix:
${outputText}
`.trim();
    const repairedText = await requestCodexText(repairPrompt);
    summary = parseSummaryFromText(repairedText);
  }
  if (!summary) {
    throw new Error('Codex response was not valid JSON.');
  }

  return summary;
}

async function requestCodexChat(question, tweets) {
  if (!question) {
    throw new Error('No question provided.');
  }
  if (!Array.isArray(tweets) || tweets.length === 0) {
    throw new Error('No tweets available to answer.');
  }
  const prompt = buildChatPrompt(tweets.slice(0, 350), question);
  const outputText = await requestCodexText(prompt);
  const answer = typeof outputText === 'string' ? outputText.trim() : '';
  if (!answer) {
    throw new Error('Codex response contained no text.');
  }
  return answer;
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
  idleTimeout: 60,
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

        const responsePayload = await getOrFetchTweetPayload(commandResult, {
          forceRefresh: shouldRefresh
        });
        if (!responsePayload) {
          return jsonResponse(buildPayload([], commandResult.display, 0));
        }
        const { cachedAt, ...safePayload } = responsePayload;
        return jsonResponse(safePayload);
      } catch (error) {
        return jsonResponse(
          { error: error && error.message ? error.message : 'Failed to fetch tweets.' },
          500
        );
      }
    }

    if (url.pathname === '/api/tweet-summary') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed.' }, 405);
      }

      try {
        let body = {};
        try {
          body = await request.json();
        } catch (error) {
          body = {};
        }

        const cacheKey = typeof body.key === 'string' && body.key.trim() ? body.key.trim() : null;
        const cachedSummary = getSummaryCacheEntry(cacheKey);
        if (cachedSummary) {
          return jsonResponse(cachedSummary);
        }

        const commandParam = typeof body.cmd === 'string' ? body.cmd : null;
        const commandResult = parseCommand(commandParam);
        if (commandResult.error) {
          return jsonResponse({ error: commandResult.error }, 400);
        }
        const tweetPayload = await getOrFetchTweetPayload(commandResult);
        const tweets = tweetPayload && Array.isArray(tweetPayload.tweets) ? tweetPayload.tweets : [];

        const summary = await requestCodexSummary(tweets);
        const payload = {
          summary,
          fetchedAt: new Date().toISOString(),
          count: Array.isArray(tweets) ? tweets.length : 0
        };
        setSummaryCacheEntry(cacheKey, payload);
        return jsonResponse(payload);
      } catch (error) {
        return jsonResponse(
          {
            error: error && error.message ? error.message : 'Failed to summarize tweets.'
          },
          500
        );
      }
    }

    if (url.pathname === '/api/tweet-chat') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed.' }, 405);
      }

      try {
        let body = {};
        try {
          body = await request.json();
        } catch (error) {
          body = {};
        }

        const question =
          typeof body.question === 'string' && body.question.trim()
            ? body.question.trim()
            : '';
        const commandParam = typeof body.cmd === 'string' ? body.cmd : null;
        const commandResult = parseCommand(commandParam);
        if (commandResult.error) {
          return jsonResponse({ error: commandResult.error }, 400);
        }
        const tweetPayload = await getOrFetchTweetPayload(commandResult);
        const tweets = tweetPayload && Array.isArray(tweetPayload.tweets) ? tweetPayload.tweets : [];

        const answer = await requestCodexChat(question, tweets);
        return jsonResponse({
          answer,
          fetchedAt: new Date().toISOString(),
          count: Array.isArray(tweets) ? tweets.length : 0
        });
      } catch (error) {
        return jsonResponse(
          {
            error: error && error.message ? error.message : 'Failed to answer question.'
          },
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
