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
