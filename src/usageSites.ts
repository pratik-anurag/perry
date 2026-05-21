import { RangeData, UsageSite } from './types';

export interface UsageSiteCollection {
  sites: UsageSite[];
  truncated: boolean;
}

export function formatUsageSiteLabel(location: string, containerName?: string): string {
  return containerName ? `${containerName} (${location})` : location;
}

export function dedupeUsageSites(sites: UsageSite[], limit: number): UsageSiteCollection {
  const seen = new Set<string>();
  const unique: UsageSite[] = [];
  let truncated = false;

  for (const site of sites) {
    const key = usageSiteKey(site);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    if (unique.length >= limit) {
      truncated = true;
      continue;
    }

    unique.push(site);
  }

  return { sites: unique, truncated };
}

export function usageSiteKey(site: Pick<UsageSite, 'uri' | 'line' | 'character'>): string {
  return `${site.uri}:${site.line}:${site.character}`;
}

export function usageSitesToSymbols(sites: UsageSite[]): string[] {
  const seen = new Set<string>();
  const symbols: string[] = [];

  for (const site of sites) {
    if (seen.has(site.label)) {
      continue;
    }

    seen.add(site.label);
    symbols.push(site.label);
  }

  return symbols;
}

export function isPositionInsideRange(range: RangeData, line: number, character: number): boolean {
  if (line < range.start.line || line > range.end.line) {
    return false;
  }
  if (line === range.start.line && character < range.start.character) {
    return false;
  }
  if (line === range.end.line && character > range.end.character) {
    return false;
  }

  return true;
}
