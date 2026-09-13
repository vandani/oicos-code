// ============================================================
// OICOS MCP 接口 — 外部工具连接抽象
// ============================================================
// MCP = Model Context Protocol
// 为将来连接外部工具服务预留接口
// 支持: 本地 MCP 服务器, 远程 MCP 服务器, HTTP/SSE 传输

import { defineTool } from '../tools/registry.js'

/**
 * MCP 服务器连接配置
 * @typedef {Object} MCPServerConfig
 * @property {string} name — 服务器名称
 * @property {string} type — 'stdio' | 'http' | 'sse'
 * @property {string} [command] — stdio 模式: 启动命令
 * @property {string[]} [args] — stdio 模式: 命令参数
 * @property {string} [url] — http/sse 模式: 服务器 URL
 * @property {Object} [env] — 环境变量
 */

/**
 * MCP 客户端
 * 管理 MCP 服务器连接和工具发现
 */
export class MCPClient {
  constructor() {
    /** @type {Map<string, MCPServerConnection>} */
    this._servers = new Map()
    /** @type {Map<string, import('../tools/registry.js').ToolDef>} */
    this._discoveredTools = new Map()
    this._connected = false
  }

  /** 是否已连接 */
  get isConnected() { return this._connected }
  
  /** 已发现的 MCP 工具 */
  get tools() { return Array.from(this._discoveredTools.values()) }
  
  /** 服务器列表 */
  get servers() { return Array.from(this._servers.keys()) }

  /**
   * 添加服务器配置（暂不连接）
   */
  addServer(config) {
    this._servers.set(config.name, {
      config,
      status: 'pending',
      tools: [],
    })
  }

  /**
   * 连接到所有已配置的 MCP 服务器并发现工具
   */
  async connectAll() {
    // TODO: 实际 MCP 协议实现
    // 当前为接口占位
    this._connected = true
    return { connected: this._servers.size, failed: 0 }
  }

  /**
   * 断开所有连接
   */
  async disconnectAll() {
    this._discoveredTools.clear()
    this._connected = false
    for (const [name] of this._servers) {
      this._servers.set(name, { config: this._servers.get(name).config, status: 'disconnected', tools: [] })
    }
  }

  /**
   * 将 MCP 工具注册到 ToolRegistry
   * @param {import('../tools/registry.js').ToolRegistry} registry
   */
  registerTools(registry) {
    for (const tool of this._discoveredTools.values()) {
      registry.register(tool)
    }
  }

  /**
   * 创建 MCP 工具定义
   * @param {string} serverName
   * @param {object} mcpTool — MCP 协议工具定义
   * @returns {import('../tools/registry.js').ToolDef}
   */
  _createMCPTool(serverName, mcpTool) {
    const fullName = `mcp__${serverName}__${mcpTool.name}`
    
    return defineTool(fullName, {
      aliases: [mcpTool.name],
      description: `[MCP/${serverName}] ${mcpTool.description || ''}`,
      inputSchema: mcpTool.input_schema || {
        type: 'object',
        properties: {},
      },
      isReadOnly: () => false,
      isDestructive: () => true,
      isConcurrencySafe: () => true,
      maxResultSize: 1000000,
      
      call: async (args, context) => {
        // TODO: 实际 MCP 工具调用
        // 通过 MCP 协议向服务器发送工具调用请求
        return { data: { _mcp: true, server: serverName, tool: mcpTool.name, args }, isError: false }
      },
    })
  }
}

/**
 * 从 config.yaml 加载 MCP 服务器配置
 */
export function loadMCPServersFromConfig(config) {
  const client = new MCPClient()
  const mcpServers = config.mcp_servers || {}
  
  for (const [name, cfg] of Object.entries(mcpServers)) {
    client.addServer({
      name,
      type: cfg.type || 'stdio',
      command: cfg.command,
      args: cfg.args,
      url: cfg.url,
      env: cfg.env,
    })
  }
  
  return client
}
