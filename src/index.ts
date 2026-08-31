import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

type CaseIndexItem = {
  file: string;
  company?: string;
  short?: string;
  code?: string;
  board?: string;
  layer?: string;
  listing_date?: string;
  inquiry_rounds?: number;
  cutoff_date?: string;
  lawyer?: string;
  tags?: string[];
};

const KBS = {
  ipo: {
    id: 'ipo',
    name: 'IPO与挂牌审核问询法律问题案例库',
    repo: 'lennonli/ipo-inquiry-kb',
    branch: 'main',
    indexPath: 'scripts/index.json',
    sourceDir: 'cases',
  },
} as const;

async function fetchRaw(repo: string, branch: string, path: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GitHub raw fetch failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function loadIndex(): Promise<CaseIndexItem[]> {
  const kb = KBS.ipo;
  const raw = await fetchRaw(kb.repo, kb.branch, kb.indexPath);
  return JSON.parse(raw) as CaseIndexItem[];
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function scoreItem(item: CaseIndexItem, query: string): number {
  const q = normalize(query);
  if (!q) return 0;

  const tokens = q.split(' ').filter(Boolean);
  const fields = [
    item.company ?? '',
    item.short ?? '',
    item.code ?? '',
    item.board ?? '',
    item.layer ?? '',
    item.lawyer ?? '',
    item.file ?? '',
    ...(item.tags ?? []),
  ].map(normalize);

  let score = 0;
  for (const field of fields) {
    if (field.includes(q)) score += 10;
    for (const token of tokens) {
      if (field.includes(token)) score += 2;
    }
  }

  return score;
}

type TextRange = {
  start: number;
  end: number;
};

type SectionHeading = TextRange & {
  title: string;
};

type TextMatch = {
  score: number;
  matchedTerms: string[];
  matchCount: number;
  section: string;
  snippet: string;
};

type QueryTermGroup = {
  term: string;
  variants: string[][];
};

type SearchCandidate = {
  anchor: TextRange;
  nearbyTerms: string[];
  nearbyGroupCount: number;
  span: number;
  section: string;
  sectionHeading?: SectionHeading;
  sectionScore: number;
  proximityScore: number;
  candidateScore: number;
};

const SOURCE_FETCH_CONCURRENCY = 8;
const CANDIDATE_RADIUS = 260;
const SNIPPET_BEFORE = 180;
const SNIPPET_AFTER = 240;
const sourceCache = new Map<string, Promise<string>>();

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSource(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .trim();
}

function findFlexibleMatches(text: string, term: string): TextRange[] {
  const compactTerm = normalize(term).replace(/\s+/g, '');
  if (!compactTerm) return [];

  const pattern = [...compactTerm].map(escapeRegExp).join('\\s*');
  const matches: TextRange[] = [];
  for (const match of text.matchAll(new RegExp(pattern, 'giu'))) {
    if (match.index === undefined) continue;
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return matches;
}

function findNearestSpan(groups: TextRange[][]): number {
  if (groups.length < 2) return 0;

  let bestSpan = Number.POSITIVE_INFINITY;
  for (const anchor of groups[0]) {
    const selected = [anchor];
    for (const group of groups.slice(1)) {
      const nearest = group.reduce((best, current) => {
        const bestDistance = Math.abs(best.start - anchor.start);
        const currentDistance = Math.abs(current.start - anchor.start);
        return currentDistance < bestDistance ? current : best;
      });
      selected.push(nearest);
    }

    const start = Math.min(...selected.map((item) => item.start));
    const end = Math.max(...selected.map((item) => item.end));
    bestSpan = Math.min(bestSpan, end - start);
  }

  return bestSpan;
}

function findTermSplits(text: string, term: string): string[][] {
  const compactTerm = normalize(term).replace(/\s+/g, '');
  const characters = [...compactTerm];
  if (characters.length < 4 || !/[\u3400-\u9fff]/u.test(compactTerm)) return [];

  const partitions: string[][] = [];
  for (let split = 2; split <= characters.length - 2; split += 1) {
    partitions.push([
      characters.slice(0, split).join(''),
      characters.slice(split).join(''),
    ]);
  }
  for (let firstSplit = 2; firstSplit <= characters.length - 4; firstSplit += 1) {
    for (let secondSplit = firstSplit + 2; secondSplit <= characters.length - 2; secondSplit += 1) {
      partitions.push([
        characters.slice(0, firstSplit).join(''),
        characters.slice(firstSplit, secondSplit).join(''),
        characters.slice(secondSplit).join(''),
      ]);
    }
  }

  const usefulPartitions: { parts: string[]; score: number }[] = [];
  for (const parts of partitions) {
    const matches = parts.map((part) => findFlexibleMatches(text, part));
    if (matches.some((ranges) => ranges.length === 0)) continue;

    const span = findNearestSpan(matches);
    if (span > CANDIDATE_RADIUS * 2) continue;

    const occurrenceScore = matches.reduce(
      (score, ranges) => score + Math.min(ranges.length, 10) * 2,
      0,
    );
    const lengthScore = parts.reduce((score, part) => score + part.length * part.length, 0);
    const proximityScore = Math.max(0, 80 - Math.floor(span / 4));
    const score = occurrenceScore + lengthScore + proximityScore;
    usefulPartitions.push({ parts, score });
  }

  return usefulPartitions
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ parts }) => parts);
}

function extractSections(text: string): SectionHeading[] {
  const sections: SectionHeading[] = [];
  for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    if (match.index === undefined) continue;
    sections.push({
      start: match.index,
      end: match.index + match[0].length,
      title: match[1].trim(),
    });
  }
  return sections;
}

function findSectionHeading(sections: SectionHeading[], position: number): SectionHeading | undefined {
  let low = 0;
  let high = sections.length - 1;
  let found = -1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (sections[middle].start <= position) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return found >= 0 ? sections[found] : undefined;
}

function scoreSection(text: string, section: string, position: number): number {
  if (!section) return 0;

  let score = 0;
  if (/问题|问询|回复/u.test(section)) score += 40;
  if (/核查|整改|合规|用工|劳务派遣/u.test(section)) score += 15;
  if (/法律问题总览|公司与审核概况/u.test(section)) score -= 80;

  const context = text.slice(
    Math.max(0, position - SNIPPET_BEFORE),
    Math.min(text.length, position + SNIPPET_AFTER),
  );
  if (/问询要点|回复与核查要点|核查程序|核查意见|整改/u.test(context)) score += 30;

  return score;
}

function buildSnippet(text: string, candidate: SearchCandidate): string {
  let start = Math.max(0, candidate.anchor.start - SNIPPET_BEFORE);
  const end = Math.min(text.length, candidate.anchor.end + SNIPPET_AFTER);

  if (candidate.sectionHeading && candidate.sectionHeading.start >= start) {
    start = candidate.sectionHeading.start;
  }

  const snippetText = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${snippetText}${end < text.length ? '…' : ''}`;
}

function matchFullText(source: string, query: string): TextMatch | null {
  const searchable = normalizeSource(source);
  const normalizedQuery = normalize(query);
  if (!normalizedQuery || !searchable) return null;

  const queryTerms = [...new Set(normalizedQuery.split(' ').filter(Boolean))];
  const termGroups: QueryTermGroup[] = queryTerms.map((term) => {
    const splits = findTermSplits(searchable, term);
    return {
      term,
      variants: [[term], ...splits],
    };
  });
  const terms = [...new Set(termGroups.flatMap((group) => group.variants.flat()))];
  const occurrencesByTerm = new Map<string, TextRange[]>();
  for (const term of terms) {
    occurrencesByTerm.set(term, findFlexibleMatches(searchable, term));
  }

  const matchedGroups = termGroups.filter((group) => {
    const primaryMatch = (occurrencesByTerm.get(group.term)?.length ?? 0) > 0;
    const splitMatch = group.variants.slice(1).some((variant) => variant.every(
      (term) => (occurrencesByTerm.get(term)?.length ?? 0) > 0,
    ));
    return primaryMatch || splitMatch;
  });
  if (matchedGroups.length === 0) return null;

  const matchedTerms = matchedGroups.map((group) => group.term);

  const matchCount = matchedGroups.reduce((count, group) => {
    const primaryCount = occurrencesByTerm.get(group.term)?.length ?? 0;
    const splitCounts = group.variants.slice(1).map((variant) =>
      variant.reduce(
        (variantCount, term) => variantCount + (occurrencesByTerm.get(term)?.length ?? 0),
        0,
      ),
    );
    return count + Math.max(primaryCount, 0, ...splitCounts);
  }, 0);
  const phraseMatches = findFlexibleMatches(searchable, normalizedQuery);
  const sections = extractSections(searchable);
  const anchors = terms.flatMap((term) =>
    (occurrencesByTerm.get(term) ?? []).map((range) => ({ range })),
  );
  anchors.push(...phraseMatches.map((range) => ({ range })));

  const candidates: SearchCandidate[] = anchors.map(({ range }) => {
    const windowStart = Math.max(0, range.start - CANDIDATE_RADIUS);
    const windowEnd = Math.min(searchable.length, range.end + CANDIDATE_RADIUS);
    const nearbyTerms = terms.filter((term) =>
      (occurrencesByTerm.get(term) ?? []).some(
        (occurrence) => occurrence.start < windowEnd && occurrence.end > windowStart,
      ),
    );
    const nearbyGroupCount = termGroups.filter((group) => {
      const primaryNear = (occurrencesByTerm.get(group.term) ?? []).some(
        (occurrence) => occurrence.start < windowEnd && occurrence.end > windowStart,
      );
      const splitNear = group.variants.slice(1).some((variant) => variant.every((term) =>
        (occurrencesByTerm.get(term) ?? []).some(
          (occurrence) => occurrence.start < windowEnd && occurrence.end > windowStart,
        ),
      ));
      return primaryNear || splitNear;
    }).length;
    const nearbyRanges = nearbyTerms.flatMap((term) =>
      (occurrencesByTerm.get(term) ?? []).filter(
        (occurrence) => occurrence.start < windowEnd && occurrence.end > windowStart,
      ),
    );
    const span = nearbyRanges.length > 1
      ? Math.max(...nearbyRanges.map((item) => item.end)) - Math.min(...nearbyRanges.map((item) => item.start))
      : 0;
    const sectionHeading = findSectionHeading(sections, range.start);
    const section = sectionHeading?.title ?? '未识别章节';
    const sectionScore = scoreSection(searchable, sectionHeading?.title ?? '', range.start);
    const nearbyPhraseHit = phraseMatches.some(
      (phrase) => phrase.start < windowEnd && phrase.end > windowStart,
    );
    const proximityScore = nearbyGroupCount > 1
      ? Math.max(0, 40 - Math.floor(span / 20))
      : 0;
    const candidateScore =
      (nearbyPhraseHit ? 70 : 0) +
      (nearbyGroupCount === termGroups.length ? 50 : 0) +
      nearbyGroupCount * 10 +
      proximityScore +
      sectionScore;

    return {
      anchor: range,
      nearbyTerms,
      nearbyGroupCount,
      span,
      section,
      sectionHeading,
      sectionScore,
      proximityScore,
      candidateScore,
    };
  });

  const bestCandidate = candidates.sort(
    (a, b) =>
      b.candidateScore - a.candidateScore ||
      b.nearbyGroupCount - a.nearbyGroupCount ||
      a.span - b.span ||
      a.anchor.start - b.anchor.start,
  )[0];
  if (!bestCandidate) return null;

  let score = 0;
  if (phraseMatches.length > 0) score += 100;
  if (matchedGroups.length === termGroups.length) score += 50;
  score += matchedTerms.length * 10;
  score += Math.min(matchCount, 20) * 2;
  score += bestCandidate.proximityScore + bestCandidate.sectionScore;

  return {
    score,
    matchedTerms,
    matchCount,
    section: bestCandidate.section,
    snippet: buildSnippet(searchable, bestCandidate),
  };
}

function fetchSource(path: string): Promise<string> {
  const cached = sourceCache.get(path);
  if (cached) return cached;

  const pending = fetchRaw(KBS.ipo.repo, KBS.ipo.branch, path);
  sourceCache.set(path, pending);
  pending.catch(() => {
    if (sourceCache.get(path) === pending) sourceCache.delete(path);
  });
  return pending;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function consume(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => consume(),
  );
  await Promise.all(workers);
  return results;
}

type MetadataSearchResult = {
  kb: string;
  score: number;
  file: string;
  path: string;
  item: CaseIndexItem;
};

type FullTextSearchResult = {
  kb: string;
  score: number;
  company: string;
  short?: string;
  code?: string;
  board?: string;
  lawyer?: string;
  file: string;
  path: string;
  matchedTerms: string[];
  matchCount: number;
  section: string;
  snippet: string;
  item: CaseIndexItem;
};

async function searchMetadata(
  index: CaseIndexItem[],
  query: string,
  limit?: number,
): Promise<MetadataSearchResult[]> {
  const results = index
    .map((item) => ({ item, score: scoreItem(item, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const sliced = limit !== undefined ? results.slice(0, limit) : results;

  return sliced.map(({ item, score }) => ({
    kb: 'ipo',
    score,
    file: item.file,
    path: `cases/${item.file}`,
    item,
  }));
}

async function searchFullText(
  index: CaseIndexItem[],
  query: string,
  limit?: number,
): Promise<FullTextSearchResult[]> {
  const sources = await mapWithConcurrency(
    index,
    async (item) => {
      const path = `cases/${item.file}`;
      return { item, path, source: await fetchSource(path) };
    },
    SOURCE_FETCH_CONCURRENCY,
  );

  const results = sources
    .map(({ item, path, source }) => {
      const match = matchFullText(source, query);
      if (!match) return null;

      return {
        kb: 'ipo',
        score: match.score,
        company: item.company ?? item.short ?? item.file,
        short: item.short,
        code: item.code,
        board: item.board,
        lawyer: item.lawyer,
        file: item.file,
        path,
        matchedTerms: match.matchedTerms,
        matchCount: match.matchCount,
        section: match.section,
        snippet: match.snippet,
        item,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.score - a.score);

  return limit !== undefined ? results.slice(0, limit) : results;
}

const server = new McpServer({
  name: 'legal-knowledge-mcp',
  version: '0.1.0',
});

server.registerTool(
  'list_kbs',
  {
    description: '列出当前已接入的法律知识库。',
    inputSchema: z.object({}),
  },
  async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(Object.values(KBS), null, 2),
      },
    ],
  }),
);

server.registerTool(
  'search',
  {
    description: '统一法律知识库检索，同时检索结构化元数据和案例正文，日常检索优先使用本工具；命中后建议调用 read_source 核验原文。',
    inputSchema: z.object({
      kb: z.enum(['ipo']).default('ipo'),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(10),
    }),
  },
  async ({ kb, query, limit }) => {
    if (kb !== 'ipo') throw new Error(`Unsupported knowledge base: ${kb}`);

    const index = await loadIndex();
    const candidateLimit = Math.max(limit * 3, 30);

    const [metaResults, fulltextResults] = await Promise.all([
      searchMetadata(index, query, candidateLimit),
      searchFullText(index, query, candidateLimit),
    ]);

    const maxMetaScore = metaResults.length > 0 ? Math.max(...metaResults.map((r) => r.score)) : 0;
    const maxFullTextScore = fulltextResults.length > 0 ? Math.max(...fulltextResults.map((r) => r.score)) : 0;

    const mergedMap = new Map<
      string,
      {
        item: CaseIndexItem;
        path: string;
        metaHit?: MetadataSearchResult;
        fulltextHit?: FullTextSearchResult;
      }
    >();

    for (const meta of metaResults) {
      mergedMap.set(meta.path, {
        item: meta.item,
        path: meta.path,
        metaHit: meta,
      });
    }

    for (const ft of fulltextResults) {
      const existing = mergedMap.get(ft.path);
      if (existing) {
        existing.fulltextHit = ft;
      } else {
        mergedMap.set(ft.path, {
          item: ft.item,
          path: ft.path,
          fulltextHit: ft,
        });
      }
    }

    const unifiedResults = Array.from(mergedMap.values()).map(({ item, path, metaHit, fulltextHit }) => {
      const match_types: ('metadata' | 'fulltext')[] = [];
      if (metaHit) match_types.push('metadata');
      if (fulltextHit) match_types.push('fulltext');

      const metadata_score = metaHit ? metaHit.score : 0;
      const fulltext_score = fulltextHit ? fulltextHit.score : 0;

      const metaNorm = maxMetaScore > 0 ? (metadata_score / maxMetaScore) * 50 : 0;
      const ftNorm = maxFullTextScore > 0 ? (fulltext_score / maxFullTextScore) * 50 : 0;
      const bonus = metaHit && fulltextHit ? 20 : 0;

      const score = Math.round((metaNorm + ftNorm + bonus) * 100) / 100;

      const snippets: string[] = fulltextHit?.snippet ? [fulltextHit.snippet] : [];
      const matchedTerms: string[] = fulltextHit?.matchedTerms ?? [];
      const section: string | undefined = fulltextHit?.section;

      return {
        kb: 'ipo',
        company: item.company ?? item.short ?? item.file,
        short: item.short ?? '',
        code: item.code ?? '',
        board: item.board ?? '',
        lawyer: item.lawyer ?? '',
        file: item.file,
        path,
        match_types,
        score,
        metadata_score,
        fulltext_score,
        section,
        snippets,
        matchedTerms,
      };
    });

    unifiedResults.sort((a, b) => b.score - a.score);
    const finalResults = unifiedResults.slice(0, limit);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(finalResults, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  'search_kb',
  {
    description: '按公司、证券代码、板块、律师、标签和文件名检索知识库索引。第一版为元数据关键词检索。',
    inputSchema: z.object({
      kb: z.enum(['ipo']).default('ipo'),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(10),
    }),
  },
  async ({ kb, query, limit }) => {
    if (kb !== 'ipo') throw new Error(`Unsupported knowledge base: ${kb}`);

    const index = await loadIndex();
    const results = await searchMetadata(index, query, limit);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            results.map(({ item, score, path }) => ({
              kb: 'ipo',
              score,
              ...item,
              path,
            })),
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  'search_fulltext',
  {
    description: '遍历 ipo 知识库 cases/*.md 做全文关键词检索，返回公司、文件、匹配关键词和命中片段。多个关键词请用空格分隔。',
    inputSchema: z.object({
      kb: z.enum(['ipo']).default('ipo'),
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(10),
    }),
  },
  async ({ kb, query, limit }) => {
    if (kb !== 'ipo') throw new Error(`Unsupported knowledge base: ${kb}`);

    const index = await loadIndex();
    const results = await searchFullText(index, query, limit);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            results.map((r) => ({
              kb: r.kb,
              score: r.score,
              company: r.company,
              file: r.file,
              path: r.path,
              matchedTerms: r.matchedTerms,
              matchCount: r.matchCount,
              section: r.section,
              snippet: r.snippet,
            })),
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  'read_source',
  {
    description: '读取知识库中的 GitHub 原始 Markdown，用于在检索命中后核验完整上下文。',
    inputSchema: z.object({
      kb: z.enum(['ipo']).default('ipo'),
      path: z.string().min(1),
    }),
  },
  async ({ kb, path }) => {
    if (kb !== 'ipo') throw new Error(`Unsupported knowledge base: ${kb}`);

    const normalizedPath = path.replace(/^\/+/, '');
    if (!normalizedPath.startsWith('cases/') || !normalizedPath.endsWith('.md') || normalizedPath.includes('..')) {
      throw new Error('Only Markdown files under cases/ can be read.');
    }

    const source = await fetchRaw(KBS.ipo.repo, KBS.ipo.branch, normalizedPath);

    return {
      content: [
        {
          type: 'text',
          text: source,
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
