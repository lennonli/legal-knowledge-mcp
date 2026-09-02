// legal-knowledge-mcp v0.2.0
// 统一法律知识库 MCP Server —— 无状态 Streamable HTTP，零依赖（仅 Node >= 18）。
// 数据源：lennonli/ipo-inquiry-kb monorepo（按年度子目录 2023/2024/2025/2026）。
// 设 KB_LOCAL_ROOT=本地 monorepo 克隆路径 时直读本地文件（免 GitHub raw、适合部署机），
// 否则读取 GitHub raw。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const REPO = 'lennonli/ipo-inquiry-kb';
const BRANCH = 'main';

const KBS = {
  ipo: {
    id: 'ipo',
    name: 'IPO与挂牌审核问询法律问题案例库(2026年度)',
    prefix: '2026/',
  },
  ipo2025: {
    id: 'ipo2025',
    name: 'IPO与挂牌审核问询法律问题案例库(2025年度)',
    prefix: '2025/',
  },
  ipo2024: {
    id: 'ipo2024',
    name: 'IPO与挂牌审核问询法律问题案例库(2024年度)',
    prefix: '2024/',
  },
  ipo2023: {
    id: 'ipo2023',
    name: 'IPO与挂牌审核问询法律问题案例库(2023年度)',
    prefix: '2023/',
  },
};

const KB_IDS = Object.keys(KBS);
const LOCAL_ROOT = process.env.KB_LOCAL_ROOT || '';
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

const INDEX_TTL_MS = 10 * 60 * 1000;
const SOURCE_TTL_MS = 6 * 60 * 60 * 1000;
const SOURCE_FETCH_CONCURRENCY = 8;
const CANDIDATE_RADIUS = 260;
const SNIPPET_BEFORE = 180;
const SNIPPET_AFTER = 240;

// ── 数据读取 ────────────────────────────────────────────────

async function fetchRaw(prefix, relPath) {
  if (LOCAL_ROOT) {
    const target = path.join(LOCAL_ROOT, prefix, relPath);
    if (!target.startsWith(path.resolve(LOCAL_ROOT) + path.sep)) {
      throw new Error('Invalid path');
    }
    return readFile(target, 'utf8');
  }
  const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${prefix}${relPath}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GitHub raw fetch failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

const indexCache = new Map(); // kb -> { text, at }
const sourceCache = new Map(); // `${kb}:${path}` -> { text, at }

async function loadIndex(kb) {
  const cached = indexCache.get(kb);
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return JSON.parse(cached.text);
  const text = await fetchRaw(KBS[kb].prefix, 'scripts/index.json');
  indexCache.set(kb, { text, at: Date.now() });
  return JSON.parse(text);
}

async function fetchSource(kb, relPath) {
  const key = `${kb}:${relPath}`;
  const cached = sourceCache.get(key);
  if (cached && Date.now() - cached.at < SOURCE_TTL_MS) return cached.text;
  const pending = fetchRaw(KBS[kb].prefix, relPath);
  const text = await pending;
  sourceCache.set(key, { text, at: Date.now() });
  return text;
}

// ── 元数据检索 ──────────────────────────────────────────────

function normalize(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function scoreItem(item, query) {
  const q = normalize(query);
  if (!q) return 0;
  const tokens = q.split(' ').filter(Boolean);
  const fields = [
    item.company ?? '', item.short ?? '', item.code ?? '', item.board ?? '',
    item.layer ?? '', item.lawyer ?? '', item.file ?? '', ...(item.tags ?? []),
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

// ── 正文全文检索（近邻/分词/章节加权，与 v0.1 行为一致）──────

function escapeRegExp(text) {
  return text.replace(/[.*+?${}()|[\]\\]/g, '\\$&');
}

function normalizeSource(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .trim();
}

function findFlexibleMatches(text, term) {
  const compactTerm = normalize(term).replace(/\s+/g, '');
  if (!compactTerm) return [];
  const pattern = [...compactTerm].map(escapeRegExp).join('\\s*');
  const matches = [];
  for (const match of text.matchAll(new RegExp(pattern, 'giu'))) {
    if (match.index === undefined) continue;
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

function findNearestSpan(groups) {
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

function findTermSplits(text, term) {
  const compactTerm = normalize(term).replace(/\s+/g, '');
  const characters = [...compactTerm];
  if (characters.length < 4 || !/[\u3400-\u9fff]/u.test(compactTerm)) return [];

  const partitions = [];
  for (let split = 2; split <= characters.length - 2; split += 1) {
    partitions.push([characters.slice(0, split).join(''), characters.slice(split).join('')]);
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

  const usefulPartitions = [];
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
    usefulPartitions.push({ parts, score: occurrenceScore + lengthScore + proximityScore });
  }

  return usefulPartitions
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ parts }) => parts);
}

function extractSections(text) {
  const sections = [];
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

function findSectionHeading(sections, position) {
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

function scoreSection(text, section, position) {
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

function buildSnippet(text, candidate) {
  let start = Math.max(0, candidate.anchor.start - SNIPPET_BEFORE);
  const end = Math.min(text.length, candidate.anchor.end + SNIPPET_AFTER);
  if (candidate.sectionHeading && candidate.sectionHeading.start >= start) {
    start = candidate.sectionHeading.start;
  }
  const snippetText = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${snippetText}${end < text.length ? '…' : ''}`;
}

function matchFullText(source, query) {
  const searchable = normalizeSource(source);
  const normalizedQuery = normalize(query);
  if (!normalizedQuery || !searchable) return null;

  const queryTerms = [...new Set(normalizedQuery.split(' ').filter(Boolean))];
  const termGroups = queryTerms.map((term) => {
    const splits = findTermSplits(searchable, term);
    return { term, variants: [[term], ...splits] };
  });
  const terms = [...new Set(termGroups.flatMap((group) => group.variants.flat()))];
  const occurrencesByTerm = new Map();
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

  const candidates = anchors.map(({ range }) => {
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
      nearbyGroupCount,
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
      a.anchor.start - b.anchor.start,
  )[0];
  if (!bestCandidate) return null;

  let score = 0;
  if (phraseMatches.length > 0) score += 100;
  if (matchedGroups.length === termGroups.length) score += 50;
  score += matchedTerms.length * 10;
  score += Math.min(matchCount, 20) * 2;
  score += bestCandidate.proximityScore + bestCandidate.sectionScore;

  return { score, matchedTerms, matchCount, section: bestCandidate.section, snippet: buildSnippet(searchable, bestCandidate) };
}

async function mapWithConcurrency(items, worker, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function consume() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => consume()));
  return results;
}

// ── 检索实现 ────────────────────────────────────────────────

async function searchMetadata(kb, index, query, limit) {
  return index
    .map((item) => ({ item, score: scoreItem(item, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item, score }) => ({ kb, score, file: item.file, path: `cases/${item.file}`, item }));
}

async function searchFullText(kb, index, query, limit) {
  const sources = await mapWithConcurrency(
    index,
    async (item) => {
      const relPath = `cases/${item.file}`;
      return { item, relPath, source: await fetchSource(kb, relPath) };
    },
    SOURCE_FETCH_CONCURRENCY,
  );

  return sources
    .map(({ item, relPath, source }) => {
      const match = matchFullText(source, query);
      if (!match) return null;
      return {
        kb, score: match.score,
        company: item.company ?? item.short ?? item.file,
        short: item.short, code: item.code, board: item.board, lawyer: item.lawyer,
        file: item.file, path: relPath,
        matchedTerms: match.matchedTerms, matchCount: match.matchCount,
        section: match.section, snippet: match.snippet, item,
      };
    })
    .filter((x) => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── 工具实现 ────────────────────────────────────────────────

async function toolListKbs() {
  return KB_IDS.map((id) => ({ ...KBS[id], repo: REPO, branch: BRANCH }));
}

async function toolSearch({ kb = 'ipo', query, limit = 10 }) {
  assertKb(kb);
  const index = await loadIndex(kb);
  const candidateLimit = Math.max(limit * 3, 30);

  const [metaResults, fulltextResults] = await Promise.all([
    searchMetadata(kb, index, query, candidateLimit),
    searchFullText(kb, index, query, candidateLimit),
  ]);

  const maxMetaScore = metaResults.length > 0 ? Math.max(...metaResults.map((r) => r.score)) : 0;
  const maxFullTextScore = fulltextResults.length > 0 ? Math.max(...fulltextResults.map((r) => r.score)) : 0;

  const mergedMap = new Map();
  for (const meta of metaResults) {
    mergedMap.set(meta.path, { item: meta.item, path: meta.path, metaHit: meta });
  }
  for (const ft of fulltextResults) {
    const existing = mergedMap.get(ft.path);
    if (existing) existing.fulltextHit = ft;
    else mergedMap.set(ft.path, { item: ft.item, path: ft.path, fulltextHit: ft });
  }

  const unifiedResults = Array.from(mergedMap.values()).map(({ item, path, metaHit, fulltextHit }) => {
    const match_types = [];
    if (metaHit) match_types.push('metadata');
    if (fulltextHit) match_types.push('fulltext');
    const metadata_score = metaHit ? metaHit.score : 0;
    const fulltext_score = fulltextHit ? fulltextHit.score : 0;
    const metaNorm = maxMetaScore > 0 ? (metadata_score / maxMetaScore) * 50 : 0;
    const ftNorm = maxFullTextScore > 0 ? (fulltext_score / maxFullTextScore) * 50 : 0;
    const bonus = metaHit && fulltextHit ? 20 : 0;
    const score = Math.round((metaNorm + ftNorm + bonus) * 100) / 100;
    return {
      kb, company: item.company ?? item.short ?? item.file,
      short: item.short ?? '', code: item.code ?? '', board: item.board ?? '',
      lawyer: item.lawyer ?? '', file: item.file, path, match_types, score,
      metadata_score, fulltext_score,
      section: fulltextHit?.section,
      snippets: fulltextHit?.snippet ? [fulltextHit.snippet] : [],
      matchedTerms: fulltextHit?.matchedTerms ?? [],
    };
  });

  unifiedResults.sort((a, b) => b.score - a.score);
  return unifiedResults.slice(0, limit);
}

async function toolSearchKb({ kb = 'ipo', query, limit = 10 }) {
  assertKb(kb);
  const index = await loadIndex(kb);
  const results = await searchMetadata(kb, index, query, limit);
  return results.map(({ item, score, path }) => ({ kb, score, ...item, path }));
}

async function toolSearchFulltext({ kb = 'ipo', query, limit = 10 }) {
  assertKb(kb);
  const index = await loadIndex(kb);
  const results = await searchFullText(kb, index, query, limit);
  return results.map(({ kb: k, score, company, file, path, matchedTerms, matchCount, section, snippet }) => ({
    kb: k, score, company, file, path, matchedTerms, matchCount, section, snippet,
  }));
}

async function toolReadSource({ kb = 'ipo', path: relPath }) {
  assertKb(kb);
  const normalizedPath = relPath.replace(/^\/+/, '');
  if (!normalizedPath.startsWith('cases/') || !normalizedPath.endsWith('.md') || normalizedPath.includes('..')) {
    throw new Error('Only Markdown files under cases/ can be read.');
  }
  return fetchSource(kb, normalizedPath);
}

function assertKb(kb) {
  if (!KB_IDS.includes(kb)) {
    throw new Error(`Unsupported knowledge base: ${kb}（可选：${KB_IDS.join(' / ')}）`);
  }
}

// ── MCP 工具清单与 JSON-RPC 分发 ────────────────────────────

const kbSchema = { type: 'string', enum: KB_IDS, default: 'ipo', description: '知识库：ipo=2026年度, ipo2025, ipo2024, ipo2023' };

const TOOLS = [
  {
    name: 'list_kbs',
    description: '列出当前已接入的法律知识库。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => toolListKbs(),
  },
  {
    name: 'search',
    description: '统一法律知识库检索，同时检索结构化元数据和案例正文，日常检索优先使用本工具；命中后建议调用 read_source 核验原文。',
    inputSchema: {
      type: 'object',
      properties: { kb: kbSchema, query: { type: 'string', minLength: 1, description: '检索关键词，多个关键词用空格分隔' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
      required: ['query'],
      additionalProperties: false,
    },
    handler: (args) => toolSearch(args),
  },
  {
    name: 'search_kb',
    description: '按公司、证券代码、板块、律师、标签和文件名检索知识库索引。第一版为元数据关键词检索。',
    inputSchema: {
      type: 'object',
      properties: { kb: kbSchema, query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
      required: ['query'],
      additionalProperties: false,
    },
    handler: (args) => toolSearchKb(args),
  },
  {
    name: 'search_fulltext',
    description: '遍历知识库 cases/*.md 做全文关键词检索，返回公司、文件、匹配关键词和命中片段。多个关键词请用空格分隔。',
    inputSchema: {
      type: 'object',
      properties: { kb: kbSchema, query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
      required: ['query'],
      additionalProperties: false,
    },
    handler: (args) => toolSearchFulltext(args),
  },
  {
    name: 'read_source',
    description: '读取知识库中的原始 Markdown（kb 对应年度目录），用于在检索命中后核验完整上下文。path 使用检索结果中的 path（如 cases/xxx.md）。',
    inputSchema: {
      type: 'object',
      properties: { kb: kbSchema, path: { type: 'string', minLength: 1, description: '形如 cases/001220-世盟股份.md' } },
      required: ['path'],
      additionalProperties: false,
    },
    handler: (args) => toolReadSource(args),
  },
];

const SERVER_INFO = { name: 'legal-knowledge-mcp', version: '0.2.0' };

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function dispatchTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.handler(args ?? {});
}

async function handleRpc(message) {
  const { id, method, params } = message;
  if (id === undefined || id === null) {
    // notification
    return null;
  }
  switch (method) {
    case 'initialize':
      return jsonRpcResult(id, {
        protocolVersion: params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return jsonRpcResult(id, {});
    case 'tools/list':
      return jsonRpcResult(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call': {
      try {
        const result = await dispatchTool(params?.name, params?.arguments);
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return jsonRpcResult(id, { content: [{ type: 'text', text }] });
      } catch (error) {
        return jsonRpcResult(id, {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        });
      }
    }
    case 'resources/list':
      return jsonRpcResult(id, { resources: [] });
    case 'prompts/list':
      return jsonRpcResult(id, { prompts: [] });
    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ── HTTP 服务 ───────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, MCP-Session-Id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (AUTH_TOKEN) {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  if (req.method === 'GET') {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ ok: true, server: SERVER_INFO, kbs: KB_IDS }));
      return;
    }
    res.writeHead(405, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'Method Not Allowed（请用 POST /mcp）' }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }
  if (!req.url || !req.url.startsWith('/mcp')) {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Not Found（MCP 端点为 POST /mcp）' }));
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const messages = Array.isArray(payload) ? payload : [payload];
  const responses = (await Promise.all(messages.map((m) => handleRpc(m)))).filter(Boolean);
  const out = Array.isArray(payload) ? responses : responses[0] ?? null;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (out === null) res.end();
  else res.end(JSON.stringify(out));
});

server.listen(PORT, HOST, () => {
  console.log(`[${new Date().toISOString()}] legal-knowledge-mcp ${SERVER_INFO.version} listening on http://${HOST}:${PORT}/mcp`);
  console.log(`  kb: ${KB_IDS.join(', ')}`);
  console.log(`  data: ${LOCAL_ROOT ? `local ${LOCAL_ROOT}` : `github ${REPO}@${BRANCH}`}`);
  console.log(`  auth: ${AUTH_TOKEN ? 'Bearer token enabled' : 'WARNING: no AUTH_TOKEN set'}`);
});
