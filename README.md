# legal-knowledge-mcp

统一法律知识库 MCP Server（无状态 Streamable HTTP）。v0.2.0 起零依赖（仅 Node ≥ 18），
数据源为 `lennonli/ipo-inquiry-kb` monorepo（按年度子目录），四个知识库：
`ipo`（2026）/ `ipo2025` / `ipo2024` / `ipo2023`。

## 工具

- `search`：**统一检索（日常优先）**。元数据 + 正文两路归一化加权合并，近邻/章节/分词加权。
- `list_kbs`：列出知识库。
- `search_kb`：仅元数据（公司、代码、板块、律师、标签）。
- `search_fulltext`：仅正文全文关键词检索（空格分隔多关键词）。
- `read_source`：按检索结果的 `path`（如 `cases/xxx.md`）读取该库原文。

## 部署（Mac mini，cloudflared → 本端口）

```bash
# 必填环境变量
PORT=8787                        # 监听端口
AUTH_TOKEN=<Bearer Token>        # 客户端 Authorization: Bearer <token>
# 可选：直读本地 monorepo 克隆（免 GitHub raw，推荐生产用）
KB_LOCAL_ROOT=/Users/licheng/Documents/Macbook-pro项目/19-IPO问询案例知识库
HOST=0.0.0.0                     # 默认 0.0.0.0

npm start                        # 或 node server.mjs
```

本地开发测试（直读本机克隆，无需 GitHub）：

```bash
PORT=8999 AUTH_TOKEN=test KB_LOCAL_ROOT=~/Documents/Macbook-pro项目/19-IPO问询案例知识库 node server.mjs
```

## 端点

- `POST /mcp`：JSON-RPC（initialize / tools/list / tools/call，无状态，支持批量）
- `GET /health`：健康检查（无需 token 也可配 AUTH_TOKEN 后需带）
