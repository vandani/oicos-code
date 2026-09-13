# OICOS Code

> 从零手写的本地 AI Agent 引擎 —— 让大模型在自己机器上「读代码、改代码、跑测试、自我验证」。

不是 ChatGPT 套壳，而是一个完整的 **Agent Runtime**：状态机内核 + 统一工具协议 + 权限风控 + 上下文压缩。对标 Claude Code 的核心架构，用 Node.js 无重框架实现。

## 为什么值得一看

- **10 个工具构成完整开发闭环**：读 / 搜 / 找 / 改 / 跑 / Git / Lint / Test / 待办 / 子代理
- **85 个单元测试全绿**（`npm test`）
- **5 级权限风控**：只读工具自动放行，破坏性操作需确认，`rm -rf /*` 直接拒绝
- **上下文自动压缩**：超 80K tokens 触发 9 段式摘要，长任务不崩
- **Provider 抽象**：DeepSeek / Ollama / vLLM / OpenAI 任意切换（OpenAI 兼容协议）
- **零重依赖**：核心仅依赖 `js-yaml`

## 架构

```
CLI (src/cli)
   │
QueryEngine 状态机内核 (src/core/engine.js)
   ├─ 工具执行管道：validate → 权限 → 调用 → 回填
   ├─ ToolRegistry 统一工具协议 (src/tools/registry.js)
   ├─ PromptBuilder 静态/动态分区，缓存命中跳过 (src/prompts)
   ├─ PermissionGuard 5 级风控 (src/permissions)
   ├─ ContextCompressor 阈值触发压缩 (src/compact)
   ├─ LLM Provider 抽象 (src/llm)
   ├─ SessionStore 原子写入 + resume 防损坏 (src/core/session.js)
   └─ MCP Client 服务器连接 + 工具发现 (src/mcp)
```

## 工具清单

| 工具 | 类型 | 说明 |
|------|------|------|
| Read | 只读 | 读文件（offset/limit） |
| Search | 只读 | 正则搜索文件内容 |
| Glob | 只读 | 文件名模式查找 |
| Edit/Write | 破坏性 | 文件在则替换，不在则创建（合一设计） |
| Bash | 破坏性 | 执行命令（超时 30s） |
| Lint | 只读 | ESLint / TypeScript 诊断 |
| Test | 只读 | npm test / pytest / go test |
| Git | 动态 | diff/log/status（只读）+ add/commit（破坏性） |
| TodoWrite | 写 | 多步任务清单追踪 |
| Agent | 动态 | 子代理分派（explore + general） |

每个工具带统一协议：`name / call / inputSchema / isReadOnly / isDestructive / checkPermissions`。

## 快速开始

```bash
git clone <this-repo> && cd oicos-sodex
npm install
export DEEPSEEK_API_KEY="sk-your-key"
npm start
```

切换模型：编辑 `config.yaml`（DeepSeek / Ollama / vLLM / OpenAI 均可）。

```bash
npm test    # 跑 85 个测试
```

## 设计取舍

- **Edit 与 Write 合一**：一个工具覆盖「改」和「建」，工具集少一个但能力不减。
- **状态机优先**：用户输入不是问答，是状态推进。每次 `submitMessage` = 一次状态机迭代。
- **不可逆操作必须标记**：`isDestructive()` 决定是否需要更严审批；删除/覆盖/发送类默认拒绝。
- **MCP 已接入**：通过配置即可挂载外部 MCP 服务器的工具。

## 目录结构

```
src/
├── core/          # engine.js 状态机 / session.js 会话持久化
├── tools/         # registry.js + 各工具实现
├── llm/           # provider.js 多模型抽象
├── prompts/       # sections.js 提示词分区注册器
├── permissions/   # guard.js 权限规则引擎
├── compact/       # compressor.js 上下文压缩
├── mcp/           # client.js MCP 客户端
├── cli/           # index.js 交互界面
└── test/          # run.js 测试入口
config.yaml        # 模型 + 系统 + 工具 + 风控配置
```

## License

MIT
