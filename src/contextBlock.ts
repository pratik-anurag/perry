import path from 'path';
import { SymbolContext } from './types';

interface ContextBlockOptions {
  commentPrefix: string;
}

export function formatContextBlock(context: SymbolContext, options: ContextBlockOptions): string {
  const prefix = options.commentPrefix;

  return [
    `${prefix} Used by: ${formatUsedBy(context)}`,
    `${prefix} Calls: ${formatCalls(context)}`,
    `${prefix} Last changed: ${formatLastChanged(context)}`,
    `${prefix} Related tests: ${formatRelatedTests(context)}`,
    `${prefix} Owner: ${formatOwner(context)}`
  ].join('\n');
}

export function getCommentPrefix(languageId: string): string {
  return languageId === 'python' ? '#' : '//';
}

function formatUsedBy(context: SymbolContext): string {
  if (!context.usedBy.available) {
    return 'unavailable';
  }

  return context.usedBy.symbols.length > 0 ? context.usedBy.symbols.join(', ') : 'none';
}

function formatCalls(context: SymbolContext): string {
  return context.calls.symbols.length > 0
    ? context.calls.symbols.map((symbol) => `${symbol}()`).join(', ')
    : 'none';
}

function formatLastChanged(context: SymbolContext): string {
  if (!context.git.available || !context.git.author || !context.git.relativeDate) {
    return 'unavailable';
  }

  return `${context.git.relativeDate} by ${context.git.author}`;
}

function formatRelatedTests(context: SymbolContext): string {
  return context.tests.length > 0
    ? context.tests.map((test) => path.basename(test.path)).join(', ')
    : 'none';
}

function formatOwner(context: SymbolContext): string {
  if (!context.owner.available || !context.owner.owner) {
    return 'unknown';
  }

  return context.owner.owner
    .split(',')
    .map((owner) => humanizeOwner(owner.trim()))
    .filter(Boolean)
    .join(', ');
}

function humanizeOwner(owner: string): string {
  const withoutHandle = owner.replace(/^@/, '');
  const teamName = withoutHandle.includes('/')
    ? withoutHandle.split('/').at(-1) ?? withoutHandle
    : withoutHandle;

  return teamName
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
