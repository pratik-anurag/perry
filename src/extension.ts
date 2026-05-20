import * as vscode from 'vscode';
import { CodeownersService } from './codeowners';
import { PerryHoverProvider } from './perryHoverProvider';
import { PerryProvider } from './perryProvider';
import { GitService } from './gitService';
import { TestDiscovery } from './testDiscovery';
import { SymbolContext } from './types';

interface PerryRuntime {
  output: vscode.OutputChannel;
  gitService: GitService;
  testDiscovery: TestDiscovery;
  codeownersService: CodeownersService;
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
  { language: 'go', scheme: 'file' }
];

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
      await startPerry(getRuntime(), true);
    }),
    vscode.commands.registerCommand('perry.stop', async () => {
      await stopPerry(getRuntime(), true);
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
        await stopPerry(currentRuntime, true);
      } else {
        await startPerry(currentRuntime, true);
      }
    }),
    vscode.commands.registerCommand('perry.showDiagnostics', () => {
      showDiagnostics(getRuntime());
    }),
    vscode.commands.registerCommand('perry.showDetails', (symbolContext?: SymbolContext) => {
      if (!isSymbolContext(symbolContext)) {
        vscode.window.showInformationMessage('Start Perry, then open a Perry item from a supported source file to view details.');
        return;
      }
      showDetailsPanel(symbolContext);
    }),
    vscode.commands.registerCommand('perry.revealReferences', async (symbolContext?: SymbolContext) => {
      if (!isSymbolContext(symbolContext)) {
        return;
      }
      await revealReferences(symbolContext);
    }),
    vscode.commands.registerCommand('perry.openTestFile', async (filePath?: string) => {
      if (!filePath) {
        return;
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(document, vscode.ViewColumn.Active);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      const currentRuntime = getRuntime();
      if (event.affectsConfiguration('perry.enabled')) {
        const enabled = vscode.workspace.getConfiguration('perry').get<boolean>('enabled', true);
        if (enabled && !currentRuntime.started && !currentRuntime.starting) {
          void startPerry(currentRuntime, false);
        } else if (!enabled && currentRuntime.started && !currentRuntime.stopping) {
          void stopPerry(currentRuntime, false);
        }
        return;
      }

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

async function startPerry(currentRuntime: PerryRuntime, updateConfig: boolean): Promise<void> {
  if (currentRuntime.started || currentRuntime.starting) {
    vscode.window.showInformationMessage('Perry is already running.');
    return;
  }

  currentRuntime.starting = true;
  try {
    if (updateConfig) {
      await updatePerryEnabled(true);
    }

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

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    currentRuntime.activeDisposables.push(
      watcher,
      watcher.onDidCreate(() => {
        clearAllCaches(provider, currentRuntime.gitService, currentRuntime.testDiscovery, currentRuntime.codeownersService);
      }),
      watcher.onDidChange(() => {
        clearAllCaches(provider, currentRuntime.gitService, currentRuntime.testDiscovery, currentRuntime.codeownersService);
      }),
      watcher.onDidDelete(() => {
        clearAllCaches(provider, currentRuntime.gitService, currentRuntime.testDiscovery, currentRuntime.codeownersService);
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

async function stopPerry(currentRuntime: PerryRuntime, updateConfig: boolean): Promise<void> {
  if (!currentRuntime.started || currentRuntime.stopping) {
    vscode.window.showInformationMessage('Perry is already stopped.');
    return;
  }

  currentRuntime.stopping = true;
  try {
    disposeActiveRuntime(currentRuntime);
    if (updateConfig) {
      await updatePerryEnabled(false);
    }
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

async function updatePerryEnabled(enabled: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration('perry');
  const target = vscode.workspace.workspaceFolders
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await config.update('enabled', enabled, target);
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
      enableCommandUris: true
    }
  );

  panel.webview.html = buildDetailsHtml(context);
}

function buildDetailsHtml(context: SymbolContext): string {
  const references = context.references.available ? String(context.references.count) : 'unavailable';
  const referencesMeta = context.references.available
    ? context.references.count === 1 ? 'reference in workspace' : 'references in workspace'
    : 'Language service unavailable';
  const usedBy = context.usedBy.available
    ? context.usedBy.symbols.length > 0 ? context.usedBy.symbols.join(', ') : 'none'
    : 'unavailable';
  const usedByMeta = context.usedBy.available
    ? context.usedBy.symbols.length === 1 ? 'caller detected' : 'callers detected'
    : 'Caller scan unavailable';
  const calls = context.calls.symbols.length > 0
    ? context.calls.symbols.map((symbol) => `${symbol}()`).join(', ')
    : 'none';
  const callsMeta = context.calls.symbols.length === 1 ? 'outgoing call' : 'outgoing calls';
  const gitAuthor = context.git.available ? context.git.author ?? 'unknown' : 'unavailable';
  const gitDate = context.git.available ? context.git.relativeDate ?? 'unknown' : 'unavailable';
  const owner = context.owner.available ? context.owner.owner ?? 'unknown' : 'unknown';
  const revealUri = createCommandUri('perry.revealReferences', context);
  const location = `${context.symbol.filePath}:${context.symbol.line}`;
  const symbolInitial = context.symbol.name.trim().slice(0, 1).toUpperCase() || 'P';
  const referenceTone = context.references.available ? 'accent' : 'warning';
  const ownerTone = context.owner.available && context.owner.owner ? 'good' : 'muted';
  const gitTone = context.git.available ? 'accent' : 'warning';
  const testTone = context.tests.length > 0 ? 'good' : 'muted';
  const referencesBadge = context.references.available ? `${references} refs` : 'References unavailable';
  const ownerBadge = context.owner.available && context.owner.owner ? owner : 'No owner';
  const ownerMeta = context.owner.available && context.owner.owner ? 'CODEOWNERS match' : 'No CODEOWNERS match';
  const usedByPill = context.usedBy.available ? `${context.usedBy.symbols.length} ${usedByMeta}` : usedByMeta;
  const testFileLabel = context.tests.length === 1 ? 'file' : 'files';
  const usedByChips = context.usedBy.available
    ? renderChips(context.usedBy.symbols, 'No callers found.')
    : '<div class="muted">References unavailable.</div>';
  const callChips = renderChips(context.calls.symbols.map((symbol) => `${symbol}()`), 'No calls detected.');
  const tests = context.tests.length > 0
    ? context.tests
      .map((test) => {
        const commandUri = createOpenFileCommandUri(test.path);
        return `<li><a class="test-link" href="${commandUri}"><span class="test-dot"></span><span>${escapeHtml(test.path)}</span></a></li>`;
      })
      .join('')
    : '<li class="empty-row">No related tests found.</li>';
  const detailRows = [
    ['Symbol', context.symbol.name],
    ['Kind', context.symbol.kind],
    ['File', context.symbol.filePath],
    ['Line', String(context.symbol.line)],
    ['Reference Count', references],
    ['Used By', usedBy],
    ['Calls', calls],
    ['Last Git Author', gitAuthor],
    ['Last Git Date', gitDate],
    ['CODEOWNERS Owner', owner]
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
  </style>
</head>
<body>
  <div class="shell">
  <div class="hero">
    <div class="hero-main">
      <div class="symbol-mark">${escapeHtml(symbolInitial)}</div>
      <div class="hero-copy">
        <div class="eyebrow">${escapeHtml(context.symbol.kind)}</div>
        <h1>${escapeHtml(context.symbol.name)}</h1>
        <div class="subtitle">${escapeHtml(location)}</div>
      </div>
    </div>
    <div class="hero-footer">
      <div class="badges">
        <span class="badge ${context.references.available ? 'accent' : 'warning'}">${escapeHtml(referencesBadge)}</span>
        <span class="badge ${context.git.available ? 'accent' : 'warning'}">${escapeHtml(gitDate)}</span>
        <span class="badge ${ownerTone}">${escapeHtml(ownerBadge)}</span>
      </div>
      <div class="actions">
        <a class="button" href="${revealUri}">Reveal References</a>
      </div>
    </div>
  </div>

  <div class="summary-grid">
    <div class="metric ${referenceTone}"><div class="metric-label">References</div><div class="metric-value">${escapeHtml(references)}</div><div class="metric-meta">${escapeHtml(referencesMeta)}</div></div>
    <div class="metric ${gitTone}"><div class="metric-label">Last Changed</div><div class="metric-value">${escapeHtml(gitDate)}</div><div class="metric-meta">${escapeHtml(gitAuthor)}</div></div>
    <div class="metric ${ownerTone}"><div class="metric-label">Owner</div><div class="metric-value">${escapeHtml(owner)}</div><div class="metric-meta">${escapeHtml(ownerMeta)}</div></div>
    <div class="metric ${testTone}"><div class="metric-label">Related Tests</div><div class="metric-value">${context.tests.length}</div><div class="metric-meta">${context.tests.length === 1 ? 'test file found' : 'test files found'}</div></div>
  </div>

  <div class="content-grid">
    <div class="stack">
      <section class="card">
        <div class="card-header">
          <h2>Used By</h2>
          <span class="count-pill">${escapeHtml(usedByPill)}</span>
        </div>
        <div class="card-body">${usedByChips}</div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Calls</h2>
          <span class="count-pill">${context.calls.symbols.length} ${escapeHtml(callsMeta)}</span>
        </div>
        <div class="card-body">${callChips}</div>
      </section>

      <section class="card">
        <div class="card-header">
          <h2>Related Tests</h2>
          <span class="count-pill">${context.tests.length} ${testFileLabel}</span>
        </div>
        <div class="card-body"><ul>${tests}</ul></div>
      </section>
    </div>

    <section class="card">
      <div class="card-header">
        <h2>Details</h2>
        <span class="count-pill">Source Snapshot</span>
      </div>
      <div class="card-body">
        <div class="detail-grid">
          ${detailRows.map(([label, value]) => `<div class="detail-label">${escapeHtml(label)}</div><div class="detail-value">${escapeHtml(value)}</div>`).join('')}
        </div>
      </div>
    </section>
  </div>
  </div>
</body>
</html>`;
}

async function revealReferences(context: SymbolContext): Promise<void> {
  const uri = vscode.Uri.parse(context.symbol.uri);
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  const position = new vscode.Position(context.symbol.range.start.line, context.symbol.range.start.character);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  await vscode.commands.executeCommand('editor.action.referenceSearch.trigger');
}

function createOpenFileCommandUri(filePath: string): string {
  return createCommandUri('perry.openTestFile', filePath);
}

function createCommandUri(command: string, argument: unknown): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([argument]))}`;
}

function renderChips(values: string[], emptyText: string): string {
  if (values.length === 0) {
    return `<div class="muted">${escapeHtml(emptyText)}</div>`;
  }

  return `<div class="chips">${values.map((value) => `<span class="chip">${escapeHtml(value)}</span>`).join('')}</div>`;
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
  return Boolean(
    value &&
    typeof value === 'object' &&
    'symbol' in value &&
    typeof (value as SymbolContext).symbol?.name === 'string' &&
    typeof (value as SymbolContext).symbol?.uri === 'string'
  );
}
