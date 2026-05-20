import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { GitContext, OutputLogger } from './types';

const execFileAsync = promisify(execFile);

export class GitService {
  private readonly rootCache = new Map<string, string | undefined>();

  public constructor(
    private readonly logger: OutputLogger,
    private readonly timeoutMs = 1500
  ) {}

  public async getLineContext(filePath: string, oneBasedLine: number): Promise<GitContext> {
    const root = await this.findGitRoot(filePath);
    if (!root) {
      return { available: false };
    }

    const relativeFilePath = path.relative(root, filePath);
    const blame = await this.tryBlame(root, relativeFilePath, oneBasedLine);
    if (blame.available) {
      return blame;
    }

    return this.tryLog(root, relativeFilePath);
  }

  public clearCache(): void {
    this.rootCache.clear();
  }

  private async findGitRoot(filePath: string): Promise<string | undefined> {
    const directory = path.dirname(filePath);
    if (this.rootCache.has(directory)) {
      return this.rootCache.get(directory);
    }

    try {
      const { stdout } = await execFileAsync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], {
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024
      });
      const root = stdout.trim();
      this.rootCache.set(directory, root || undefined);
      return root || undefined;
    } catch (error) {
      this.logger.appendLine(`Git root unavailable for ${filePath}: ${stringifyError(error)}`);
      this.rootCache.set(directory, undefined);
      return undefined;
    }
  }

  private async tryBlame(root: string, relativeFilePath: string, oneBasedLine: number): Promise<GitContext> {
    try {
      const lineRange = `${oneBasedLine},${oneBasedLine}`;
      const { stdout } = await execFileAsync(
        'git',
        ['-C', root, 'blame', '-L', lineRange, '--line-porcelain', '--', relativeFilePath],
        { timeout: this.timeoutMs, maxBuffer: 1024 * 1024 }
      );

      const author = readPorcelainValue(stdout, 'author');
      const authorTime = readPorcelainValue(stdout, 'author-time');
      if (!author || !authorTime) {
        return { available: false };
      }

      return {
        available: true,
        author,
        relativeDate: formatRelativeDate(Number(authorTime))
      };
    } catch (error) {
      this.logger.appendLine(`Git blame unavailable for ${relativeFilePath}:${oneBasedLine}: ${stringifyError(error)}`);
      return { available: false };
    }
  }

  private async tryLog(root: string, relativeFilePath: string): Promise<GitContext> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', root, 'log', '-1', '--format=%an|%ar', '--', relativeFilePath],
        { timeout: this.timeoutMs, maxBuffer: 1024 * 1024 }
      );
      const [author, relativeDate] = stdout.trim().split('|');
      if (!author || !relativeDate) {
        return { available: false };
      }

      return {
        available: true,
        author,
        relativeDate
      };
    } catch (error) {
      this.logger.appendLine(`Git log unavailable for ${relativeFilePath}: ${stringifyError(error)}`);
      return { available: false };
    }
  }
}

export function formatRelativeDate(unixSeconds: number, now = new Date()): string {
  if (!Number.isFinite(unixSeconds)) {
    return 'unknown';
  }

  const date = new Date(unixSeconds * 1000);
  const today = startOfLocalDay(now);
  const target = startOfLocalDay(date);
  const diffDays = Math.floor((today.getTime() - target.getTime()) / 86_400_000);

  if (diffDays <= 0) {
    return 'today';
  }
  if (diffDays === 1) {
    return 'yesterday';
  }
  if (diffDays < 30) {
    return `${diffDays} days ago`;
  }
  if (diffDays < 365) {
    const months = Math.max(1, Math.floor(diffDays / 30));
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }

  const years = Math.max(1, Math.floor(diffDays / 365));
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function readPorcelainValue(output: string, key: string): string | undefined {
  const prefix = `${key} `;
  return output
    .split(/\r?\n/)
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
