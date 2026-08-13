import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { HydraError } from '../domain.js';

function collectProcessOutput(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once('error', rejectPromise);
    child.once('close', (exitCode) => {
      if (exitCode === 0) {
        resolvePromise(Buffer.concat(chunks).toString('utf8').trim());
      } else {
        rejectPromise(
          new HydraError('PROCESS_MARKER_UNAVAILABLE', 'Unable to read process marker'),
        );
      }
    });
  });
}

export async function readProcessStartMarker(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new HydraError('INVALID_PROCESS_ID', 'Process ID must be a positive safe integer');
  }
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const commandEnd = stat.lastIndexOf(') ');
      if (commandEnd < 0) {
        throw new Error('invalid proc stat');
      }
      const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/u);
      const startTicks = fieldsAfterCommand[19];
      if (startTicks === undefined || !/^\d+$/u.test(startTicks)) {
        throw new Error('missing proc start time');
      }
      return `linux-proc:${startTicks}`;
    } catch {
      throw new HydraError('PROCESS_MARKER_UNAVAILABLE', 'Unable to read process marker');
    }
  }
  const marker = await collectProcessOutput('ps', [
    '-p',
    String(pid),
    '-o',
    'lstart=',
    '-o',
    'comm=',
  ]);
  if (marker.length === 0) {
    throw new HydraError('PROCESS_MARKER_UNAVAILABLE', 'Process marker was empty');
  }
  return marker;
}

export async function readProcessStartMarkerWithRetry(
  pid: number,
  attempts = 20,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await readProcessStartMarker(pid);
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
    }
  }
  throw lastError;
}

export async function processIdentityAlive(
  pid: number,
  expectedMarker: string,
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || expectedMarker.length === 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return false;
    }
    if (code !== 'EPERM') {
      throw error;
    }
  }
  try {
    return (await readProcessStartMarker(pid)) === expectedMarker;
  } catch {
    return false;
  }
}
