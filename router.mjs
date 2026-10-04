import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
const webHome = process.env.CODEX_CHATGPT_WEB_HOME || join(homedir(), '.codex-chatgpt-web');
const routerHome = dirname(fileURLToPath(import.meta.url));
const nativeBaseUrl = 'https://chatgpt.com/backend-api/codex';
const hopHeaders = ['host', 'connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const summaryPrefix = 'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:';

export function nativeInput(payload) {
  const isWebItem = (item) => item?.encrypted_content?.startsWith('ocxr1:')
    || item?.encrypted_content?.startsWith('ocx1:')
    || (item?.type === 'reasoning' && /^rs_[0-9a-f]{32}$/i.test(item.id ?? '')
      && item.encrypted_content == null);
  if (!Array.isArray(payload?.input) || !payload.input.some(isWebItem)) return payload;
  const input = payload.input.flatMap((item) => {
    if (!item || typeof item !== 'object') return [item];
    const copy = { ...item };
    delete copy.id;
    if (copy.type === 'compaction' && copy.encrypted_content?.startsWith('ocx1:')) {
      const summary = Buffer.from(copy.encrypted_content.slice(5), 'base64').toString('utf8');
      return [{ type: 'message', role: 'user', content: [
        { type: 'input_text', text: `${summaryPrefix}\n\n${summary}` },
      ] }];
    }
    if (copy.type !== 'reasoning') return [copy];
    if (copy.encrypted_content?.startsWith('ocxr1:') || copy.encrypted_content === null) {
      delete copy.encrypted_content;
    }
    return copy.summary?.length || copy.content?.length || copy.encrypted_content ? [copy] : [];
  });
  const result = { ...payload, input };
  delete result.previous_response_id;
  return result;
}

export function webModels(home = codexHome, snapshotHome = routerHome) {
  for (const path of [join(home, 'models_cache.json'), join(snapshotHome, 'catalog-snapshot.json')]) {
    try {
      const models = JSON.parse(readFileSync(path, 'utf8')).models
        ?.filter((model) => model.slug?.startsWith('chatgpt-web/'));
      if (models?.length) return models;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  return [];
}

function webBaseUrl() {
  const config = JSON.parse(readFileSync(join(webHome, 'config.json'), 'utf8'));
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('Invalid Web GPT bridge port');
  }
  return `http://127.0.0.1:${config.port}/v1`;
}

export function createRouter({ port = 17842, nativeUrl = nativeBaseUrl,
  webUrl = webBaseUrl, catalog = webModels, request = fetch } = {}) {
  return Bun.serve({
    hostname: '127.0.0.1', port, idleTimeout: 0,
    async fetch(incoming) {
      const url = new URL(incoming.url);
      if (incoming.method === 'GET' && url.pathname === '/healthz') {
        return Response.json({ status: 'ok', service: 'codex-model-router' });
      }
      if (!url.pathname.startsWith('/v1/')) return new Response('Not found', { status: 404 });
      if (incoming.headers.get('upgrade')) return new Response('Use HTTP streaming', { status: 426 });
      if (!incoming.headers.get('authorization')?.startsWith('Bearer ')) {
        return Response.json({ error: { message: 'Codex authentication is required.' } }, { status: 401 });
      }

      let useWeb = false;
      try {
        const endpoint = url.pathname.slice(4);
        let body;
        let bodyChanged = false;
        if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
          body = await incoming.arrayBuffer();
          if (endpoint === 'responses' || endpoint.startsWith('responses/')) {
            let payload;
            try {
              const encoding = (incoming.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
              if (!['', 'identity', 'zstd'].includes(encoding)) {
                return Response.json({ error: { message: 'Unsupported request encoding.' } }, { status: 415 });
              }
              const decoded = encoding === 'zstd' ? await Bun.zstdDecompress(new Uint8Array(body)) : body;
              payload = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(decoded));
              if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Expected an object');
            } catch {
              return Response.json({ error: { message: 'Invalid JSON request.' } }, { status: 400 });
            }
            useWeb = typeof payload.model === 'string' && payload.model.startsWith('chatgpt-web/');
            if (!useWeb) {
              const cleaned = nativeInput(payload);
              if (cleaned !== payload) {
                body = JSON.stringify(cleaned);
                bodyChanged = true;
              }
            }
          }
        }
        const headers = new Headers(incoming.headers);
        for (const key of [...hopHeaders, 'content-length', 'accept-encoding']) headers.delete(key);
        if (bodyChanged) headers.delete('content-encoding');
        headers.set('accept-encoding', 'identity');
        if (endpoint === 'models') {
          headers.delete('if-none-match');
          if (!url.searchParams.has('client_version')) {
            const version = headers.get('user-agent')?.match(/\/(\d+\.\d+\.\d+)/)?.[1];
            if (version) url.searchParams.set('client_version', version);
          }
        }
        const base = useWeb ? (typeof webUrl === 'function' ? webUrl() : webUrl) : nativeUrl;
        const upstream = await request(`${base}/${endpoint}${url.search}`, {
          method: incoming.method, headers, body, signal: incoming.signal,
          redirect: endpoint.startsWith('images/') ? 'manual' : 'follow',
        });
        const outgoing = new Headers(upstream.headers);
        for (const key of [...hopHeaders, 'content-length', 'content-encoding']) outgoing.delete(key);
        if (endpoint === 'models' && upstream.ok) {
          const result = await upstream.json();
          result.models = [...result.models.filter((model) => !model.slug?.startsWith('chatgpt-web/')), ...catalog()];
          outgoing.delete('etag');
          outgoing.set('content-type', 'application/json');
          return new Response(JSON.stringify(result), { status: upstream.status, headers: outgoing });
        }
        return new Response(upstream.body, { status: upstream.status, headers: outgoing });
      } catch (error) {
        if (incoming.signal.aborted) return new Response(null, { status: 499 });
        console.error(`${useWeb ? 'web' : 'native'} upstream unavailable: ${error.code ?? error.name}`);
        return Response.json({ error: { type: 'server_error', message: useWeb
          ? 'Open Codex Web GPT to use (Web) models; its local bridge is unavailable.'
          : 'The OpenAI model service could not be reached.' } }, { status: 503 });
      }
    },
  });
}

if (import.meta.main) {
  const server = createRouter();
  console.log(`Codex model router listening on 127.0.0.1:${server.port}`);
}
