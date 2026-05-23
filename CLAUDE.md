# CLAUDE.md — meet-transcriber

## Project Identity

Obsidian community plugin "Transcribe" — real-time microphone transcription via AWS Transcribe Streaming, post-processing with AWS Bedrock. TypeScript + esbuild + vitest. Desktop only (`isDesktopOnly: true`).

## Stack

- TypeScript 5.4 / esbuild / vitest + jsdom + fast-check
- Obsidian API 1.4.11
- AWS SDK v3: `@aws-sdk/client-transcribe-streaming`, `@aws-sdk/client-bedrock-runtime`
- Manifest id: `obsidian-transcribe-plugin`

## Harness

`.claude/` is symlinked into `~/dev/my_harness_for_claude_code` via `install.sh --with-hooks`. Edit the harness repo and changes reflect here immediately.

- `.claude/_harness` -> harness repo root
- `.claude/{agents,commands,skills,rules,hooks}/_harness` -> matching subdirs
- `.claude/settings.json` carries the merged hook stack (28 hooks, harness-owned ids)

To uninstall:

```bash
CLAUDE_HOME=/Volumes/ext_ssd/dev/meet-transcriber/.claude \
  /Volumes/ext_ssd/dev/my_harness_for_claude_code/install.sh --with-hooks --uninstall
```

## Primary Skills (load on demand)

- `obsidian-plugin-develop` — TypeScript + i18n + Chromium + community-plugin release checklist
- `aws-cloud` — IAM, networking, cost guardrails
- `aws-bedrock` — model selection, streaming, prompt caching
- `realtime-stt-huggingface` — STT pipeline patterns (most apply to AWS Transcribe Streaming as well)
- `claude-api` — only if integrating Anthropic alongside Bedrock

## Primary Agents

- `typescript-reviewer` — code review for `src/`
- `architect` — bigger structural decisions (audio pipeline, error boundaries, retry/backoff)
- `security-reviewer` — when touching IAM, credential storage, AWS SDK calls, or any code path that handles raw audio
- `translator-docs` — Korean / English README and release notes

## Workflow Reminders

- `npm run dev` watcher must run inside tmux. The harness `pre-bash-dev-server-block` hook will block bare invocations to make sure you keep log access.
- `npm test` (vitest) before committing — the pre-commit-quality hook lints staged TS files and validates the commit message.
- Conventional commits: type prefix in English (`feat:`, `fix:`, `refactor:` ...), body in Korean per `rules/common/korean-language.md`.
- Release flow: `npm run version` -> tag -> push -> GitHub release with `manifest.json`, `main.js`, `styles.css`.

## Hook Tuning (optional)

```bash
# Disable specific hooks for this shell only
export HARNESS_DISABLED_HOOKS="post:edit:design-quality-check,post:harness-context-monitor"

# Switch profile (minimal | standard | strict)
export HARNESS_HOOK_PROFILE=minimal
```

Full list: `~/dev/my_harness_for_claude_code/hooks/README.md`.
