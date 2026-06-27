import { net } from 'electron';

const CACHE_TTL_MS = 50 * 60 * 1000;
const cache = new Map();

function cleanCache() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.ts > CACHE_TTL_MS) cache.delete(key);
  }
}

export async function handleStreamRequest(request, ytDlp) {
  try {
    const url = new URL(request.url);
    const encoded = url.pathname.replace(/^\/+/, '');
    if (!encoded) return new Response('Bad request', { status: 400 });

    const query = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!query.trim()) return new Response('Empty query', { status: 400 });

    let directUrl = null;
    const cached = cache.get(query);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      directUrl = cached.url;
    } else {
      cleanCache();
      try {
        directUrl = await ytDlp.getAudioStreamUrl(query);
      } catch (err) {
        console.error('[setengine-stream] resolve failed:', err.message);
        return new Response('Could not resolve audio: ' + err.message, { status: 502 });
      }
      if (!directUrl) {
        return new Response('No audio URL found', { status: 404 });
      }
      cache.set(query, { url: directUrl, ts: Date.now() });
    }

    const upstreamHeaders = {};
    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      upstreamHeaders['Range'] = rangeHeader;
    }

    const upstream = await net.fetch(directUrl, { headers: upstreamHeaders });

    const responseHeaders = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    const ct = upstream.headers.get('content-type');
    if (ct) responseHeaders['Content-Type'] = ct;
    const cl = upstream.headers.get('content-length');
    if (cl) responseHeaders['Content-Length'] = cl;
    const cr = upstream.headers.get('content-range');
    if (cr) responseHeaders['Content-Range'] = cr;

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error('[setengine-stream] Error:', err);
    return new Response('Stream error: ' + err.message, { status: 500 });
  }
}
