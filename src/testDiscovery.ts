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
  '**/*Test.java',
  '**/*Tests.java',
  '**/*IT.java',
  '**/*ITCase.java',
  '**/__tests__/**/*.{ts,tsx,js,jsx,py}',
  '**/src/test/java/**/*.java',
  'tests/**/*.{py,ts,tsx,js,jsx,go,java}'
];

const EXCLUDE_PATTERN = '**/{node_modules,.git,.gradle,out,dist,build,target,coverage}/**';
export const MAX_TEST_FILE_BYTES = 256 * 1024;
export const MAX_TEST_INDEX_BYTES = 8 * 1024 * 1024;

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
    let totalIndexedBytes = 0;
    for (const uri of byUri.values()) {
      if (token?.isCancellationRequested) {
        break;
      }

      try {
        const stat = await this.vscodeApi.workspace.fs.stat(uri);
        if (stat.size > MAX_TEST_FILE_BYTES) {
          this.logger.appendLine(`Skipping large test file ${uri.fsPath}: ${stat.size} bytes.`);
          continue;
        }
        if (!canIndexTestFile(stat.size, totalIndexedBytes)) {
          this.logger.appendLine(`Stopping test discovery at ${formatBytes(totalIndexedBytes)} indexed.`);
          break;
        }

        const bytes = await this.vscodeApi.workspace.fs.readFile(uri);
        totalIndexedBytes += bytes.byteLength;
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

export function canIndexTestFile(
  fileSizeBytes: number,
  currentTotalBytes: number,
  maxFileBytes = MAX_TEST_FILE_BYTES,
  maxTotalBytes = MAX_TEST_INDEX_BYTES
): boolean {
  return (
    Number.isFinite(fileSizeBytes) &&
    Number.isFinite(currentTotalBytes) &&
    fileSizeBytes >= 0 &&
    currentTotalBytes >= 0 &&
    fileSizeBytes <= maxFileBytes &&
    currentTotalBytes + fileSizeBytes <= maxTotalBytes
  );
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
    .replace(/(?:Tests?|ITCase|IT)\.java$/i, '')
    .replace(/\.(test|spec)?\.?(ts|tsx|js|jsx|py|go|java)$/i, '');
}

function formatBytes(value: number): string {
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
