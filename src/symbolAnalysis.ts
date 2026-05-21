import * as vscode from 'vscode';

const CALL_EXCLUDE_LIST = new Set([
  'after',
  'await',
  'before',
  'catch',
  'class',
  'defer',
  'def',
  'describe',
  'elif',
  'else',
  'for',
  'func',
  'function',
  'go',
  'if',
  'interface',
  'it',
  'new',
  'range',
  'return',
  'select',
  'switch',
  'test',
  'typeof',
  'while',
  'with'
]);

export function extractCallsFromSymbol(document: vscode.TextDocument, range: vscode.Range, symbolName: string): string[] {
  const text = stripCommentsAndStrings(document.getText(range));
  const calls: string[] = [];
  const seen = new Set<string>();
  const callPattern = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g;

  for (;;) {
    const match = callPattern.exec(text);
    if (!match) {
      break;
    }

    const rawName = match[1];
    const callName = rawName.split('.').at(-1) ?? rawName;
    if (!shouldIncludeCall(callName, symbolName) || seen.has(callName)) {
      continue;
    }

    seen.add(callName);
    calls.push(callName);

    if (calls.length >= 5) {
      break;
    }
  }

  return calls;
}

export function lineContainsCallToSymbol(lineText: string, symbolName: string, languageId: string): boolean {
  const identifier = getSymbolIdentifier(symbolName);
  if (!identifier) {
    return false;
  }

  const code = stripLineComments(stripStringLiterals(lineText), languageId);
  if (isDefinitionLine(code, identifier, languageId)) {
    return false;
  }

  return new RegExp(`(?:\\b|\\.)${escapeRegExp(identifier)}\\s*\\(`).test(code);
}

export function getSymbolIdentifier(symbolName: string): string {
  const identifiers = symbolName.match(/[A-Za-z_$][\w$]*/g);
  return identifiers?.at(-1) ?? '';
}

function shouldIncludeCall(callName: string, symbolName: string): boolean {
  if (!callName || callName === symbolName) {
    return false;
  }

  return !CALL_EXCLUDE_LIST.has(callName.toLowerCase());
}

function stripCommentsAndStrings(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/#.*$/gm, '')
    .replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, '');
}

function stripStringLiterals(value: string): string {
  return value.replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, '');
}

function stripLineComments(value: string, languageId: string): string {
  if (languageId === 'python') {
    return value.replace(/#.*$/, '');
  }

  if (languageId === 'go') {
    return value.replace(/\/\/.*$/, '');
  }

  return value;
}

function isDefinitionLine(value: string, identifier: string, languageId: string): boolean {
  const escapedIdentifier = escapeRegExp(identifier);
  if (languageId === 'python') {
    return new RegExp(`^\\s*(?:async\\s+)?def\\s+${escapedIdentifier}\\s*\\(`).test(value);
  }

  if (languageId === 'go') {
    return new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${escapedIdentifier}\\s*\\(`).test(value);
  }

  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}
