# legal-knowledge-mcp

统一法律知识库 MCP Server。

当前第一阶段只接入 `lennonli/ipo-inquiry-kb`，直接读取 GitHub 中现有的 `scripts/index.json` 和 `cases/*.md`，不合并原始 Markdown，不使用向量数据库。

## 第一版工具

- `list_kbs`：列出已接入的知识库
- `search_kb`：基于现有 `index.json` 的元数据进行关键词检索
- `read_source`：读取命中案例的 GitHub 原始 Markdown 全文，用于核验和分析

## 运行要求

- Node.js 20+
- npm

## 本地运行

```bash
npm install
npm start
```

MCP Server 使用 stdio 传输。后续将逐步增加全文检索、Hybrid Search、Embedding、增量索引和更多法律知识库。
