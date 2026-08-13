#!/usr/bin/env node
import process from 'node:process';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { clearInterval, setInterval, setTimeout } from 'node:timers';

const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function emit(value, split = false) {
  const line = `${JSON.stringify(value)}\n`;
  if (!split) {
    process.stdout.write(line);
    return;
  }
  const boundary = Math.max(1, Math.floor(line.length / 2));
  process.stdout.write(line.slice(0, boundary));
  setTimeout(() => process.stdout.write(line.slice(boundary)), 5);
}

if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('2.1.228 (Claude Code mock)\n');
} else if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(`Usage: claude [options]
  -p, --print
  --model <model>
  --effort <level>
  --output-format <format>
  --verbose
  --permission-mode <mode>
  --tools <tools>
  --settings <path>
  --setting-sources <sources>
  --json-schema <schema>
  --resume <session>
  --session-id <uuid>
  --mcp-config <path>
  --strict-mcp-config
`);
} else if (args.length === 2 && args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(`${JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    subscriptionType: 'max',
  })}\n`);
} else {
  const prompt = option('-p') ?? '';
  const task = /\n\nTask:\n([\s\S]*)/u.exec(prompt)?.[1] ?? prompt;
  const requestedModel = option('--model') ?? 'sonnet';
  const model =
    task === 'mock:mismatch'
      ? 'claude-opus-4-1'
      : task === 'mock:same-family-mismatch'
        ? 'claude-sonnet-5'
        : `claude-${requestedModel}-mock`;
  const sessionId = option('--resume') ?? option('--session-id') ?? '22222222-2222-4222-8222-222222222222';
  const effort = option('--effort') ?? 'medium';

  emit({ type: 'system', subtype: 'init', session_id: sessionId, model, effort }, true);
  process.stderr.write('mock diagnostic\n');

  if (task === 'mock:timeout') {
    setInterval(() => process.stderr.write('heartbeat\n'), 1000);
  } else if (task === 'mock:ignore-term') {
    process.on('SIGTERM', () => {});
    setInterval(() => process.stderr.write('still running\n'), 1000);
  } else if (task === 'mock:process-tree') {
    const pidFile = process.env.HYDRA_MOCK_PID_FILE;
    if (pidFile === undefined) {
      throw new Error('HYDRA_MOCK_PID_FILE is required');
    }
    process.on('SIGTERM', () => {});
    const grandchildCode = [
      'process.on("SIGTERM", () => {});',
      'setInterval(() => {}, 1000);',
    ].join('');
    const childCode = [
      'const { appendFileSync } = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      'process.on("SIGTERM", () => {});',
      `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildCode)}], { stdio: "ignore" });`,
      'appendFileSync(process.env.HYDRA_MOCK_PID_FILE, `${process.pid}\\n${grandchild.pid}\\n`);',
      'setInterval(() => {}, 1000);',
    ].join('');
    const descendant = spawn(process.execPath, ['-e', childCode], {
      stdio: 'ignore',
      env: process.env,
    });
    appendFileSync(pidFile, `${process.pid}\n${descendant.pid}\n`);
    setInterval(() => {}, 1000);
  } else if (task === 'mock:fast-orphan') {
    const pidFile = process.env.HYDRA_MOCK_PID_FILE;
    if (pidFile === undefined) {
      throw new Error('HYDRA_MOCK_PID_FILE is required');
    }
    const descendant = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      { stdio: 'ignore' },
    );
    descendant.unref();
    appendFileSync(pidFile, `${descendant.pid}\n`);
    setTimeout(() => {
      emit({
        type: 'assistant',
        message: { model, content: [{ type: 'text', text: 'fast parent result' }] },
      });
      emit({
        type: 'result',
        subtype: 'success',
        result: 'fast parent result',
        session_id: sessionId,
      });
      setTimeout(() => process.exit(0), 5);
    }, 15);
  } else if (task === 'mock:tool-turn-limit') {
    setTimeout(() => emit({
      type: 'assistant',
      message: {
        model,
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }],
      },
    }), 15);
    setInterval(() => {
      emit({
        type: 'assistant',
        message: { model, content: [{ type: 'text', text: 'second turn' }] },
      });
    }, 50);
  } else if (task === 'mock:turn-limit') {
    let turn = 0;
    const timer = setInterval(() => {
      turn += 1;
      emit({
        type: 'assistant',
        message: { model, content: [{ type: 'text', text: `turn ${turn}` }] },
      });
      if (turn === 3) {
        clearInterval(timer);
        emit({ type: 'result', result: 'too many', num_turns: turn, terminal_reason: 'end_turn' });
      }
    }, 20);
  } else {
    setTimeout(async () => {
      if (task === 'mock:write') {
        await writeFile('mock-change.txt', 'created by mock Claude\n', 'utf8');
      }
      if (task === 'mock:require-no-fallback' && process.env.CLAUDE_CODE_NO_MODEL_FALLBACK !== '1') {
        emit({ type: 'result', subtype: 'error', is_error: true, result: 'fallback guard absent' });
        return;
      }
      emit({
        type: 'assistant',
        message: {
          model,
          effort,
          content: [{ type: 'text', text: `answer for ${task}` }],
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      });
      if (task === 'mock:malformed') {
        process.stdout.write('{malformed secret line}\n');
      }
      emit({
        type: 'result',
        subtype: task === 'mock:credits-required' ? 'usage_credits_required' : 'success',
        is_error: task === 'mock:credits-required',
        ...(task === 'mock:credits-required' ? { usage_credits_required: true } : {}),
        result: `final for ${task}`,
        ...(task === 'mock:resumed-cumulative-turns' ? { num_turns: 40 } : {}),
        ...(option('--json-schema') === undefined ? {} : { structured_output: { ok: true } }),
        session_id: sessionId,
        duration_ms: 20,
        terminal_reason: 'end_turn',
        ...(task === 'mock:unexpected-model-usage' ||
        task === 'mock:same-family-extra-usage' ||
        task === 'mock:single-model-usage-mismatch'
          ? {
              modelUsage: {
                ...(task === 'mock:single-model-usage-mismatch'
                  ? { 'claude-opus-4-1': { inputTokens: 2 } }
                  : {
                      [task === 'mock:unexpected-model-usage'
                        ? 'claude-haiku-4-5-20251001'
                        : 'claude-sonnet-4-5-20250929']: { inputTokens: 543 },
                      [model]: { inputTokens: 2 },
                    }),
              },
            }
          : {}),
      });
    }, 15);
  }
}
