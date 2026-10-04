import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { webModels } from './router.mjs';

export const baseUrl = 'http://127.0.0.1:17842/v1';
const label = 'dev.codex.model-router';

// Preserve formatting and comments; refuse unusual TOML rather than rewrite unrelated settings.
export function baseUrlLine(text) {
  const root = text.split(/(?=^\s*\[)/m)[0];
  return root.match(/^[ \t]*openai_base_url[ \t]*=.*(?:\r?\n|$)/m)?.[0] ?? null;
}

export function replaceBaseUrl(text, line) {
  const before = Bun.TOML.parse(text);
  const oldLine = baseUrlLine(text);
  if (before.openai_base_url !== undefined && oldLine === null) {
    throw new Error('Use a single-line, unquoted openai_base_url setting before the first TOML table.');
  }
  const next = oldLine === null ? `${line ?? ''}${text}` : text.replace(oldLine, line ?? '');
  const after = Bun.TOML.parse(next);
  delete before.openai_base_url;
  delete after.openai_base_url;
  assert.deepEqual(after, before, 'Refusing to change unrelated Codex settings');
  return next;
}

export function launchAgent({ bun, router, home, codexHome, webHome }) {
  const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${xml(bun)}</string><string>${xml(router)}</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>CODEX_HOME</key><string>${xml(codexHome)}</string>
    <key>CODEX_CHATGPT_WEB_HOME</key><string>${xml(webHome)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(join(home, 'stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(home, 'stderr.log'))}</string>
</dict></plist>
`;
}

function save(path, text) {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  chmodSync(`${path}.tmp`, 0o600);
  renameSync(`${path}.tmp`, path);
}

function read(path) {
  try { return readFileSync(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function healthy() {
  try {
    const response = await fetch('http://127.0.0.1:17842/healthz', { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).service === 'codex-model-router';
  } catch { return false; }
}

export async function setup(command = 'install', { codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  webHome = process.env.CODEX_CHATGPT_WEB_HOME || join(homedir(), '.codex-chatgpt-web'),
  agentsHome = join(homedir(), 'Library/LaunchAgents'), run = spawnSync, health = healthy } = {}) {
  if (process.platform !== 'darwin') throw new Error('The installer requires macOS.');
  if (typeof Bun.zstdDecompress !== 'function' || !Bun.TOML?.parse) {
    throw new Error('Update Bun: this router needs Bun.zstdDecompress and Bun.TOML.parse.');
  }
  codexHome = resolve(codexHome);
  webHome = resolve(webHome);
  const home = join(codexHome, 'model-router');
  const configPath = join(codexHome, 'config.toml');
  const plist = join(agentsHome, `${label}.plist`);
  const statePath = join(home, 'install-state.json');
  const domain = `gui/${process.getuid()}`;
  const service = `${domain}/${label}`;
  const ctl = (...args) => run('/bin/launchctl', args, { encoding: 'utf8' });
  const loaded = () => ctl('print', service).status === 0;

  if (command === 'status') {
    const configured = Bun.TOML.parse(read(configPath) ?? '').openai_base_url === baseUrl;
    console.log(JSON.stringify({ loaded: loaded(), healthy: await health(), configured }, null, 2));
    return;
  }
  if (!['install', 'uninstall'].includes(command)) throw new Error('Usage: bun setup.mjs [install|status|uninstall]');
  const current = read(configPath) ?? '';
  const state = JSON.parse(read(statePath) ?? 'null');
  if (command === 'uninstall') {
    if (!state) throw new Error('No installer restore record found; no settings have been changed.');
    if (Bun.TOML.parse(current).openai_base_url === baseUrl) {
      save(configPath, replaceBaseUrl(current, state.originalLine));
    }
    for (const entry of state.journals) {
      const text = read(entry.path);
      if (!text) continue;
      const journal = JSON.parse(text);
      if (journal.installed?.openai_base_url === baseUrl) {
        if (entry.original === null) delete journal.installed.openai_base_url;
        else journal.installed.openai_base_url = entry.original;
        save(entry.path, `${JSON.stringify(journal, null, 2)}\n`);
      }
    }
    if (loaded()) {
      const result = ctl('bootout', service);
      if (result.status !== 0) throw new Error(result.stderr || 'Could not unload router');
    }
    if (existsSync(plist)) unlinkSync(plist);
    unlinkSync(statePath);
    console.log('Router unloaded. Original routing restored unless you changed it later. Restart Codex.');
    return;
  }

  const bridge = JSON.parse(readFileSync(join(webHome, 'config.json'), 'utf8'));
  if (!Number.isInteger(bridge.port) || bridge.port < 1 || bridge.port > 65535 || bridge.port === 17842) {
    throw new Error('Web GPT must use a valid local port other than 17842.');
  }
  const original = Bun.TOML.parse(current).openai_base_url;
  const webUrl = `http://127.0.0.1:${bridge.port}/v1`;
  if (original !== undefined && ![baseUrl, webUrl, 'https://chatgpt.com/backend-api/codex'].includes(original)) {
    throw new Error('A different OpenAI base URL is configured; refusing to replace it.');
  }
  const next = replaceBaseUrl(current, `openai_base_url = "${baseUrl}"\n`);
  const journals = [];
  for (const name of ['integration-journal.json', 'integration-journal.recovery.json']) {
    const path = join(webHome, 'codex', name);
    const text = read(path);
    if (!text) continue;
    const journal = JSON.parse(text);
    if (journal.active && journal.installed) {
      journals.push({ path, journal, original: journal.installed.openai_base_url ?? null });
    }
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  mkdirSync(agentsHome, { recursive: true });
  const models = webModels(codexHome, home);
  if (!models.length) throw new Error('Set up Web GPT in Codex first so its Web model catalog is available.');
  if (!state) {
    save(join(home, 'config-before-install.toml'), current);
    // Adopt an existing router without making uninstall point back at an unloaded router.
    save(statePath, `${JSON.stringify({
      originalLine: original === baseUrl ? null : baseUrlLine(current),
      journals: journals.map(({ path, original: value }) => ({ path,
        original: value === baseUrl ? webUrl : value })),
    }, null, 2)}\n`);
  }
  save(join(home, 'catalog-snapshot.json'), `${JSON.stringify({ models })}\n`);
  const router = join(home, 'router.mjs');
  const source = join(dirname(fileURLToPath(import.meta.url)), 'router.mjs');
  if (resolve(source) !== resolve(router)) copyFileSync(source, router);
  chmodSync(router, 0o600);
  save(plist, launchAgent({ bun: process.execPath, router, home, codexHome, webHome }));
  if (loaded()) {
    const result = ctl('bootout', service);
    if (result.status !== 0) throw new Error(result.stderr || 'Could not unload old router');
  }
  const started = ctl('bootstrap', domain, plist);
  if (started.status !== 0) throw new Error(started.stderr || 'Could not start router');
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await health()) { ready = true; break; }
    await Bun.sleep(100);
  }
  if (!ready) throw new Error(`Router did not start. Check ${join(home, 'stderr.log')}; Codex settings were not rewritten.`);
  if ((read(configPath) ?? '') !== current) throw new Error('Codex settings changed during installation; rerun setup.');
  save(configPath, next);
  for (const { path, journal } of journals) {
    journal.installed.openai_base_url = baseUrl;
    save(path, `${JSON.stringify(journal, null, 2)}\n`);
  }
  console.log('Router installed and running as a login LaunchAgent. Restart Codex.');
}

if (import.meta.main) {
  try { await setup(process.argv[2]); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
