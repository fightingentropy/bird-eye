const COINS = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  HYPE: 'HYPEUSDT'
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

async function fetchTicker(symbol) {
  const url = `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`Binance price request failed (${response.status}).`);
  }
  return response.json();
}

export async function onRequest({ request }) {
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed.' }, 405);
  }

  try {
    const entries = await Promise.all(
      Object.entries(COINS).map(async ([coin, symbol]) => {
        const payload = await fetchTicker(symbol);
        return [coin, payload];
      })
    );

    const prices = {};
    const changes = {};

    entries.forEach(([coin, payload]) => {
      const priceValue = payload && payload.lastPrice ? Number(payload.lastPrice) : null;
      const changeValue = payload && payload.priceChangePercent ? Number(payload.priceChangePercent) : null;
      prices[coin] = Number.isFinite(priceValue) ? priceValue : null;
      changes[coin] = Number.isFinite(changeValue) ? changeValue : null;
    });

    return jsonResponse({
      fetchedAt: new Date().toISOString(),
      prices,
      changes
    });
  } catch (error) {
    return jsonResponse(
      { error: error && error.message ? error.message : 'Failed to fetch prices.' },
      500
    );
  }
}
