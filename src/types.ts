export interface PositionData {
  line: number;
  character: number;
}

export interface RangeData {
  start: PositionData;
  end: PositionData;
}

export interface ContextSymbol {
  name: string;
  kind: string;
  filePath: string;
  uri: string;
  line: number;
  range: RangeData;
  selectionRange?: RangeData;
}

export interface ReferenceContext {
  available: boolean;
  count: number;
}

export interface UsageContext {
  available: boolean;
  symbols: string[];
}

export interface CallsContext {
  symbols: string[];
}

export interface GitContext {
  available: boolean;
  author?: string;
  relativeDate?: string;
}

export interface RelatedTest {
  path: string;
  uri: string;
}

export interface OwnerContext {
  available: boolean;
  owner?: string;
}

export interface SymbolContext {
  symbol: ContextSymbol;
  references: ReferenceContext;
  usedBy: UsageContext;
  calls: CallsContext;
  git: GitContext;
  tests: RelatedTest[];
  owner: OwnerContext;
}

export interface OutputLogger {
  appendLine(value: string): void;
}
