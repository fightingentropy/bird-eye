function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed.' }, 405);
  }

  if (!env || !env.BIRD_API_URL) {
    return jsonResponse(
      {
        error:
          'BIRD_API_URL is not configured. Set it to a backend that can execute bird commands.'
      },
      500
    );
  }

  try {
    const url = new URL(request.url);
    const upstream = new URL('/api/tweets', env.BIRD_API_URL);
    upstream.search = url.search;

    const response = await fetch(upstream.toString(), {
      headers: { Accept: 'application/json' }
    });
    const text = await response.text();

    return new Response(text, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    return jsonResponse(
      { error: error && error.message ? error.message : 'Failed to fetch tweets.' },
      500
    );
  }
}
