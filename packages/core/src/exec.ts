import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** ps/capture-pane output can be large; default 16MB. */
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run a command and capture its output. Never rejects — a non-zero exit is a
 * value, not an exception, because most of what we shell out to (tmux, git, gh)
 * fails routinely and benignly (no server running, not a repo, no such session).
 */
export function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 10_000,
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
        encoding: 'utf8',
        env: opts.env,
      },
      (err: ExecFileException | null, stdout, stderr) => {
        // execFile puts the exit status on err.code, but uses a string there for
        // spawn failures (ENOENT), so only trust it when it's numeric.
        const raw = err?.code;
        const code = typeof raw === 'number' ? raw : err ? 1 : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

/** Convenience for the common "I only care if it worked" case. */
export async function runOk(file: string, args: string[], opts?: RunOptions): Promise<boolean> {
  const { code } = await run(file, args, opts);
  return code === 0;
}
