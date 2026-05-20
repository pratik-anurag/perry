import fs from 'fs/promises';
import path from 'path';
import { OwnerContext, OutputLogger } from './types';

export interface CodeOwnerRule {
  pattern: string;
  owners: string[];
  line: number;
}

const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

export class CodeownersService {
  private readonly ruleCache = new Map<string, CodeOwnerRule[] | undefined>();

  public constructor(
    private readonly workspaceRoots: string[],
    private readonly logger: OutputLogger
  ) {}

  public async getOwner(filePath: string): Promise<OwnerContext> {
    const workspaceRoot = findOwningWorkspaceRoot(this.workspaceRoots, filePath);
    if (!workspaceRoot) {
      return { available: false };
    }

    const rules = await this.loadRules(workspaceRoot);
    if (!rules) {
      return { available: false };
    }

    const relativePath = normalizePath(path.relative(workspaceRoot, filePath));
    const owner = matchCodeOwner(rules, relativePath);
    return owner ? { available: true, owner } : { available: false };
  }

  public clearCache(): void {
    this.ruleCache.clear();
  }

  private async loadRules(workspaceRoot: string): Promise<CodeOwnerRule[] | undefined> {
    if (this.ruleCache.has(workspaceRoot)) {
      return this.ruleCache.get(workspaceRoot);
    }

    for (const candidate of CODEOWNERS_PATHS) {
      const candidatePath = path.join(workspaceRoot, candidate);
      try {
        const content = await fs.readFile(candidatePath, 'utf8');
        const rules = parseCodeowners(content);
        this.ruleCache.set(workspaceRoot, rules);
        return rules;
      } catch (error) {
        this.logger.appendLine(`CODEOWNERS not loaded from ${candidatePath}: ${stringifyError(error)}`);
      }
    }

    this.ruleCache.set(workspaceRoot, undefined);
    return undefined;
  }
}

export function parseCodeowners(content: string): CodeOwnerRule[] {
  return content
    .split(/\r?\n/)
    .map((line, index): CodeOwnerRule | undefined => {
      const trimmed = line.split('#', 1)[0].trim();
      if (!trimmed || trimmed.startsWith('#')) {
        return undefined;
      }

      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) {
        return undefined;
      }

      const [pattern, ...owners] = parts;
      return { pattern, owners, line: index + 1 };
    })
    .filter((rule): rule is CodeOwnerRule => Boolean(rule));
}

export function matchCodeOwner(rules: CodeOwnerRule[], relativeFilePath: string): string | undefined {
  const normalizedPath = normalizePath(relativeFilePath);
  let matchedOwners: string[] | undefined;

  for (const rule of rules) {
    if (matchesCodeownersPattern(rule.pattern, normalizedPath)) {
      matchedOwners = rule.owners;
    }
  }

  return matchedOwners?.join(', ');
} 
export function matchesCodeownersPattern(pattern: string, relativeFilePath: string): boolean {
  const normalizedPattern = normalizePattern(pattern);
  const normalizedPath = normalizePath(relativeFilePath);

  if (!normalizedPattern || normalizedPattern === '*') {
    return true;
  }

  if (normalizedPattern.endsWith('/')) {
    return normalizedPath.startsWith(normalizedPattern);
  }

  if (normalizedPattern.includes('*')) {
    const regex = globPatternToRegex(normalizedPattern);
    if (regex.test(normalizedPath)) {
      return true;
    }

    if (!normalizedPattern.includes('/')) {
      return regex.test(path.posix.basename(normalizedPath));
    }
    return false;
  }

  if (!normalizedPattern.includes('/')) {
    return path.posix.basename(normalizedPath) === normalizedPattern;
  }

  return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
}

function normalizePattern(pattern: string): string {
  return normalizePath(pattern.replace(/^\/+/, ''));
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function globPatternToRegex(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const nextCharacter = pattern[index + 1];
    if (character === '*' && nextCharacter === '*') {
      source += '.*';
      index += 1;
      continue;
    }
    if (character === '*') {
      source += '[^/]*';
      continue;
    }
    source += escapeRegExp(character);
  }
  source += '$';
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function findOwningWorkspaceRoot(workspaceRoots: string[], filePath: string): string | undefined {
  const normalizedFilePath = path.resolve(filePath);
  return workspaceRoots
    .map((root) => path.resolve(root))
    .filter((root) => normalizedFilePath === root || normalizedFilePath.startsWith(`${root}${path.sep}`))
    .sort((left, right) => right.length - left.length)[0];
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
