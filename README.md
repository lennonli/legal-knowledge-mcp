# legal-knowledge-mcp

统一法律知识库 MCP Server。

当前接入 `lennonli/ipo-inquiry-kb`，直接读取 GitHub 中现有的 `scripts/index.json` 和 `cases/*.md`，不合并原始 Markdown，不使用向量数据库。

## MCP 工具说明

### 日常默认检索工具
- `search`：**统一检索工具（日常优先推荐）**。同时检索结构化元数据和案例正文，两路归一化加权评分与去重合并，返回最相关的案例列表与正文片段。

### 专项/调试工具
- `list_kbs`：列出已接入的知识库列表与元数据信息。
- `search_kb`：**专项/调试工具**。仅基于 `index.json` 的结构化元数据（公司、代码、板块、律师、标签等）进行检索。
- `search_fulltext`：**专项/调试工具**。仅遍历 `cases/*.md` 进行正文全文关键词检索。

### 最终原文核验工具
- `read_source`：**原文核验工具**。根据检索结果的 `path` 读取 GitHub 原始 Markdown 全文，做最终深度法律分析与事实核验。

## 检索示例

日常统一检索：

```text
search(kb="ipo", query="劳务派遣 超过10%", limit=5)
```

读取原文核验：

```text
read_source(kb="ipo", path="cases/001220-世盟股份.md")
```

## 运行要求

- Node.js 20+
- npm

## 本地运行与构建

```bash
npm install
npm run build
npm start
```

MCP Server 使用 stdio 传输。后续将逐步增加 Hybrid Search、Embedding、增量索引和更多法律知识库。
