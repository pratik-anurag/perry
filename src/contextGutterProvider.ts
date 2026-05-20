import * as vscode from 'vscode';
import { ContextLensProvider } from './contextLensProvider';
import { OutputLogger, SymbolContext } from './types';

const SUPPORTED_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'typescriptreact',
  'javascriptreact',
  'python',
  'go'
]);

export class ContextGutterProvider implements vscode.Disposable {
  private readonly decorationType: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private cancellation: vscode.CancellationTokenSource | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;

  public constructor(
    extensionContext: vscode.ExtensionContext,
    private readonly provider: ContextLensProvider,
    private readonly logger: OutputLogger
  ) {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: extensionContext.asAbsolutePath('media/context-lens.svg'),
      gutterIconSize: 'contain',
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      overviewRulerColor: new vscode.ThemeColor('charts.blue')
    });
    this.disposables.push(this.decorationType);
  }

  public bind(context: vscode.ExtensionContext): void {
    const refresh = () => this.scheduleRefresh();
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(refresh),
      vscode.window.onDidChangeVisibleTextEditors(refresh),
      vscode.workspace.onDidSaveTextDocument(refresh),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('contextLens')) {
          refresh();
        }
      })
    );

    context.subscriptions.push(this);
    this.scheduleRefresh(0);
  }

  public scheduleRefresh(delayMs = 250): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshVisibleEditors();
    }, delayMs);
  }

  public async refreshVisibleEditors(): Promise<void> {
    this.cancellation?.cancel();
    this.cancellation?.dispose();
    this.cancellation = new vscode.CancellationTokenSource();
    const token = this.cancellation.token;

    await Promise.all(vscode.window.visibleTextEditors.map((editor) => this.refreshEditor(editor, token)));
  }

  public dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.cancellation?.cancel();
    this.cancellation?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async refreshEditor(editor: vscode.TextEditor, token: vscode.CancellationToken): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration('contextLens');
      if (
        !config.get<boolean>('enabled', true) ||
        !config.get<boolean>('showGutterMarkers', true) ||
        editor.document.uri.scheme !== 'file' ||
        !SUPPORTED_LANGUAGES.has(editor.document.languageId)
      ) {
        editor.setDecorations(this.decorationType, []);
        return;
      }

      const documentVersion = editor.document.version;
      const contexts = await this.provider.getDocumentContexts(editor.document, token);
      if (token.isCancellationRequested || editor.document.version !== documentVersion) {
        return;
      }

      const decorations = contexts.map((context): vscode.DecorationOptions => ({
        range: editor.document.lineAt(context.symbol.range.start.line).range,
        hoverMessage: buildGutterHover(context)
      }));
      editor.setDecorations(this.decorationType, decorations);
    } catch (error) {
      this.logger.appendLine(`Context gutter markers failed: ${error instanceof Error ? error.message : String(error)}`);
      editor.setDecorations(this.decorationType, []);
    }
  }
}

function buildGutterHover(context: SymbolContext): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.isTrusted = true;
  markdown.supportThemeIcons = true;
  markdown.appendMarkdown(`$(inspect) **Context Lens** \`${escapeMarkdown(context.symbol.name)}\`\n\n`);
  markdown.appendMarkdown(`[Open details](${createCommandUri('contextLens.showDetails', context)})`);
  markdown.appendMarkdown(' · ');
  markdown.appendMarkdown(`[Reveal references](${createCommandUri('contextLens.revealReferences', context)})`);
  return markdown;
}

function createCommandUri(command: string, argument: unknown): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([argument]))}`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}
