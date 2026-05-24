import * as vscode from 'vscode';

const CALL_EXCLUDE_LIST = new Set([
  'after',
  'assert',
  'await',
  'before',
  'case',
  'catch',
  'class',
  'defer',
  'def',
  'describe',
  'do',
  'elif',
  'else',
  'finally',
  'for',
  'func',
  'function',
  'go',
  'if',
  'instanceof',
  'interface',
  'it',
  'new',
  'range',
  'return',
  'select',
  'super',
  'switch',
  'synchronized',
  'test',
  'this',
  'throw',
  'throws',
  'try',
  'typeof',
  'void',
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
  return findCallCharactersInLine(lineText, symbolName, languageId).length > 0;
}

export function findCallCharactersInLine(lineText: string, symbolName: string, languageId: string): number[] {
  const identifier = getSymbolIdentifier(symbolName);
  if (!identifier) {
    return [];
  }

  const code = sanitizeLineForCallScan(lineText, languageId);
  if (isDefinitionLine(code, identifier, languageId)) {
    return [];
  }

  const callCharacters: number[] = [];
  const callPattern = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(identifier)}\\s*\\(`, 'g');

  for (;;) {
    const match = callPattern.exec(code);
    if (!match) {
      break;
    }

    callCharacters.push(match.index);
  }

  return callCharacters;
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

function sanitizeLineForCallScan(value: string, languageId: string): string {
  return stripLineComments(stripInlineBlockComments(stripStringLiterals(value)), languageId);
}

function stripStringLiterals(value: string): string {
  return value.replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, (match) => ' '.repeat(match.length));
}

function stripInlineBlockComments(value: string): string {
  return value.replace(/\/\*.*?\*\//g, (match) => ' '.repeat(match.length));
}

function stripLineComments(value: string, languageId: string): string {
  if (languageId === 'python') {
    return replaceTrailingComment(value, '#');
  }

  if (languageId === 'go' || languageId === 'java') {
    return replaceTrailingComment(value, '//');
  }

  return value;
}

function replaceTrailingComment(value: string, marker: string): string {
  const markerIndex = value.indexOf(marker);
  if (markerIndex < 0) {
    return value;
  }

  return `${value.slice(0, markerIndex)}${' '.repeat(value.length - markerIndex)}`;
}

function isDefinitionLine(value: string, identifier: string, languageId: string): boolean {
  const escapedIdentifier = escapeRegExp(identifier);
  if (languageId === 'python') {
    return new RegExp(`^\\s*(?:async\\s+)?def\\s+${escapedIdentifier}\\s*\\(`).test(value);
  }

  if (languageId === 'go') {
    return new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${escapedIdentifier}\\s*\\(`).test(value);
  }

  if (languageId === 'java') {
    return isJavaDefinitionLine(value, escapedIdentifier);
  }

  return false;
}

function isJavaDefinitionLine(value: string, escapedIdentifier: string): boolean {
  if (/^\s*(?:assert|break|case|continue|do|else|for|if|new|return|switch|throw|try|while)\b/.test(value)) {
    return false;
  }

  const annotationPattern = String.raw`(?:@[\w.]+(?:\([^)]*\))?\s*)*`;
  const modifierPattern = String.raw`(?:(?:public|protected|private|static|final|abstract|native|synchronized|strictfp|default)\s+)*`;
  const typeParameterPattern = String.raw`(?:<[^;{}()]+>\s*)?`;
  const typePattern = String.raw`(?:[\w$.\[\]?]+(?:\s*<[^;{}()]+>)?\s+)`;
  const methodPattern = new RegExp(
    String.raw`^\s*${annotationPattern}${modifierPattern}${typeParameterPattern}(?:${typePattern})+${escapedIdentifier}\s*\(`
  );
  const completeConstructorPattern = new RegExp(
    String.raw`^\s*${annotationPattern}(?:(?:public|protected|private)\s+)?${escapedIdentifier}\s*\([^;{}]*\)\s*(?:throws\s+[\w$.,\s]+)?\{`
  );
  const modifierConstructorStartPattern = new RegExp(
    String.raw`^\s*${annotationPattern}(?:public|protected|private)\s+${escapedIdentifier}\s*\(`
  );

  return methodPattern.test(value) || completeConstructorPattern.test(value) || modifierConstructorStartPattern.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}
