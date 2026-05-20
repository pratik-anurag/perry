import * as vscode from 'vscode';
import { CodeownersService } from './codeowners';
import { ContextGutterProvider } from './contextGutterProvider';
import { ContextHoverProvider } from './contextHoverProvider';
import { ContextLensProvider } from './contextLensProvider';
import { GitService } from './gitService';
import { TestDiscovery } from './testDiscovery';
import { SymbolContext } from './types';

let provider: ContextLensProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Context Lens');
  const workspaceRoots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  const gitService = new GitService(output);
  const testDiscovery = new TestDiscovery(vscode, output);
  const codeownersService = new CodeownersService(workspaceRoots, output);

  provider = new ContextLensProvider({
    gitService,
    testDiscovery,
    codeownersService,
    logger: output
  });
  const hoverProvider = new ContextHoverProvider(provider, output);
  const gutterProvider = new ContextGutterProvider(context, provider, output);

  const selectors: vscode.DocumentSelector = [
    { language: 'typescript', scheme: 'file' },
    { language: 'javascript', scheme: 'file' },
    { language: 'typescriptreact', scheme: 'file' },
    { language: 'javascriptreact', scheme: 'file' },
    { language: 'python', scheme: 'file' },
    { language: 'go', scheme: 'file' }
  ];

  context.subscriptions.push(
    output,
    vscode.languages.registerCodeLensProvider(selectors, provider),
    vscode.languages.registerHoverProvider(selectors, hoverProvider),
    vscode.languages.registerDocumentLinkProvider(selectors, hoverProvider),
    vscode.commands.registerCommand('contextLens.refresh', () => {
      clearAllCaches(provider, gitService, testDiscovery, codeownersService);
      void gutterProvider.refreshVisibleEditors();
      vscode.window.showInformationMessage('Context Lens refreshed.');
    }),
    vscode.commands.registerCommand('contextLens.toggle', async () => {
      const config = vscode.workspace.getConfiguration('contextLens');
      const nextValue = !config.get<boolean>('enabled', true);
      const target = vscode.workspace.workspaceFolders
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      await config.update('enabled', nextValue, target);
      provider?.clearCache();
      void gutterProvider.refreshVisibleEditors();
      vscode.window.showInformationMessage(`Context Lens ${nextValue ? 'enabled' : 'disabled'}.`);
    }),
    vscode.commands.registerCommand('contextLens.showDetails', (symbolContext?: SymbolContext) => {
      if (!isSymbolContext(symbolContext)) {
        vscode.window.showInformationMessage('Open a Context Lens item from a supported source file to view details.');
        return;
      }
      showDetailsPanel(symbolContext);
    }),
    vscode.commands.registerCommand('contextLens.revealReferences', async (symbolContext?: SymbolContext) => {
      if (!isSymbolContext(symbolContext)) {
        return;
      }
      await revealReferences(symbolContext);
    }),
    vscode.commands.registerCommand('contextLens.openTestFile', async (filePath?: string) => {
      if (!filePath) {
        return;
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(document, vscode.ViewColumn.Active);
    }),
    vscode.workspace.onDidSaveTextDocument(() => provider?.clearCache()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('contextLens')) {
        clearAllCaches(provider, gitService, testDiscovery, codeownersService);
        void gutterProvider.refreshVisibleEditors();
      }
    })
  );

  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(() => {
      clearAllCaches(provider, gitService, testDiscovery, codeownersService);
      void gutterProvider.refreshVisibleEditors();
    }),
    watcher.onDidChange(() => {
      clearAllCaches(provider, gitService, testDiscovery, codeownersService);
      void gutterProvider.refreshVisibleEditors();
    }),
    watcher.onDidDelete(() => {
      clearAllCaches(provider, gitService, testDiscovery, codeownersService);
      void gutterProvider.refreshVisibleEditors();
    })
  );

  gutterProvider.bind(context);
  output.appendLine('Context Lens activated.');
}

export function deactivate(): void {
  provider = undefined;
}

function clearAllCaches(
  contextLensProvider: ContextLensProvider | undefined,
  gitService: GitService,
  testDiscovery: TestDiscovery,
  codeownersService: CodeownersService
): void {
  gitService.clearCache();
  testDiscovery.clearCache();
  codeownersService.clearCache();
  contextLensProvider?.clearCache();
}

function showDetailsPanel(context: SymbolContext): void {
  const panel = vscode.window.createWebviewPanel(
    'contextLensDetails',
    `Context Lens: ${context.symbol.name}`,
    vscode.ViewColumn.Beside,
    {
      enableCommandUris: true
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
  const revealUri = createCommandUri('contextLens.revealReferences', context);
  const usedByChips = context.usedBy.available
    ? renderChips(context.usedBy.symbols, 'No callers found.')
    : '<div class="muted">References unavailable.</div>';
  const callChips = renderChips(context.calls.symbols.map((symbol) => `${symbol}()`), 'No calls detected.');
  const tests = context.tests.length > 0
    ? context.tests
      .map((test) => {
        const commandUri = createOpenFileCommandUri(test.path);
        return `<li><a href="${commandUri}">${escapeHtml(test.path)}</a></li>`;
      })
      .join('')
    : '<li class="muted">No related tests found.</li>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Context Lens Details</title>
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 28px;
      line-height: 1.45;
    }
    .shell {
      max-width: 920px;
      margin: 0 auto;
    }
    .hero {
      border: 1px solid var(--vscode-panel-border);
      border-left: 4px solid var(--vscode-focusBorder);
      border-radius: 8px;
      background: var(--vscode-editorWidget-background);
      margin-bottom: 18px;
      padding: 16px;
    }
    h1 {
      font-size: 1.55rem;
      margin: 0 0 4px;
    }
    .subtitle, .muted {
      color: var(--vscode-descriptionForeground);
    }
    .subtitle {
      word-break: break-word;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 10px;
      margin: 18px 0;
    }
    .metric {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 10px 12px;
      background: var(--vscode-editorWidget-background);
      box-shadow: 0 1px 0 rgba(0, 0, 0, 0.08);
    }
    .metric-label {
      color: var(--vscode-descriptionForeground);
      font-size: 0.86rem;
      margin-bottom: 4px;
    }
    .metric-value {
      font-size: 1.05rem;
      font-weight: 600;
    }
    section {
      margin-top: 20px;
    }
    h2 {
      font-size: 1rem;
      margin: 0 0 10px;
    }
    .chips {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .chip {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      padding: 3px 9px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      white-space: nowrap;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 0;
    }
    th, td {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 8px 0;
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
      width: 180px;
    }
    a {
      color: var(--vscode-textLink-foreground);
    }
    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    .button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      text-decoration: none;
      padding: 7px 12px;
      border-radius: 4px;
      font-weight: 600;
    }
    ul {
      padding-left: 18px;
    }
  </style>
</head>
<body>
  <div class="shell">
  <div class="hero">
    <h1>${escapeHtml(context.symbol.name)}</h1>
    <div class="subtitle">${escapeHtml(context.symbol.kind)} · ${escapeHtml(context.symbol.filePath)}:${context.symbol.line}</div>
    <div class="actions">
      <a class="button" href="${revealUri}">Reveal References</a>
    </div>
  </div>

  <div class="summary-grid">
    <div class="metric"><div class="metric-label">References</div><div class="metric-value">${escapeHtml(references)}</div></div>
    <div class="metric"><div class="metric-label">Last Changed</div><div class="metric-value">${escapeHtml(gitDate)}</div></div>
    <div class="metric"><div class="metric-label">Author</div><div class="metric-value">${escapeHtml(gitAuthor)}</div></div>
    <div class="metric"><div class="metric-label">Owner</div><div class="metric-value">${escapeHtml(owner)}</div></div>
  </div>

  <section>
    <h2>Used By</h2>
    ${usedByChips}
  </section>

  <section>
    <h2>Calls</h2>
    ${callChips}
  </section>

  <section>
    <h2>Details</h2>
  <table>
    <tr><th>Symbol</th><td>${escapeHtml(context.symbol.name)}</td></tr>
    <tr><th>Kind</th><td>${escapeHtml(context.symbol.kind)}</td></tr>
    <tr><th>File</th><td>${escapeHtml(context.symbol.filePath)}</td></tr>
    <tr><th>Line</th><td>${context.symbol.line}</td></tr>
    <tr><th>Reference Count</th><td>${escapeHtml(references)}</td></tr>
    <tr><th>Used By</th><td>${escapeHtml(usedBy)}</td></tr>
    <tr><th>Calls</th><td>${escapeHtml(calls)}</td></tr>
    <tr><th>Last Git Author</th><td>${escapeHtml(gitAuthor)}</td></tr>
    <tr><th>Last Git Date</th><td>${escapeHtml(gitDate)}</td></tr>
    <tr><th>CODEOWNERS Owner</th><td>${escapeHtml(owner)}</td></tr>
  </table>
  </section>

  <section>
  <h2>Related Tests</h2>
  <ul>${tests}</ul>
  </section>
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
  return createCommandUri('contextLens.openTestFile', filePath);
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
