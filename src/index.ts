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
    const results = index
      .map((item) => ({ item, score: scoreItem(item, query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ item, score }) => ({
        kb: 'ipo',
        score,
        ...item,
        path: `cases/${item.file}`,
      }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2),
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
