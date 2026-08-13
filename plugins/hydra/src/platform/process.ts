import { spawn } from 'node:child_process';

import { HydraError } from '../domain.js';

export interface ProcessRunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface CompletedProcess {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options?: ProcessRunOptions,
  ): Promise<CompletedProcess>;
}

export class NodeProcessRunner implements ProcessRunner {
  public async run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<CompletedProcess> {
    if (options.signal?.aborted === true) {
      throw new HydraError('PROCESS_ABORTED', 'Process launch was aborted');
    }

    const startedAt = Date.now();
    const maxOutputBytes = options.maxOutputBytes ?? 2_000_000;
    const terminationGraceMs = options.terminationGraceMs ?? 1_000;
    if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 0) {
      throw new HydraError(
        'INVALID_TERMINATION_GRACE',
        'Process termination grace must be a non-negative integer',
      );
    }
    return new Promise<CompletedProcess>((resolvePromise, rejectPromise) => {
      const child = spawn(command, [...args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let outputBytes = 0;
      let outputExceeded = false;
      let timedOut = false;
      let settled = false;
      let forceKill: NodeJS.Timeout | undefined;

      const terminate = (): void => {
        child.kill('SIGTERM');
        if (forceKill === undefined) {
          forceKill = setTimeout(() => {
            if (!settled) {
              child.kill('SIGKILL');
            }
          }, terminationGraceMs);
          forceKill.unref();
        }
      };

      const timeout =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              terminate();
            }, options.timeoutMs);
      timeout?.unref();

      const onAbort = (): void => {
        terminate();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const collect = (target: Buffer[], chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.byteLength;
        if (outputBytes > maxOutputBytes) {
          outputExceeded = true;
          child.kill('SIGKILL');
          return;
        }
        target.push(buffer);
      };

      child.stdout.on('data', (chunk: Buffer | string) => collect(stdoutChunks, chunk));
      child.stderr.on('data', (chunk: Buffer | string) => collect(stderrChunks, chunk));

      child.once('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        if (forceKill !== undefined) {
          clearTimeout(forceKill);
        }
        options.signal?.removeEventListener('abort', onAbort);
        rejectPromise(error);
      });

      child.once('close', (exitCode, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        if (forceKill !== undefined) {
          clearTimeout(forceKill);
        }
        options.signal?.removeEventListener('abort', onAbort);

        if (outputExceeded) {
          rejectPromise(
            new HydraError('PROCESS_OUTPUT_LIMIT', `Process output exceeded ${maxOutputBytes} bytes`),
          );
          return;
        }
        if (options.signal?.aborted === true) {
          rejectPromise(new HydraError('PROCESS_ABORTED', 'Process execution was aborted'));
          return;
        }

        resolvePromise({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          exitCode,
          signal,
          durationMs: Date.now() - startedAt,
          timedOut,
        });
      });
    });
  }
}
