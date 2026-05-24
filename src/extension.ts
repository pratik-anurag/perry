import path from 'path';
import * as vscode from 'vscode';
import { CodeownersService } from './codeowners';
import { PerryHoverProvider } from './perryHoverProvider';
import { PerryProvider } from './perryProvider';
import { GitService } from './gitService';
import { TestDiscovery } from './testDiscovery';
import { SymbolContext, UsageSite } from './types';

interface PerryRuntime {
  output: vscode.OutputChannel;
  gitService: GitService;
  testDiscovery: TestDiscovery;
  codeownersService: CodeownersService;
  workspaceRoots: string[];
  activeDisposables: vscode.Disposable[];
  activation: ActivationDiagnostics;
  lastStart: StartDiagnostics | undefined;
  started: boolean;
  starting: boolean;
  stopping: boolean;
}

interface ActivationDiagnostics {
  durationMs: number;
  heapDeltaBytes: number;
  memoryAfter: NodeJS.MemoryUsage;
}

interface StartDiagnostics {
  durationMs: number;
  heapDeltaBytes: number;
  memoryAfter: NodeJS.MemoryUsage;
}

let provider: PerryProvider | undefined;
let runtime: PerryRuntime | undefined;

const selectors: vscode.DocumentSelector = [
  { language: 'typescript', scheme: 'file' },
  { language: 'javascript', scheme: 'file' },
  { language: 'typescriptreact', scheme: 'file' },
  { language: 'javascriptreact', scheme: 'file' },
  { language: 'python', scheme: 'file' },
  { language: 'go', scheme: 'file' },
  { language: 'java', scheme: 'file' }
];
const watcherDebounceMs = 250;
const perryCommandAllowlist = [
  'perry.showDetails',
  'perry.revealReferences',
  'perry.openTestFile',
  'perry.openUsageSite'
] as const;

export function activate(context: vscode.ExtensionContext): void {
  const activationStartedAt = performance.now();
  const memoryBefore = process.memoryUsage();
  const output = vscode.window.createOutputChannel('Perry');
  const workspaceRoots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  const gitService = new GitService(output);
  const testDiscovery = new TestDiscovery(vscode, output);
  const codeownersService = new CodeownersService(workspaceRoots, output);
  const memoryAfter = process.memoryUsage();

  runtime = {
    output,
    gitService,
    testDiscovery,
    codeownersService,
    workspaceRoots,
    activeDisposables: [],
    activation: {
      durationMs: performance.now() - activationStartedAt,
      heapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
      memoryAfter
    },
    lastStart: undefined,
    started: false,
    starting: false,
    stopping: false
  };

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('perry.start', async () => {
      await startPerry(getRuntime());
    }),
    vscode.commands.registerCommand('perry.stop', async () => {
      await stopPerry(getRuntime());
    }),
    vscode.commands.registerCommand('perry.refresh', () => {
      const currentRuntime = getRuntime();
      if (!currentRuntime.started) {
        vscode.window.showInformationMessage('Perry is stopped. Run "Perry: Start" to enable annotations.');
        return;
      }
      clearAllCaches(provider, currentRuntime.gitService, currentRuntime.testDiscovery, currentRuntime.codeownersService);
      vscode.window.showInformationMessage('Perry refreshed.');
    }),
    vscode.commands.registerCommand('perry.toggle', async () => {
      const currentRuntime = getRuntime();
      if (currentRuntime.started) {
        await stopPerry(currentRuntime);
      } else {
        await startPerry(currentRuntime);
      }
    }),
    vscode.commands.registerCommand('perry.showDiagnostics', () => {
      showDiagnostics(getRuntime());
    }),
    vscode.commands.registerCommand('perry.showDetails', (symbolContext?: SymbolContext) => {
      const currentRuntime = getRuntime();
      if (!currentRuntime.started || !vscode.workspace.isTrusted) {
        vscode.window.showInformationMessage('Start Perry in a trusted workspace before opening details.');
        return;
      }
      if (!isSymbolContext(symbolContext) || !isWorkspaceSymbolContext(symbolContext, currentRuntime.workspaceRoots)) {
        vscode.window.showInformationMessage('Start Perry, then open a Perry item from a supported source file to view details.');
        return;
      }
      showDetailsPanel(symbolContext);
    }),
    vscode.commands.registerCommand('perry.revealReferences', async (symbolContext?: SymbolContext) => {
      const currentRuntime = getRuntime();
      if (!currentRuntime.started || !vscode.workspace.isTrusted) {
        return;
      }
      if (!isSymbolContext(symbolContext) || !isWorkspaceSymbolContext(symbolContext, currentRuntime.workspaceRoots)) {
        return;
      }
      await revealReferences(symbolContext);
    }),
    vscode.commands.registerCommand('perry.openTestFile', async (filePath?: string) => {
      const currentRuntime = getRuntime();
      if (!currentRuntime.started || !vscode.workspace.isTrusted || typeof filePath !== 'string') {
        return;
      }
      if (!isPathInsideWorkspace(filePath, currentRuntime.workspaceRoots)) {
        vscode.window.showWarningMessage('Perry only opens related test files from the current workspace.');
        return;
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(document, vscode.ViewColumn.Active);
    }),
    vscode.commands.registerCommand('perry.openUsageSite', async (site?: UsageSite) => {
      const currentRuntime = getRuntime();
      if (!currentRuntime.started || !vscode.workspace.isTrusted || !isUsageSite(site)) {
        return;
      }
      if (!isWorkspaceUsageSite(site, currentRuntime.workspaceRoots)) {
        vscode.window.showWarningMessage('Perry only opens usage sites from the current workspace.');
        return;
      }
      await openUsageSite(site);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      const currentRuntime = getRuntime();
      if (event.affectsConfiguration('perry') && currentRuntime.started) {
        clearAllCaches(provider, currentRuntime.gitService, currentRuntime.testDiscovery, currentRuntime.codeownersService);
      }
    })
  );

  const currentRuntime = runtime;
  output.appendLine(
    `Perry command layer activated in ${formatDuration(currentRuntime.activation.durationMs)}. ` +
    `Extension host memory: ${formatBytes(currentRuntime.activation.memoryAfter.rss)} RSS, ` +
    `${formatBytes(currentRuntime.activation.memoryAfter.heapUsed)} heap used ` +
    `(${formatSignedBytes(currentRuntime.activation.heapDeltaBytes)} heap delta).`
  );
  output.appendLine('Perry is dormant until you run "Perry: Start" or "Perry: Toggle".');
}

export function deactivate(): void {
  if (runtime?.started) {
    disposeActiveRuntime(runtime);
  }
  provider = undefined;
  runtime = undefined;
}

async function startPerry(currentRuntime: PerryRuntime): Promise<void> {
  if (currentRuntime.started || currentRuntime.starting) {
    vscode.window.showInformationMessage('Perry is already running.');
    return;
  }

  if (!vscode.workspace.isTrusted) {
    currentRuntime.output.appendLine('Perry start blocked because the workspace is not trusted.');
    vscode.window.showWarningMessage('Perry requires a trusted workspace before it can scan files or run Git.');
    return;
  }

  currentRuntime.starting = true;
  try {
    const startStartedAt = performance.now();
    const startMemoryBefore = process.memoryUsage();
    provider = new PerryProvider({
      gitService: currentRuntime.gitService,
      testDiscovery: currentRuntime.testDiscovery,
      codeownersService: currentRuntime.codeownersService,
      logger: currentRuntime.output
    });
    const hoverProvider = new PerryHoverProvider(provider, currentRuntime.output);

    currentRuntime.activeDisposables.push(
      vscode.languages.registerCodeLensProvider(selectors, provider),
      vscode.languages.registerHoverProvider(selectors, hoverProvider),
      vscode.languages.registerDocumentLinkProvider(selectors, hoverProvider),
      vscode.workspace.onDidSaveTextDocument(() => provider?.clearCache())
    );

    let cacheClearTimer: NodeJS.Timeout | undefined;
    const clearCaches = () => {
      clearAllCaches(provider, currentRuntime.gitService, currentRuntime.testDiscovery, currentRuntime.codeownersService);
    };
    const scheduleCacheClear = () => {
      if (cacheClearTimer) {
        clearTimeout(cacheClearTimer);
      }
      cacheClearTimer = setTimeout(() => {
        cacheClearTimer = undefined;
        clearCaches();
      }, watcherDebounceMs);
    };
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    currentRuntime.activeDisposables.push(
      watcher,
      watcher.onDidCreate(() => {
        scheduleCacheClear();
      }),
      watcher.onDidChange(() => {
        scheduleCacheClear();
      }),
      watcher.onDidDelete(() => {
        scheduleCacheClear();
      }),
      new vscode.Disposable(() => {
        if (cacheClearTimer) {
          clearTimeout(cacheClearTimer);
        }
      })
    );

    const startMemoryAfter = process.memoryUsage();
    currentRuntime.lastStart = {
      durationMs: performance.now() - startStartedAt,
      heapDeltaBytes: startMemoryAfter.heapUsed - startMemoryBefore.heapUsed,
      memoryAfter: startMemoryAfter
    };
    currentRuntime.started = true;
    currentRuntime.output.appendLine(
      `Perry started in ${formatDuration(currentRuntime.lastStart.durationMs)} ` +
      `(${formatSignedBytes(currentRuntime.lastStart.heapDeltaBytes)} heap delta).`
    );
    vscode.window.showInformationMessage('Perry started.');
  } finally {
    currentRuntime.starting = false;
  }
}

async function stopPerry(currentRuntime: PerryRuntime): Promise<void> {
  if (!currentRuntime.started || currentRuntime.stopping) {
    vscode.window.showInformationMessage('Perry is already stopped.');
    return;
  }

  currentRuntime.stopping = true;
  try {
    disposeActiveRuntime(currentRuntime);
    currentRuntime.output.appendLine('Perry stopped.');
    vscode.window.showInformationMessage('Perry stopped.');
  } finally {
    currentRuntime.stopping = false;
  }
}

function disposeActiveRuntime(currentRuntime: PerryRuntime): void {
  for (const disposable of currentRuntime.activeDisposables.splice(0)) {
    disposable.dispose();
  }
  provider = undefined;
  currentRuntime.started = false;
  clearAllCaches(
    undefined,
    currentRuntime.gitService,
    currentRuntime.testDiscovery,
    currentRuntime.codeownersService
  );
}

function getRuntime(): PerryRuntime {
  if (!runtime) {
    throw new Error('Perry runtime is not available.');
  }
  return runtime;
}

function clearAllCaches(
  perryProvider: PerryProvider | undefined,
  gitService: GitService,
  testDiscovery: TestDiscovery,
  codeownersService: CodeownersService
): void {
  gitService.clearCache();
  testDiscovery.clearCache();
  codeownersService.clearCache();
  perryProvider?.clearCache();
}

function showDiagnostics(currentRuntime: PerryRuntime): void {
  const currentMemory = process.memoryUsage();
  const startDuration = currentRuntime.lastStart
    ? formatDuration(currentRuntime.lastStart.durationMs)
    : 'not started in this session';
  const startHeapDelta = currentRuntime.lastStart
    ? formatSignedBytes(currentRuntime.lastStart.heapDeltaBytes)
    : 'not available';
  const lines = [
    'Perry Diagnostics',
    `State: ${currentRuntime.started ? 'running' : 'stopped'}`,
    `Command-layer activation time: ${formatDuration(currentRuntime.activation.durationMs)}`,
    `Command-layer activation heap delta: ${formatSignedBytes(currentRuntime.activation.heapDeltaBytes)}`,
    `Last Perry start time: ${startDuration}`,
    `Last Perry start heap delta: ${startHeapDelta}`,
    `Current extension host RSS: ${formatBytes(currentMemory.rss)}`,
    `Current extension host heap used: ${formatBytes(currentMemory.heapUsed)}`,
    `Current extension host heap total: ${formatBytes(currentMemory.heapTotal)}`,
    'Note: VS Code runs extensions in a shared extension host, so memory is process-level rather than exact Perry-only memory.'
  ];

  currentRuntime.output.appendLine('');
  for (const line of lines) {
    currentRuntime.output.appendLine(line);
  }
  currentRuntime.output.show(true);
  vscode.window.showInformationMessage(
    `Perry is ${currentRuntime.started ? 'running' : 'stopped'}; activation ${formatDuration(currentRuntime.activation.durationMs)}, ` +
    `host heap ${formatBytes(currentMemory.heapUsed)}.`
  );
}

function formatDuration(valueMs: number): string {
  return `${valueMs.toFixed(valueMs < 10 ? 1 : 0)} ms`;
}

function formatBytes(valueBytes: number): string {
  return `${(valueBytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatSignedBytes(valueBytes: number): string {
  return `${valueBytes >= 0 ? '+' : '-'}${formatBytes(Math.abs(valueBytes))}`;
}

function showDetailsPanel(context: SymbolContext): void {
  const panel = vscode.window.createWebviewPanel(
    'perryDetails',
    `Perry: ${context.symbol.name}`,
    vscode.ViewColumn.Beside,
    {
      enableCommandUris: perryCommandAllowlist
    }
  );

  panel.webview.html = buildDetailsHtml(context);
}

function buildDetailsHtml(context: SymbolContext): string {
  const references = context.references.available ? String(context.references.count) : 'unavailable';
  const usedBy = context.usedBy.available
    ? context.usedBy.symbols.length > 0 ? context.usedBy.symbols.join(', ') : 'none'
    : 'unavailable';
  const calls = context.calls.symbols.length > 0
    ? context.calls.symbols.map((symbol) => `${symbol}()`).join(', ')
    : 'none';
  const gitAuthor = context.git.available ? context.git.author ?? 'unknown' : 'unavailable';
  const gitDate = context.git.available ? context.git.relativeDate ?? 'unknown' : 'unavailable';
  const owner = context.owner.available ? context.owner.owner ?? 'unknown' : 'unknown';
  const revealUri = createCommandUri('perry.revealReferences', context);
  const location = `${context.symbol.filePath}:${context.symbol.line}`;
  const usedByList = context.usedBy.available
    ? renderUsageSiteList(context.usedBy.sites, context.usedBy.symbols, context.usedBy.truncated)
    : '<p class="empty">References unavailable.</p>';
  const callList = renderList(context.calls.symbols.map((symbol) => `${symbol}()`), 'No calls detected.');
  const testList = context.tests.length > 0
    ? context.tests
      .map((test) => {
        const commandUri = createOpenFileCommandUri(test.path);
        return `<li><a href="${commandUri}">${escapeHtml(test.path)}</a></li>`;
      })
      .join('')
    : '<li class="empty">No related tests found.</li>';
  const summaryRows = [
    ['References', references],
    ['Used by', context.usedBy.available ? String(context.usedBy.symbols.length) : 'unavailable'],
    ['Last changed', gitDate],
    ['Owner', owner]
  ];
  const detailRows = [
    ['Kind', context.symbol.kind],
    ['File', context.symbol.filePath],
    ['Line', String(context.symbol.line)],
    ['Reference count', references],
    ['Used by', usedBy],
    ['Calls', calls],
    ['Last Git author', gitAuthor],
    ['Last Git date', gitDate],
    ['CODEOWNERS owner', owner]
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none';">
  <title>Perry Details</title>
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 0;
      line-height: 1.45;
    }
    * {
      box-sizing: border-box;
    }
    .shell {
      max-width: 1040px;
      margin: 0 auto;
      padding: 28px;
    }
    .hero {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background:
        linear-gradient(135deg, color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent), transparent 44%),
        var(--vscode-editorWidget-background);
      margin-bottom: 16px;
      padding: 20px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.18);
    }
    .hero::before {
      content: "";
      position: absolute;
      inset: 0;
      border-top: 3px solid var(--vscode-focusBorder);
      pointer-events: none;
    }
    .hero-main {
      position: relative;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 16px;
      align-items: center;
    }
    .symbol-mark {
      display: grid;
      width: 54px;
      height: 54px;
      place-items: center;
      border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 58%, var(--vscode-panel-border));
      border-radius: 8px;
      background: color-mix(in srgb, var(--vscode-focusBorder) 18%, var(--vscode-editor-background));
      color: var(--vscode-focusBorder);
      font-size: 1.45rem;
      font-weight: 700;
    }
    .hero-copy {
      min-width: 0;
    }
    h1 {
      font-size: 1.7rem;
      line-height: 1.15;
      margin: 0 0 6px;
      word-break: break-word;
    }
    .subtitle, .muted {
      color: var(--vscode-descriptionForeground);
    }
    .subtitle {
      word-break: break-word;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9rem;
    }
    .eyebrow {
      color: var(--vscode-descriptionForeground);
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0;
      margin-bottom: 4px;
      text-transform: uppercase;
    }
    .hero-footer {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 18px;
      padding-top: 14px;
      border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
    }
    .badges {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 25px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      padding: 3px 9px;
      background: color-mix(in srgb, var(--vscode-editor-background) 64%, transparent);
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .badge::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--vscode-descriptionForeground);
    }
    .badge.good::before {
      background: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
    }
    .badge.warning::before {
      background: var(--vscode-testing-iconQueued, var(--vscode-charts-yellow));
    }
    .badge.accent::before {
      background: var(--vscode-focusBorder);
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin: 16px 0;
    }
    .metric {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 13px 14px;
      background: var(--vscode-editorWidget-background);
      box-shadow: 0 1px 0 rgba(0, 0, 0, 0.08);
    }
    .metric::before {
      content: "";
      position: absolute;
      inset: 0 auto 0 0;
      width: 3px;
      background: var(--vscode-descriptionForeground);
    }
    .metric.accent::before {
      background: var(--vscode-focusBorder);
    }
    .metric.good::before {
      background: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
    }
    .metric.warning::before {
      background: var(--vscode-testing-iconQueued, var(--vscode-charts-yellow));
    }
    .metric.muted::before {
      background: var(--vscode-panel-border);
    }
    .metric-label {
      color: var(--vscode-descriptionForeground);
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0;
      margin-bottom: 6px;
      text-transform: uppercase;
    }
    .metric-value {
      font-size: 1.15rem;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .metric-meta {
      color: var(--vscode-descriptionForeground);
      font-size: 0.82rem;
      margin-top: 3px;
      min-height: 1.2em;
    }
    .content-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr);
      gap: 14px;
      align-items: start;
    }
    .stack {
      display: grid;
      gap: 14px;
    }
    .card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-editorWidget-background);
      overflow: hidden;
    }
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: color-mix(in srgb, var(--vscode-sideBar-background) 42%, transparent);
    }
    h2 {
      font-size: 1rem;
      margin: 0;
    }
    .card-body {
      padding: 14px;
    }
    .count-pill {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.78rem;
      padding: 2px 8px;
      white-space: nowrap;
    }
    .chips {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .chip {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 5px 9px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      max-width: 100%;
      overflow-wrap: anywhere;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: minmax(130px, 0.36fr) minmax(0, 1fr);
    }
    .detail-label,
    .detail-value {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 9px 0;
      min-width: 0;
    }
    .detail-label {
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
      padding-right: 14px;
    }
    .detail-value {
      overflow-wrap: anywhere;
    }
    .detail-label:nth-last-child(2),
    .detail-value:last-child {
      border-bottom: 0;
    }
    a {
      color: var(--vscode-textLink-foreground);
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .button {
      display: inline-flex;
      align-items: center;
      min-height: 30px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      text-decoration: none;
      padding: 6px 12px;
      border-radius: 4px;
      font-weight: 600;
    }
    .button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .test-link {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 9px;
      align-items: start;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 9px 0;
      text-decoration: none;
      overflow-wrap: anywhere;
    }
    .test-link:hover span:last-child {
      text-decoration: underline;
    }
    .test-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
      margin-top: 6px;
    }
    li:last-child .test-link {
      border-bottom: 0;
    }
    .empty-row {
      color: var(--vscode-descriptionForeground);
      padding: 9px 0;
    }
    @media (max-width: 820px) {
      .summary-grid,
      .content-grid {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 560px) {
      .shell {
        padding: 16px;
      }
      .hero-main {
        grid-template-columns: 1fr;
      }
      .symbol-mark {
        width: 44px;
        height: 44px;
      }
      .hero-footer {
        align-items: flex-start;
        flex-direction: column;
      }
      .detail-grid {
        grid-template-columns: 1fr;
      }
      .detail-label {
        border-bottom: 0;
        padding-bottom: 0;
      }
      .detail-value {
        padding-top: 3px;
      }
    }
    body {
      margin: 0;
      line-height: 1.5;
      padding: 0;
    }
    .shell {
      max-width: 880px;
      margin: 0;
      padding: 22px;
    }
    header {
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 18px;
      padding-bottom: 16px;
    }
    section {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 16px 0;
    }
    h1 {
      font-size: 1.45rem;
      font-weight: 600;
      line-height: 1.2;
      margin: 2px 0 6px;
    }
    h2 {
      font-size: 0.9rem;
      font-weight: 600;
      margin: 0 0 10px;
    }
    .kicker,
    .meta,
    .label,
    dt,
    .empty {
      color: var(--vscode-descriptionForeground);
    }
    .kicker {
      font-size: 0.78rem;
      font-weight: 600;
    }
    .meta {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9rem;
      margin: 0;
      word-break: break-word;
    }
    .summary {
      display: grid;
      gap: 12px 24px;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      margin-bottom: 2px;
    }
    .value {
      font-weight: 600;
      margin-top: 2px;
      overflow-wrap: anywhere;
    }
    .button {
      background: var(--vscode-button-secondaryBackground);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      color: var(--vscode-button-secondaryForeground);
      font-weight: 400;
      margin-top: 12px;
      min-height: 28px;
      padding: 4px 10px;
    }
    .button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    li {
      overflow-wrap: anywhere;
      padding: 3px 0;
    }
    dl {
      display: grid;
      gap: 8px 18px;
      grid-template-columns: minmax(120px, 0.28fr) minmax(0, 1fr);
      margin: 0;
    }
    dt,
    dd {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 9px 0;
      overflow-wrap: anywhere;
    }
    dd {
      margin: 0;
    }
    dt:nth-last-child(2),
    dd:last-child {
      border-bottom: 0;
    }
    @media (max-width: 560px) {
      .summary,
      dl {
        grid-template-columns: 1fr;
      }
      dt {
        border-bottom: 0;
        padding-bottom: 0;
      }
      dd {
        padding-top: 3px;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="kicker">${escapeHtml(context.symbol.kind)}</div>
      <h1>${escapeHtml(context.symbol.name)}</h1>
      <p class="meta">${escapeHtml(location)}</p>
      <a class="button" href="${revealUri}">Reveal References</a>
    </header>

    <section class="summary">
      ${summaryRows.map(([label, value]) => `<div><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`).join('')}
    </section>

    <section>
      <h2>Used By</h2>
      ${usedByList}
    </section>

    <section>
      <h2>Calls</h2>
      ${callList}
    </section>

    <section>
      <h2>Related Tests</h2>
      <ul>${testList}</ul>
    </section>

    <section>
      <h2>Details</h2>
      <dl>
        ${detailRows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}
      </dl>
    </section>
  </div>
</body>
</html>`;
}

async function revealReferences(context: SymbolContext): Promise<void> {
  const uri = vscode.Uri.parse(context.symbol.uri);
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  const range = context.symbol.selectionRange ?? context.symbol.range;
  const position = new vscode.Position(range.start.line, range.start.character);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  await vscode.commands.executeCommand('editor.action.referenceSearch.trigger');
}

async function openUsageSite(site: UsageSite): Promise<void> {
  const uri = vscode.Uri.parse(site.uri);
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.Active);
  const lineNumber = Math.min(site.line - 1, Math.max(document.lineCount - 1, 0));
  const line = document.lineAt(lineNumber);
  const character = Math.min(site.character, line.range.end.character);
  const position = new vscode.Position(lineNumber, character);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function createOpenFileCommandUri(filePath: string): string {
  return createCommandUri('perry.openTestFile', filePath);
}

function createUsageSiteCommandUri(site: UsageSite): string {
  return createCommandUri('perry.openUsageSite', site);
}

function createCommandUri(command: string, argument: unknown): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([argument]))}`;
}

function renderUsageSiteList(sites: UsageSite[] | undefined, fallbackSymbols: string[], truncated: boolean | undefined): string {
  if (!sites || sites.length === 0) {
    return renderList(fallbackSymbols, 'No callers found.');
  }

  const rows = sites
    .map((site) => `<li><a href="${createUsageSiteCommandUri(site)}">${escapeHtml(site.label)}</a></li>`)
    .join('');
  const truncationNote = truncated
    ? '<p class="empty">Showing first 50 usage sites.</p>'
    : '';
  return `<ul>${rows}</ul>${truncationNote}`;
}

function renderList(values: string[], emptyText: string): string {
  if (values.length === 0) {
    return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  }

  return `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join('')}</ul>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}

function isSymbolContext(value: unknown): value is SymbolContext {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as SymbolContext;
  return (
    isContextSymbol(candidate.symbol) &&
    isReferenceContext(candidate.references) &&
    isUsageContext(candidate.usedBy) &&
    isCallsContext(candidate.calls) &&
    isGitContext(candidate.git) &&
    Array.isArray(candidate.tests) &&
    candidate.tests.every(isRelatedTest) &&
    isOwnerContext(candidate.owner)
  );
}

function isWorkspaceSymbolContext(context: SymbolContext, workspaceRoots: string[]): boolean {
  const uri = tryParseUri(context.symbol.uri);
  return Boolean(
    uri &&
    uri.scheme === 'file' &&
    isPathInsideWorkspace(uri.fsPath, workspaceRoots) &&
    isPathInsideWorkspace(context.symbol.filePath, workspaceRoots)
  );
}

function isWorkspaceUsageSite(site: UsageSite, workspaceRoots: string[]): boolean {
  const uri = tryParseUri(site.uri);
  return Boolean(uri && uri.scheme === 'file' && isPathInsideWorkspace(uri.fsPath, workspaceRoots));
}

function isPathInsideWorkspace(filePath: string, workspaceRoots: string[]): boolean {
  if (!filePath || workspaceRoots.length === 0) {
    return false;
  }

  const normalizedFilePath = normalizePathForComparison(path.resolve(filePath));
  return workspaceRoots
    .map((root) => normalizePathForComparison(path.resolve(root)))
    .some((root) => {
      const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
      return normalizedFilePath === root || normalizedFilePath.startsWith(rootPrefix);
    });
}

function normalizePathForComparison(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function tryParseUri(value: string): vscode.Uri | undefined {
  try {
    return vscode.Uri.parse(value);
  } catch {
    return undefined;
  }
}

function isContextSymbol(value: unknown): boolean {
  const symbol = value as SymbolContext['symbol'] | undefined;
  return Boolean(
    symbol &&
    typeof symbol.name === 'string' &&
    typeof symbol.kind === 'string' &&
    typeof symbol.filePath === 'string' &&
    typeof symbol.uri === 'string' &&
    Number.isInteger(symbol.line) &&
    symbol.line > 0 &&
    isRangeData(symbol.range) &&
    (symbol.selectionRange === undefined || isRangeData(symbol.selectionRange))
  );
}

function isRangeData(value: unknown): boolean {
  const range = value as SymbolContext['symbol']['range'] | undefined;
  return Boolean(
    range &&
    isPositionData(range.start) &&
    isPositionData(range.end) &&
    (range.end.line > range.start.line ||
      (range.end.line === range.start.line && range.end.character >= range.start.character))
  );
}

function isPositionData(value: unknown): boolean {
  const position = value as SymbolContext['symbol']['range']['start'] | undefined;
  return Boolean(
    position &&
    Number.isInteger(position.line) &&
    position.line >= 0 &&
    Number.isInteger(position.character) &&
    position.character >= 0
  );
}

function isReferenceContext(value: unknown): boolean {
  const references = value as SymbolContext['references'] | undefined;
  return Boolean(
    references &&
    typeof references.available === 'boolean' &&
    Number.isInteger(references.count) &&
    references.count >= 0
  );
}

function isUsageContext(value: unknown): boolean {
  const usedBy = value as SymbolContext['usedBy'] | undefined;
  return Boolean(
    usedBy &&
    typeof usedBy.available === 'boolean' &&
    Array.isArray(usedBy.symbols) &&
    usedBy.symbols.every((symbol) => typeof symbol === 'string') &&
    (usedBy.sites === undefined || (Array.isArray(usedBy.sites) && usedBy.sites.every(isUsageSite))) &&
    (usedBy.truncated === undefined || typeof usedBy.truncated === 'boolean')
  );
}

function isUsageSite(value: unknown): value is UsageSite {
  const site = value as UsageSite | undefined;
  return Boolean(
    site &&
    typeof site.label === 'string' &&
    typeof site.uri === 'string' &&
    typeof site.path === 'string' &&
    Number.isInteger(site.line) &&
    site.line > 0 &&
    Number.isInteger(site.character) &&
    site.character >= 0 &&
    (site.containerName === undefined || typeof site.containerName === 'string') &&
    (site.source === 'language-server' || site.source === 'text-scan')
  );
}

function isCallsContext(value: unknown): boolean {
  const calls = value as SymbolContext['calls'] | undefined;
  return Boolean(
    calls &&
    Array.isArray(calls.symbols) &&
    calls.symbols.every((symbol) => typeof symbol === 'string')
  );
}

function isGitContext(value: unknown): boolean {
  const git = value as SymbolContext['git'] | undefined;
  return Boolean(
    git &&
    typeof git.available === 'boolean' &&
    (git.author === undefined || typeof git.author === 'string') &&
    (git.relativeDate === undefined || typeof git.relativeDate === 'string')
  );
}

function isRelatedTest(value: unknown): boolean {
  const test = value as SymbolContext['tests'][number] | undefined;
  return Boolean(test && typeof test.path === 'string' && typeof test.uri === 'string');
}

function isOwnerContext(value: unknown): boolean {
  const owner = value as SymbolContext['owner'] | undefined;
  return Boolean(
    owner &&
    typeof owner.available === 'boolean' &&
    (owner.owner === undefined || typeof owner.owner === 'string')
  );
}
