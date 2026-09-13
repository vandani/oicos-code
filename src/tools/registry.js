// ============================================================
// OICOS Tool Protocol — 可审查行动单元
// ============================================================
// 每个工具 = 可审查、可授权、可渲染、可并行、可记录的行动单元

/**
 * @typedef {Object} ToolDef
 * @property {string} name — 工具名
 * @property {string[]} [aliases] — 别名
 * @property {string} description — 工具描述
 * @property {Object} inputSchema — JSON Schema
 * @property {function} call — (args, context) => Promise<{ data, isError }>
 * @property {function} [validateInput] — 自定义校验
 * @property {function} [isReadOnly] — 是否只读
 * @property {function} [isDestructive] — 是否破坏性
 * @property {function} [isConcurrencySafe] — 能否并行
 * @property {number} [maxResultSize] — 结果大小上限
 */

// ---------- ToolRegistry — 工具注册中心 ----------

export class ToolRegistry {
  constructor() {
    /** @type {Map<string, ToolDef>} */
    this._tools = new Map()
    this._aliasMap = new Map()
  }

  /** 注册工具 */
  register(tool) {
    this._tools.set(tool.name, tool)
    if (tool.aliases) {
      for (const alias of tool.aliases) {
        this._aliasMap.set(alias, tool.name)
      }
    }
    return this
  }

  /** 批量注册 */
  registerAll(tools) {
    for (const t of tools) this.register(t)
    return this
  }

  /** 按名称查找（含别名） */
  find(name) {
    // 直接查找
    let tool = this._tools.get(name)
    if (tool) return tool
    
    // 别名查找
    const canonical = this._aliasMap.get(name)
    if (canonical) return this._tools.get(canonical)
    
    return undefined
  }

  /** 获取所有工具 */
  getAll() {
    return Array.from(this._tools.values())
  }

  /** 获取 LLM API 格式的工具定义 */
  toLLMTools() {
    return this.getAll().map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))
  }

  /** 获取只读工具列表 */
  getReadOnlyTools() {
    return this.getAll().filter(t => t.isReadOnly?.())
  }

  /** 获取破坏性工具列表 */
  getDestructiveTools() {
    return this.getAll().filter(t => t.isDestructive?.())
  }
}

// ---------- 工具定义帮助函数 ----------

/**
 * 创建工具定义
 * @param {string} name
 * @param {object} def
 * @returns {ToolDef}
 */
export function defineTool(name, def) {
  return {
    name,
    aliases: def.aliases || [],
    description: def.description || '',
    inputSchema: def.inputSchema || {
      type: 'object',
      properties: {},
    },
    call: def.call,
    validateInput: def.validateInput,
    isReadOnly: def.isReadOnly || (() => false),
    isDestructive: def.isDestructive || (() => false),
    isConcurrencySafe: def.isConcurrencySafe || (() => true),
    maxResultSize: def.maxResultSize || 50000,
  }
}
