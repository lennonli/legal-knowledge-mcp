# legal-knowledge-mcp

统一法律知识库 MCP Server。

当前第一阶段只接入 `lennonli/ipo-inquiry-kb`，直接读取 GitHub 中现有的 `scripts/index.json` 和 `cases/*.md`，不合并原始 Markdown，不使用向量数据库。

## 第一版工具

- `list_kbs`：列出已接入的知识库
- `search_kb`：基于现有 `index.json` 的元数据进行关键词检索
- `search_fulltext`：遍历 `cases/*.md` 进行全文关键词检索，按完整短语、关键词覆盖、词间距离和出现次数排序，返回公司、文件、匹配关键词、命中次数、章节和片段
- `read_source`：读取命中案例的 GitHub 原始 Markdown 全文，用于核验和分析

全文检索示例：

```text
search_fulltext(kb="ipo", query="劳务派遣 超过10%", limit=5)
```

多个关键词请用空格分隔。`matchCount` 为各关键词在案例中的命中次数总和；`section` 优先返回具体问题、问询、核查或整改章节。检索命中后，建议继续调用 `read_source` 读取对应 `path` 的完整案例。

## 运行要求

- Node.js 20+
- npm

## 本地运行

```bash
npm install
npm start
```

MCP Server 使用 stdio 传输。后续将逐步增加 Hybrid Search、Embedding、增量索引和更多法律知识库。
