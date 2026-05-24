import path from 'path';
import * as vscode from 'vscode';
import { CodeownersService } from './codeowners';
import { GitService } from './gitService';
import { extractCallsFromSymbol, findCallCharactersInLine, getSymbolIdentifier } from './symbolAnalysis';
import { TestDiscovery } from './testDiscovery';
import { ContextSymbol, OutputLogger, RangeData, SymbolContext, UsageContext, UsageSite } from './types';
import {
  dedupeUsageSites,
  formatUsageSiteLabel,
  isPositionInsideRange,
  UsageSiteCollection,
  usageSitesToSymbols
} from './usageSites';

interface SymbolCandidate {
  name: string;
  kind: vscode.SymbolKind;
  range: vscode.Range;
  selectionRange: vscode.Range;
}

interface PerryProviderServices {
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
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Module
]);
const MAX_REFERENCE_USAGE_SITES = 50;
const MAX_TEXT_SCAN_FILES = 1000;
const TEXT_SCAN_FILE_PATTERNS = new Map<string, string>([
  ['go', '**/*.go'],
  ['java', '**/*.java'],
  ['python', '**/*.py']
]);

export class PerryProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly cache = new Map<string, Promise<SymbolContext[]>>();
  private readonly scanFileCache = new Map<string, Promise<vscode.Uri[]>>();

  public readonly onDidChangeCodeLenses = this.changeEmitter.event;

  public constructor(private readonly services: PerryProviderServices) {}

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
          command: 'perry.showDetails',
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
    this.scanFileCache.clear();
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
      .filter((context) => getSymbolSelectionRange(context).contains(position))
      .sort((left, right) => rangeDataSize(left.symbol.selectionRange ?? left.symbol.range) - rangeDataSize(right.symbol.selectionRange ?? right.symbol.range))[0];
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
        getReferencePosition(symbol)
      );
      if (!Array.isArray(references)) {
        const fallbackUsedBy = await this.getTextScanUsageSites(document, symbol, token);
        if (fallbackUsedBy.sites.length > 0) {
          return {
            references: { available: true, count: fallbackUsedBy.sites.length },
            usedBy: buildUsageContext(fallbackUsedBy)
          };
        }

        return {
          references: { available: false, count: 0 },
          usedBy: { available: false, symbols: [] }
        };
      }

      const referenceSites = await this.getReferenceUsageSites(document, symbol, references, token);
      const scanSites = await this.getTextScanUsageSites(document, symbol, token);
      const usageSites = dedupeUsageSites(
        [...referenceSites.sites, ...scanSites.sites],
        MAX_REFERENCE_USAGE_SITES
      );
      const resolvedUsedBy = {
        sites: usageSites.sites,
        truncated: referenceSites.truncated || scanSites.truncated || usageSites.truncated
      };

      return {
        references: { available: true, count: Math.max(references.length, resolvedUsedBy.sites.length) },
        usedBy: buildUsageContext(resolvedUsedBy)
      };
    } catch (error) {
      const fallbackUsedBy = await this.getTextScanUsageSites(document, symbol, token);
      if (fallbackUsedBy.sites.length > 0) {
        return {
          references: { available: true, count: fallbackUsedBy.sites.length },
          usedBy: buildUsageContext(fallbackUsedBy)
        };
      }

      this.services.logger.appendLine(`Reference provider unavailable for ${symbol.name}: ${stringifyError(error)}`);
      return {
        references: { available: false, count: 0 },
        usedBy: { available: false, symbols: [] }
      };
    }
  }

  private async getReferenceUsageSites(
    document: vscode.TextDocument,
    symbol: SymbolCandidate,
    references: vscode.Location[],
    token: vscode.CancellationToken
  ): Promise<UsageSiteCollection> {
    const candidates = references
      .filter((reference) => !isInsideSymbol(document.uri, symbol.range, reference))
      .slice(0, MAX_REFERENCE_USAGE_SITES);

    const sites = await mapWithConcurrency(candidates, 4, async (reference) => {
      if (token.isCancellationRequested) {
        return undefined;
      }

      try {
        const referenceDocument = reference.uri.toString() === document.uri.toString()
          ? document
          : await vscode.workspace.openTextDocument(reference.uri);
        const symbols = await getDocumentSymbols(referenceDocument, token);
        const container = findInnermostSymbol(symbols, reference.range.start);
        return buildUsageSite(referenceDocument, reference.range.start, container, 'language-server');
      } catch (error) {
        this.services.logger.appendLine(`Unable to resolve reference owner for ${symbol.name}: ${stringifyError(error)}`);
        return undefined;
      }
    });

    const collection = dedupeUsageSites(
      sites.filter((site): site is UsageSite => Boolean(site)),
      MAX_REFERENCE_USAGE_SITES
    );
    return {
      sites: collection.sites,
      truncated: references.length > candidates.length || collection.truncated
    };
  }

  private async getTextScanUsageSites(
    document: vscode.TextDocument,
    symbol: SymbolCandidate,
    token: vscode.CancellationToken
  ): Promise<UsageSiteCollection> {
    if (!shouldUseTextScan(document)) {
      return { sites: [], truncated: false };
    }

    const identifier = getSymbolIdentifier(symbol.name);
    if (!identifier) {
      return { sites: [], truncated: false };
    }

    try {
      const files = await this.getTextScanFiles(document.languageId, token);
      const collections = await mapWithConcurrency(files, 6, async (uri) => {
        if (token.isCancellationRequested) {
          return { sites: [], truncated: false };
        }

        const referenceDocument = uri.toString() === document.uri.toString()
          ? document
          : await vscode.workspace.openTextDocument(uri);
        const matches: UsageSite[] = [];
        let truncated = false;
        const symbols = await getDocumentSymbols(referenceDocument, token);

        for (let lineNumber = 0; lineNumber < referenceDocument.lineCount; lineNumber += 1) {
          if (matches.length >= MAX_REFERENCE_USAGE_SITES || token.isCancellationRequested) {
            truncated = matches.length >= MAX_REFERENCE_USAGE_SITES;
            break;
          }

          const lineText = referenceDocument.lineAt(lineNumber).text;
          const callCharacters = findCallCharactersInLine(lineText, identifier, document.languageId);
          for (const character of callCharacters) {
            if (matches.length >= MAX_REFERENCE_USAGE_SITES || token.isCancellationRequested) {
              truncated = matches.length >= MAX_REFERENCE_USAGE_SITES;
              break;
            }

            const position = new vscode.Position(lineNumber, character);
            if (isInsideRange(referenceDocument.uri, symbol.range, document.uri, position)) {
              continue;
            }

            const container = findInnermostSymbol(symbols, position);
            matches.push(buildUsageSite(referenceDocument, position, container, 'text-scan'));
          }
        }

        return { sites: matches, truncated };
      });

      const collection = dedupeUsageSites(
        collections.flatMap((item) => item.sites),
        MAX_REFERENCE_USAGE_SITES
      );
      return {
        sites: collection.sites,
        truncated: collections.some((item) => item.truncated) || collection.truncated
      };
    } catch (error) {
      this.services.logger.appendLine(`Text call-site scan failed for ${symbol.name}: ${stringifyError(error)}`);
      return { sites: [], truncated: false };
    }
  }

  private getTextScanFiles(languageId: string, token: vscode.CancellationToken): Promise<vscode.Uri[]> {
    const cached = this.scanFileCache.get(languageId);
    if (cached) {
      return cached;
    }

    const includePattern = TEXT_SCAN_FILE_PATTERNS.get(languageId);
    if (!includePattern) {
      return Promise.resolve([]);
    }

    const promise = Promise.resolve(vscode.workspace.findFiles(includePattern, undefined, MAX_TEXT_SCAN_FILES, token))
      .then((files) => files.filter((uri) => !isIgnoredScanPath(uri.fsPath)));
    this.scanFileCache.set(languageId, promise);
    return promise;
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

function getReferencePosition(symbol: SymbolCandidate): vscode.Position {
  const range = symbol.selectionRange;
  if (range.start.line !== range.end.line || range.start.character >= range.end.character) {
    return range.start;
  }

  return new vscode.Position(
    range.start.line,
    range.start.character + Math.floor((range.end.character - range.start.character) / 2)
  );
}

function getSymbolSelectionRange(context: SymbolContext): vscode.Range {
  return toVscodeRange(context.symbol.selectionRange ?? context.symbol.range);
}

function buildUsageContext(collection: UsageSiteCollection): UsageContext {
  return {
    available: true,
    symbols: usageSitesToSymbols(collection.sites),
    sites: collection.sites,
    truncated: collection.truncated
  };
}

function buildUsageSite(
  document: vscode.TextDocument,
  position: vscode.Position,
  container: SymbolCandidate | undefined,
  source: UsageSite['source']
): UsageSite {
  const relativePath = vscode.workspace.asRelativePath(document.uri, false);
  const location = `${relativePath}:${position.line + 1}`;
  const containerName = container?.name;
  return {
    label: formatUsageSiteLabel(location, containerName),
    uri: document.uri.toString(),
    path: document.uri.fsPath,
    line: position.line + 1,
    character: position.character,
    containerName,
    source
  };
}

function shouldUseTextScan(document: vscode.TextDocument): boolean {
  return document.uri.scheme === 'file' && TEXT_SCAN_FILE_PATTERNS.has(document.languageId);
}

function isIgnoredScanPath(filePath: string): boolean {
  return filePath
    .split(/[\\/]+/)
    .some((part) => ['.git', '.gradle', 'node_modules', 'dist', 'out', 'build', 'target', '.venv', 'venv', '__pycache__'].includes(part));
}

function isInsideSymbol(sourceUri: vscode.Uri, symbolRange: vscode.Range, reference: vscode.Location): boolean {
  return reference.uri.toString() === sourceUri.toString() && symbolRange.contains(reference.range.start);
}

function isInsideRange(
  referenceUri: vscode.Uri,
  symbolRange: vscode.Range,
  sourceUri: vscode.Uri,
  position: vscode.Position
): boolean {
  return referenceUri.toString() === sourceUri.toString() &&
    isPositionInsideRange(toRangeData(symbolRange), position.line, position.character);
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

    return flattenSymbols(document, symbols);
  } catch {
    return [];
  }
}

function flattenSymbols(document: vscode.TextDocument, symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>): SymbolCandidate[] {
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
        range: symbol.location.range,
        selectionRange: findSymbolNameRange(document, symbol.location.range, symbol.name) ?? symbol.location.range
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
      range: symbol.range,
      selectionRange: symbol.selectionRange
    });
  }

  for (const child of symbol.children) {
    collectDocumentSymbol(child, target);
  }
}

function isDocumentSymbol(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): symbol is vscode.DocumentSymbol {
  return 'children' in symbol && Array.isArray(symbol.children);
}

function findSymbolNameRange(
  document: vscode.TextDocument,
  range: vscode.Range,
  symbolName: string
): vscode.Range | undefined {
  const identifier = getSymbolIdentifier(symbolName);
  if (!identifier) {
    return undefined;
  }

  const namePattern = new RegExp(`\\b${escapeRegExp(identifier)}\\b`);
  const endLine = Math.min(document.lineCount - 1, range.start.line + 5);
  for (let lineNumber = range.start.line; lineNumber <= endLine; lineNumber += 1) {
    const lineText = document.lineAt(lineNumber).text;
    const match = namePattern.exec(lineText);
    if (!match) {
      continue;
    }

    return new vscode.Range(
      lineNumber,
      match.index,
      lineNumber,
      match.index + identifier.length
    );
  }

  return undefined;
}

function toContextSymbol(document: vscode.TextDocument, symbol: SymbolCandidate): ContextSymbol {
  return {
    name: symbol.name,
    kind: vscode.SymbolKind[symbol.kind],
    filePath: document.uri.fsPath,
    uri: document.uri.toString(),
    line: symbol.range.start.line + 1,
    range: toRangeData(symbol.range),
    selectionRange: toRangeData(symbol.selectionRange)
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
  return vscode.workspace.getConfiguration('perry');
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}
