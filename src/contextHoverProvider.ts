import path from 'path';
import * as vscode from 'vscode';
import { formatContextBlock, getCommentPrefix } from './contextBlock';
import { ContextLensProvider } from './contextLensProvider';
import { OutputLogger, SymbolContext } from './types';

export class ContextHoverProvider implements vscode.HoverProvider, vscode.DocumentLinkProvider {
  public constructor(
    private readonly provider: ContextLensProvider,
    private readonly logger: OutputLogger
  ) {}

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    try {
      const config = vscode.workspace.getConfiguration('contextLens');
      if (!config.get<boolean>('enabled', true) || !config.get<boolean>('enableHover', true)) {
        return undefined;
      }

      const context = await this.provider.getContextAtPosition(document, position, token);
      if (!context || token.isCancellationRequested) {
        return undefined;
      }

      return new vscode.Hover(buildHoverMarkdown(context, document.languageId), toVscodeRange(context));
    } catch (error) {
      this.logger.appendLine(`Context hover failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  public async provideDocumentLinks(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.DocumentLink[]> {
    try {
      const config = vscode.workspace.getConfiguration('contextLens');
      if (!config.get<boolean>('enabled', true) || !config.get<boolean>('enableSymbolLinks', true)) {
        return [];
      }

      const contexts = await this.provider.getDocumentContexts(document, token);
      if (token.isCancellationRequested) {
        return [];
      }

      return contexts
        .map((context) => {
          const nameRange = findSymbolNameRange(document, context);
          if (!nameRange) {
            return undefined;
          }

          const link = new vscode.DocumentLink(nameRange, createCommandUri('contextLens.showDetails', context));
          link.tooltip = 'Open Context Lens details';
          return link;
        })
        .filter((link): link is vscode.DocumentLink => Boolean(link));
    } catch (error) {
      this.logger.appendLine(`Context symbol links failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }
}

function buildHoverMarkdown(context: SymbolContext, languageId: string): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.isTrusted = true;
  markdown.supportThemeIcons = true;

  const references = context.references.available ? `${context.references.count}` : 'unavailable';
  const usedBy = context.usedBy.available
    ? context.usedBy.symbols.length > 0 ? context.usedBy.symbols.join(', ') : 'none'
    : 'unavailable';
  const calls = context.calls.symbols.length > 0
    ? context.calls.symbols.map((symbol) => `${symbol}()`).join(', ')
    : 'none';
  const lastChanged = context.git.available && context.git.author && context.git.relativeDate
    ? `${context.git.relativeDate} by ${context.git.author}`
    : 'unavailable';
  const tests = context.tests.length > 0
    ? context.tests.map((test) => path.basename(test.path)).join(', ')
    : 'none';
  const owner = context.owner.available && context.owner.owner ? context.owner.owner : 'unknown';
  const detailsUri = createCommandUri('contextLens.showDetails', context);
  const referencesUri = createCommandUri('contextLens.revealReferences', context);

  markdown.appendMarkdown(`### $(inspect) Context Lens: \`${escapeMarkdown(context.symbol.name)}\`\n\n`);
  markdown.appendMarkdown(
    `$(references) **${escapeMarkdown(references)} refs** · ` +
    `$(beaker) **${context.tests.length} tests** · ` +
    `$(history) **${escapeMarkdown(lastChanged)}** · ` +
    `$(organization) **${escapeMarkdown(owner)}**\n\n`
  );
  markdown.appendCodeblock(formatContextBlock(context, { commentPrefix: getCommentPrefix(languageId) }), languageId);
  markdown.appendMarkdown('\n');
  markdown.appendMarkdown('| Signal | Details |\n');
  markdown.appendMarkdown('| --- | --- |\n');
  markdown.appendMarkdown(`| Used by | ${escapeMarkdown(usedBy)} |\n`);
  markdown.appendMarkdown(`| Calls | ${escapeMarkdown(calls)} |\n`);
  markdown.appendMarkdown(`| References | ${escapeMarkdown(references)} |\n`);
  markdown.appendMarkdown(`| Last changed | ${escapeMarkdown(lastChanged)} |\n`);
  markdown.appendMarkdown(`| Related tests | ${escapeMarkdown(tests)} |\n`);
  markdown.appendMarkdown(`| Owner | ${escapeMarkdown(owner)} |\n\n`);
  markdown.appendMarkdown(`[$(open-preview) Open details](${detailsUri})`);
  markdown.appendMarkdown(' &nbsp; ');
  markdown.appendMarkdown(`[$(references) Reveal references](${referencesUri})`);

  if (context.tests.length > 0) {
    markdown.appendMarkdown('\n\n**Tests**\n\n');
    for (const test of context.tests) {
      const testUri = createCommandUri('contextLens.openTestFile', test.path);
      markdown.appendMarkdown(`- [${escapeMarkdown(path.basename(test.path))}](${testUri})\n`);
    }
  }

  return markdown;
}

function findSymbolNameRange(document: vscode.TextDocument, context: SymbolContext): vscode.Range | undefined {
  const startLine = context.symbol.range.start.line;
  const endLine = Math.min(document.lineCount - 1, startLine + 3);
  const escapedName = escapeRegExp(context.symbol.name);
  const namePattern = new RegExp(`\\b${escapedName}\\b`);

  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    const lineText = document.lineAt(lineNumber).text;
    const match = namePattern.exec(lineText);
    if (!match) {
      continue;
    }

    return new vscode.Range(
      lineNumber,
      match.index,
      lineNumber,
      match.index + context.symbol.name.length
    );
  }

  return undefined;
}

function toVscodeRange(context: SymbolContext): vscode.Range {
  return new vscode.Range(
    context.symbol.range.start.line,
    context.symbol.range.start.character,
    context.symbol.range.end.line,
    context.symbol.range.end.character
  );
}

function createCommandUri(command: string, argument: unknown): vscode.Uri {
  return vscode.Uri.parse(`command:${command}?${encodeURIComponent(JSON.stringify([argument]))}`);
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}
