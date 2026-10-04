# Codex Model Router

A small macOS LaunchAgent that sends only `chatgpt-web/` models to Codex Web GPT.
Other built-in OpenAI models connect to the native Codex service, even with Web GPT closed.

```text
Codex -> localhost:17842 -> chatgpt-web/* -> Web GPT local bridge
                        -> other models -> native Codex service
```

This is an independent, unofficial helper. It does not modify either app bundle.

## Requirements

- macOS and Codex signed in with a ChatGPT account.
- [Codex Web GPT](https://github.com/miuuyy/codex-chatgpt-web) already set up in Codex.
- A standalone [Bun](https://bun.sh) installation with `Bun.zstdDecompress` and `Bun.TOML.parse` (tested with Bun 1.4.2).
- Port 17842 available; Web GPT must use a different port (normally 17841).

This helper targets Codex's built-in ChatGPT-backed OpenAI provider, not arbitrary API-key providers.

## Install

```sh
git clone https://github.com/henry-bao/codex-model-router.git
cd codex-model-router
bun setup.mjs install
```

Restart Codex afterward. Native models need only the background router; `(Web)` models still need Web GPT open and signed in.

The installer copies the router outside both apps to `~/.codex/model-router/` and creates
`~/Library/LaunchAgents/dev.codex.model-router.plist`. macOS starts it at login and restarts it if it exits.
It has no polling loop while idle. Installation does not require administrator access.

It changes only the top-level `openai_base_url` in Codex's configuration and, when present,
the installed URL in Web GPT's active integration journals. Other Codex settings, including
the realtime voice URL, stay unchanged. A local backup and restore record are kept with owner-only permissions.

## Manage

```sh
bun setup.mjs status
bun setup.mjs install    # update or repair the installation
bun setup.mjs uninstall
```

Uninstall restores the original routing only if it is still pointing at this router. It preserves later
unrelated configuration changes. Local backups, the model snapshot, source, and logs remain for inspection;
the LaunchAgent is unloaded and removed. Restart Codex after changing routing.

For a custom installation, set `CODEX_HOME` and/or `CODEX_CHATGPT_WEB_HOME` when running setup.
The installer carries those paths into the LaunchAgent. Use the same paths for status and uninstall.

## App Updates

Replacing either app bundle does not remove the router, its Bun runtime, or its LaunchAgent.
The bridge port is read from Web GPT's configuration on each Web request, so a changed bridge port is picked up automatically.

If Web GPT's integration setup rewrites `openai_base_url`, rerun `bun setup.mjs install` and restart Codex.
There is no configuration watcher. Future changes to the apps' protocols may require a router update;
this helper cannot guarantee compatibility with every future app release.

To update this helper, pull the repository and run setup again:

```sh
git pull --ff-only
bun setup.mjs install
```

## Behavior And Privacy

- Routes by the exact `chatgpt-web/` model prefix, not display names or the word "web".
- Uses HTTP streaming (SSE); WebSocket upgrade requests return 426 so Codex can fall back to HTTP.
- Handles Codex's zstd-compressed requests and preserves native model metadata in the merged catalog.
- Converts Web GPT history markers when switching a conversation back to native models.
- Reads the local Web model catalog, with an installation-time snapshot as fallback.
- Binds only to `127.0.0.1` and forwards the request's bearer credentials to the selected service.
- Does not read `auth.json`, save tokens, or log prompts/responses. Error logs contain only backend and error type.
- Adds no authentication of its own: other software running as your user is inside the local trust boundary.

The native backend address and Web GPT history markers are implementation details, not stable public APIs.
The compatibility conversion follows the `ocx1:` / `ocxr1:` conventions used by Codex Web GPT.

## Test

```sh
bun check.mjs
```

Tests use simulated backends and temporary files, require no sign-in, and do not touch your live configuration.
