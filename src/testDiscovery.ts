import path from 'path';
import type * as vscode from 'vscode';
import { OutputLogger, RelatedTest } from './types';

export interface TestFileSnapshot {
  path: string;
  uri: string;
  fileName: string;
  content: string;
}

const TEST_PATTERNS = [
  '**/*.{test,spec}.{ts,tsx,js,jsx,py}',
  '**/*_test.go',
  '**/__tests__/**/*.{ts,tsx,js,jsx,py}',
  'tests/**/*.{py,ts,tsx,js,jsx,go}'
];

const EXCLUDE_PATTERN = '**/{node_modules,.git,out,dist,build,coverage}/**';

export class TestDiscovery {
  private indexPromise: Promise<TestFileSnapshot[]> | undefined;

  public constructor(
    private readonly vscodeApi: typeof vscode,
    private readonly logger: OutputLogger
  ) {}

  public async getTestIndex(token?: vscode.CancellationToken): Promise<TestFileSnapshot[]> {
    if (this.indexPromise) {
      return this.indexPromise;
    }

    this.indexPromise = this.buildTestIndex(token).catch((error) => {
      this.indexPromise = undefined;
      this.logger.appendLine(`Test discovery failed: ${stringifyError(error)}`);
      return [];
    });
    return this.indexPromise;
  }

  public findRelatedTests(sourceFilePath: string, symbolName: string, index: TestFileSnapshot[]): RelatedTest[] {
    return findRelatedTestFiles(sourceFilePath, symbolName, index).map((test) => ({
      path: test.path,
      uri: test.uri
    }));
  }

  public clearCache(): void {
    this.indexPromise = undefined;
  }

  private async buildTestIndex(token?: vscode.CancellationToken): Promise<TestFileSnapshot[]> {
    const byUri = new Map<string, vscode.Uri>();

    for (const pattern of TEST_PATTERNS) {
      const matches = await this.vscodeApi.workspace.findFiles(pattern, EXCLUDE_PATTERN, 1000, token);
      for (const uri of matches) {
        byUri.set(uri.toString(), uri);
      }
    }

    const snapshots: TestFileSnapshot[] = [];
    for (const uri of byUri.values()) {
      if (token?.isCancellationRequested) {
        break;
      }

      try {
        const bytes = await this.vscodeApi.workspace.fs.readFile(uri);
        snapshots.push({
          path: uri.fsPath,
          uri: uri.toString(),
          fileName: path.basename(uri.fsPath),
          content: Buffer.from(bytes).toString('utf8')
        });
      } catch (error) {
        this.logger.appendLine(`Unable to read test file ${uri.fsPath}: ${stringifyError(error)}`);
      }
    }

    return snapshots;
  }
}

export function findRelatedTestFiles(
  sourceFilePath: string,
  symbolName: string,
  testFiles: TestFileSnapshot[],
  limit = 5
): TestFileSnapshot[] {
  const matches: TestFileSnapshot[] = [];
  for (const testFile of testFiles) {
    if (isRelatedTestFile(sourceFilePath, symbolName, testFile.path, testFile.content)) {
      matches.push(testFile);
    }

    if (matches.length >= limit) {
      break;
    }
  }

  return matches;
}

export function isRelatedTestFile(
  sourceFilePath: string,
  symbolName: string,
  testFilePath: string,
  testFileContent: string
): boolean {
  const sourceStem = basenameWithoutKnownExtensions(sourceFilePath).toLowerCase();
  const testStem = basenameWithoutKnownExtensions(testFilePath).toLowerCase();
  const normalizedSymbol = symbolName.trim();

  if (sourceStem && testStem.includes(sourceStem)) {
    return true;
  }

  return normalizedSymbol.length > 0 && testFileContent.includes(normalizedSymbol);
}

function basenameWithoutKnownExtensions(filePath: string): string {
  const fileName = path.basename(filePath);
  return fileName
    .replace(/_test\.go$/i, '')
    .replace(/\.(test|spec)?\.?(ts|tsx|js|jsx|py|go)$/i, '');
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
