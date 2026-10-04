import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouter, nativeInput, webModels } from './router.mjs';
import { baseUrl, baseUrlLine, launchAgent, replaceBaseUrl, setup } from './setup.mjs';

const calls = [];
const router = createRouter({ port: 0, nativeUrl: 'https://native.invalid', webUrl: 'http://web.invalid/v1',
  catalog: () => [{ slug: 'chatgpt-web/example', display_name: 'Example (Web)' }],
  request: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/models')) return Response.json({ models: [{ slug: 'gpt-6.1-sol', multi_agent_version: 'v2' }] });
    if (url.includes('web.invalid')) throw Object.assign(new Error('closed'), { code: 'ECONNREFUSED' });
    return new Response('data: native works\n\n', { headers: { 'content-type': 'text/event-stream' } });
  },
});
const base = `http://127.0.0.1:${router.port}`;
const headers = { authorization: 'Bearer test-only', 'content-type': 'application/json' };
const temporary = mkdtempSync(join(tmpdir(), 'codex-model-router-check-'));
try {
  for (const model of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'some-web-model']) {
    const response = await fetch(`${base}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model, input: [] }) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'data: native works\n\n');
    assert.ok(calls.at(-1).url.startsWith('https://native.invalid/'));
    assert.equal(calls.at(-1).options.headers.get('authorization'), 'Bearer test-only');
  }
  const web = await fetch(`${base}/v1/responses`, { method: 'POST', headers,
    body: JSON.stringify({ model: 'chatgpt-web/gpt-6-pro', input: [] }) });
  assert.equal(web.status, 503);
  assert.match((await web.json()).error.message, /Open Codex Web GPT/);
  assert.equal(calls.at(-1).url, 'http://web.invalid/v1/responses');
  for (const model of ['gpt-6.1-sol', 'chatgpt-web/gpt-6-pro']) {
    const compressed = await Bun.zstdCompress(Buffer.from(JSON.stringify({ model, input: [] })));
    const response = await fetch(`${base}/v1/responses`, { method: 'POST',
      headers: { ...headers, 'content-encoding': 'zstd' }, body: compressed });
    assert.equal(response.status, model.startsWith('chatgpt-web/') ? 503 : 200);
    assert.deepEqual(new Uint8Array(calls.at(-1).options.body), new Uint8Array(compressed));
    assert.equal(calls.at(-1).options.headers.get('content-encoding'), 'zstd');
  }
  const models = await fetch(`${base}/v1/models`, {
    headers: { ...headers, 'user-agent': 'codex/1.2.3', 'if-none-match': 'stale' },
  });
  const catalog = (await models.json()).models;
  assert.deepEqual(catalog.map((model) => model.slug), ['gpt-6.1-sol', 'chatgpt-web/example']);
  assert.equal(catalog[0].multi_agent_version, 'v2');
  assert.equal(calls.at(-1).url, 'https://native.invalid/models?client_version=1.2.3');
  assert.equal(calls.at(-1).options.headers.get('if-none-match'), null);
  for (const model of ['gpt-6.1-sol', 'chatgpt-web/example']) {
    const response = await fetch(`${base}/v1/responses/compact`, { method: 'POST', headers,
      body: JSON.stringify({ model, input: [] }) });
    assert.equal(response.status, model.startsWith('chatgpt-web/') ? 503 : 200);
    assert.ok(calls.at(-1).url.endsWith('/responses/compact'));
  }
  const original = { model: 'gpt-6.1-sol', input: [{ type: 'message', role: 'user', content: 'hello' }] };
  assert.equal(nativeInput(original), original);
  const history = { ...original, previous_response_id: 'web-id', input: [
    { type: 'reasoning', encrypted_content: 'ocxr1:ignored', summary: [] },
    { type: 'compaction', encrypted_content: `ocx1:${Buffer.from('Keep working').toString('base64')}` },
  ] };
  const migrated = nativeInput(history);
  assert.equal(migrated.previous_response_id, undefined);
  assert.equal(migrated.input.length, 1);
  assert.ok(migrated.input[0].content[0].text.endsWith('Keep working'));
  const switched = await fetch(`${base}/v1/responses`, { method: 'POST',
    headers: { ...headers, 'content-encoding': 'zstd' },
    body: await Bun.zstdCompress(Buffer.from(JSON.stringify(history))) });
  assert.equal(switched.status, 200);
  assert.equal(calls.at(-1).options.headers.get('content-encoding'), null);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), migrated);
  const count = calls.length;
  assert.equal((await fetch(`${base}/v1/responses`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/v1/responses`, { method: 'POST', headers, body: '[' })).status, 400);
  assert.equal((await fetch(`${base}/v1/responses`, { method: 'POST',
    headers: { ...headers, 'content-encoding': 'gzip' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${base}/v1/responses`, { headers: { ...headers, upgrade: 'websocket' } })).status, 426);
  assert.equal((await fetch(`${base}/unknown`)).status, 404);
  assert.equal(calls.length, count);

  const config = '# Keep this comment\nmodel = "native"\nopenai_base_url = "http://127.0.0.1:17841/v1" # old route\n\n[features]\nmulti_agent = true\n';
  const changed = replaceBaseUrl(config, `openai_base_url = "${baseUrl}"\n`);
  assert.equal(replaceBaseUrl(changed, baseUrlLine(config)), config);
  const noUrl = 'model = "native"\n[features]\nmulti_agent = true\n';
  assert.equal(replaceBaseUrl(replaceBaseUrl(noUrl, `openai_base_url = "${baseUrl}"\n`), null), noUrl);
  assert.throws(() => replaceBaseUrl('openai_base_url = """\nold\n"""\n', `openai_base_url = "${baseUrl}"\n`));
  const xml = launchAgent({ bun: '/tmp/a&b/bun', router: '/tmp/r.mjs', home: temporary,
    codexHome: temporary, webHome: temporary });
  assert.match(xml, /a&amp;b/);
  assert.match(xml, /<key>KeepAlive<\/key><true\/>/);

  const codexHome = join(temporary, 'codex');
  const webHome = join(temporary, 'web');
  const agentsHome = join(temporary, 'agents');
  mkdirSync(codexHome);
  mkdirSync(join(webHome, 'codex'), { recursive: true });
  const configPath = join(codexHome, 'config.toml');
  writeFileSync(configPath, config);
  writeFileSync(join(webHome, 'config.json'), JSON.stringify({ port: 17841 }));
  writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify({ account_id: 'private-test',
    models: [{ slug: 'gpt-native' }, { slug: 'chatgpt-web/example' }] }));
  const journalPath = join(webHome, 'codex/integration-journal.json');
  writeFileSync(journalPath, JSON.stringify({ active: true, unrelated: 7,
    installed: { openai_base_url: 'http://127.0.0.1:17841/v1' } }));
  assert.equal(webModels(codexHome, temporary).length, 1);
  assert.deepEqual(webModels(temporary, temporary), []);
  if (process.platform === 'darwin') {
    let loaded = false;
    const commands = [];
    const options = { codexHome, webHome, agentsHome, health: async () => true,
      run: (program, args) => {
        assert.equal(program, '/bin/launchctl');
        commands.push(args);
        if (args[0] === 'print') return { status: loaded ? 0 : 1 };
        loaded = args[0] === 'bootstrap';
        return { status: 0 };
      } };
    await setup('install', options);
    assert.equal(Bun.TOML.parse(readFileSync(configPath, 'utf8')).openai_base_url, baseUrl);
    const snapshot = readFileSync(join(codexHome, 'model-router/catalog-snapshot.json'), 'utf8');
    assert.ok(!snapshot.includes('private-test'));
    assert.equal(JSON.parse(snapshot).models.length, 1);
    writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}new_setting = "preserved"\n`);
    await setup('install', options);
    await setup('uninstall', options);
    assert.equal(readFileSync(configPath, 'utf8'), `${config}new_setting = "preserved"\n`);
    assert.equal(JSON.parse(readFileSync(journalPath, 'utf8')).unrelated, 7);
    assert.equal(JSON.parse(readFileSync(journalPath, 'utf8')).installed.openai_base_url, 'http://127.0.0.1:17841/v1');
    assert.ok(!existsSync(join(agentsHome, 'dev.codex.model-router.plist')));
    assert.ok(commands.some((args) => args[0] === 'bootstrap'));
    await setup('install', options);
    writeFileSync(configPath, replaceBaseUrl(readFileSync(configPath, 'utf8'), 'openai_base_url = "https://custom.invalid"\n'));
    await setup('uninstall', options);
    assert.equal(Bun.TOML.parse(readFileSync(configPath, 'utf8')).openai_base_url, 'https://custom.invalid');
    await assert.rejects(setup('install', options), /refusing to replace/);
  }
  console.log('Passed: routing, closed Web bridge, zstd, SSE, catalog, compaction, model switching, validation, and scoped config restore.');
} finally {
  router.stop(true);
  rmSync(temporary, { recursive: true, force: true });
}
