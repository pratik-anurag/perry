import path from 'path';
import * as vscode from 'vscode';
import { CodeownersService } from './codeowners';
import { GitService } from './gitService';
import { extractCallsFromSymbol } from './symbolAnalysis';
import { TestDiscovery } from './testDiscovery';
import { ContextSymbol, OutputLogger, RangeData, SymbolContext } from './types';

interface SymbolCandidate {
  name: string;
  kind: vscode.SymbolKind;
  range: vscode.Range;
}

interface ContextLensProviderServices {
  gitService: GitService;
  testDiscovery: TestDiscovery;
  codeownersService: CodeownersService;
  logger: OutputLogger;
}

const SUPPORTED_SYMBOL_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Module
]);

export class ContextLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly cache = new Map<string, Promise<SymbolContext[]>>();

  public readonly onDidChangeCodeLenses = this.changeEmitter.event;

  public constructor(private readonly services: ContextLensProviderServices) {}

  public async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    try {
      if (!getConfig().get<boolean>('enabled', true) || !getConfig().get<boolean>('showDetailsLens', false)) {
        return [];
      }

      const contexts = await this.getDocumentContexts(document, token);
      if (token.isCancellationRequested) {
        return [];
      }

      return contexts.map((context) => {
        const range = new vscode.Range(
          context.symbol.range.start.line,
          context.symbol.range.start.character,
          context.symbol.range.start.line,
          context.symbol.range.start.character
        );
        return new vscode.CodeLens(range, {
          title: formatCodeLensTitle(context),
          command: 'contextLens.showDetails',
          arguments: [context]
        });
      });
    } catch (error) {
      this.services.logger.appendLine(`CodeLens provider failed: ${stringifyError(error)}`);
      return [];
    }
  }

  public clearCache(): void {
    this.cache.clear();
    this.changeEmitter.fire();
  }

  public async getDocumentContexts(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<SymbolContext[]> {
    const cacheKey = `${document.uri.toString()}@${document.version}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const promise = this.buildContexts(document, token).catch((error) => {
      this.cache.delete(cacheKey);
      this.services.logger.appendLine(`Context build failed for ${document.uri.toString()}: ${stringifyError(error)}`);
      return [];
    });
    this.deleteDocumentCache(document.uri);
    this.cache.set(cacheKey, promise);
    return promise;
  }

  public async getContextAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<SymbolContext | undefined> {
    const contexts = await this.getDocumentContexts(document, token);
    return contexts
      .filter((context) => toVscodeRange(context.symbol.range).contains(position))
      .sort((left, right) => rangeDataSize(left.symbol.range) - rangeDataSize(right.symbol.range))[0];
  }

  private deleteDocumentCache(uri: vscode.Uri): void {
    const prefix = `${uri.toString()}@`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  private async buildContexts(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<SymbolContext[]> {
    const config = getConfig();
    const maxSymbols = config.get<number>('maxSymbolsPerFile', 100);
    const symbols = (await getDocumentSymbols(document, token)).slice(0, maxSymbols);
    if (symbols.length === 0 || token.isCancellationRequested) {
      return [];
    }

    const enableTests = config.get<boolean>('enableTests', true);
    const enableOwners = config.get<boolean>('enableOwners', true);
    const testIndexPromise = enableTests ? this.services.testDiscovery.getTestIndex(token) : Promise.resolve([]);
    const ownerPromise = enableOwners && document.uri.scheme === 'file'
      ? this.services.codeownersService.getOwner(document.uri.fsPath)
      : Promise.resolve({ available: false });

    const testIndex = await testIndexPromise;
    const owner = await ownerPromise;

    return mapWithConcurrency(symbols, 4, async (symbol) => {
      const contextSymbol = toContextSymbol(document, symbol);
      const [referenceData, git] = await Promise.all([
        this.getReferenceData(document, symbol, token),
        this.getGitContext(document, symbol)
      ]);

      const tests = enableTests
        ? this.services.testDiscovery.findRelatedTests(document.uri.fsPath, symbol.name, testIndex)
        : [];

      return {
        symbol: contextSymbol,
        references: referenceData.references,
        usedBy: referenceData.usedBy,
        calls: {
          symbols: extractCallsFromSymbol(document, symbol.range, symbol.name)
        },
        git,
        tests,
        owner
      };
    });
  }

  private async getReferenceData(
    document: vscode.TextDocument,
    symbol: SymbolCandidate,
    token: vscode.CancellationToken
  ): Promise<Pick<SymbolContext, 'references' | 'usedBy'>> {
    if (!getConfig().get<boolean>('enableReferences', true) || token.isCancellationRequested) {
      return {
        references: { available: false, count: 0 },
        usedBy: { available: false, symbols: [] }
      };
    }

    try {
      const references = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        document.uri,
        symbol.range.start
      );
      if (!Array.isArray(references)) {
        return {
          references: { available: false, count: 0 },
          usedBy: { available: false, symbols: [] }
        };
      }

      return {
        references: { available: true, count: references.length },
        usedBy: {
          available: true,
          symbols: await this.getUsedBySymbols(document, symbol, references, token)
        }
      };
    } catch (error) {
      this.services.logger.appendLine(`Reference provider unavailable for ${symbol.name}: ${stringifyError(error)}`);
      return {
        references: { available: false, count: 0 },
        usedBy: { available: false, symbols: [] }
      };
    }
  }

  private async getUsedBySymbols(
    document: vscode.TextDocument,
    symbol: SymbolCandidate,
    references: vscode.Location[],
    token: vscode.CancellationToken
  ): Promise<string[]> {
    const seen = new Set<string>();
    const candidates = references
      .filter((reference) => !isInsideSymbol(document.uri, symbol.range, reference))
      .slice(0, 40);

    await mapWithConcurrency(candidates, 4, async (reference) => {
      if (token.isCancellationRequested || seen.size >= 5) {
        return;
      }

      try {
        const referenceDocument = reference.uri.toString() === document.uri.toString()
          ? document
          : await vscode.workspace.openTextDocument(reference.uri);
        const symbols = await getDocumentSymbols(referenceDocument, token);
        const container = findInnermostSymbol(symbols, reference.range.start);
        if (!container || container.name === symbol.name || seen.has(container.name)) {
          return;
        }
        seen.add(container.name);
      } catch (error) {
        this.services.logger.appendLine(`Unable to resolve reference owner for ${symbol.name}: ${stringifyError(error)}`);
      }
    });

    return Array.from(seen).slice(0, 5);
  }

  private async getGitContext(document: vscode.TextDocument, symbol: SymbolCandidate): Promise<SymbolContext['git']> {
    if (!getConfig().get<boolean>('enableGit', true) || document.uri.scheme !== 'file') {
      return { available: false };
    }

    return this.services.gitService.getLineContext(document.uri.fsPath, symbol.range.start.line + 1);
  }
}

export function formatCodeLensTitle(context: SymbolContext): string {
  return [
    `$(references) Used by: ${formatUsedByForLens(context)}`,
    `$(symbol-method) Calls: ${formatCallsForLens(context)}`,
    `$(history) Changed: ${formatLastChangedForLens(context)}`,
    `$(beaker) Tests: ${formatTestsForLens(context)}`,
    `$(organization) Owner: ${formatOwnerForLens(context)}`
  ].join(' · ');
}

function formatUsedByForLens(context: SymbolContext): string {
  if (!context.usedBy.available) {
    return 'unavailable';
  }

  return compactList(context.usedBy.symbols, 'none');
}

function formatCallsForLens(context: SymbolContext): string {
  return compactList(context.calls.symbols.map((symbol) => `${symbol}()`), 'none');
}

function formatLastChangedForLens(context: SymbolContext): string {
  if (!context.git.available || !context.git.author || !context.git.relativeDate) {
    return 'unavailable';
  }

  return `${context.git.relativeDate} by ${context.git.author}`;
}

function formatTestsForLens(context: SymbolContext): string {
  return compactList(context.tests.map((test) => path.basename(test.path)), 'none');
}

function formatOwnerForLens(context: SymbolContext): string {
  return context.owner.available && context.owner.owner ? humanizeOwner(context.owner.owner) : 'unknown';
}

function compactList(values: string[], emptyText: string): string {
  if (values.length === 0) {
    return emptyText;
  }

  const visible = values.slice(0, 3).join(', ');
  return values.length > 3 ? `${visible}, +${values.length - 3}` : visible;
}

function humanizeOwner(owner: string): string {
  return owner
    .split(',')
    .map((part) => {
      const withoutHandle = part.trim().replace(/^@/, '');
      const teamName = withoutHandle.includes('/')
        ? withoutHandle.split('/').at(-1) ?? withoutHandle
        : withoutHandle;
      return teamName
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
        .join(' ');
    })
    .filter(Boolean)
    .join(', ');
}

function isInsideSymbol(sourceUri: vscode.Uri, symbolRange: vscode.Range, reference: vscode.Location): boolean {
  return reference.uri.toString() === sourceUri.toString() && symbolRange.contains(reference.range.start);
}

function findInnermostSymbol(symbols: SymbolCandidate[], position: vscode.Position): SymbolCandidate | undefined {
  return symbols
    .filter((symbol) => symbol.range.contains(position))
    .sort((left, right) => rangeSize(left.range) - rangeSize(right.range))[0];
}

function rangeSize(range: vscode.Range): number {
  return (range.end.line - range.start.line) * 10_000 + (range.end.character - range.start.character);
}

async function getDocumentSymbols(
  document: vscode.TextDocument,
  token: vscode.CancellationToken
): Promise<SymbolCandidate[]> {
  try {
    const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    );
    if (!symbols || token.isCancellationRequested) {
      return [];
    }

    return flattenSymbols(symbols);
  } catch {
    return [];
  }
}

function flattenSymbols(symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>): SymbolCandidate[] {
  const flattened: SymbolCandidate[] = [];
  for (const symbol of symbols) {
    if (isDocumentSymbol(symbol)) {
      collectDocumentSymbol(symbol, flattened);
      continue;
    }

    if (SUPPORTED_SYMBOL_KINDS.has(symbol.kind)) {
      flattened.push({
        name: symbol.name,
        kind: symbol.kind,
        range: symbol.location.range
      });
    }
  }
  return flattened;
}

function collectDocumentSymbol(symbol: vscode.DocumentSymbol, target: SymbolCandidate[]): void {
  if (SUPPORTED_SYMBOL_KINDS.has(symbol.kind)) {
    target.push({
      name: symbol.name,
      kind: symbol.kind,
      range: symbol.range
    });
  }

  for (const child of symbol.children) {
    collectDocumentSymbol(child, target);
  }
}

function isDocumentSymbol(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): symbol is vscode.DocumentSymbol {
  return 'children' in symbol && Array.isArray(symbol.children);
}

function toContextSymbol(document: vscode.TextDocument, symbol: SymbolCandidate): ContextSymbol {
  return {
    name: symbol.name,
    kind: vscode.SymbolKind[symbol.kind],
    filePath: document.uri.fsPath,
    uri: document.uri.toString(),
    line: symbol.range.start.line + 1,
    range: toRangeData(symbol.range)
  };
}

function toRangeData(range: vscode.Range): RangeData {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character }
  };
}

function toVscodeRange(range: RangeData): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character
  );
}

function rangeDataSize(range: RangeData): number {
  return (range.end.line - range.start.line) * 10_000 + (range.end.character - range.start.character);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= values.length) {
        return;
      }
      results[currentIndex] = await mapper(values[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('contextLens');
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
