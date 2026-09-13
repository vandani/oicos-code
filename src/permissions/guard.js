// ============================================================
// OICOS PermissionGuard — 风控闸门
// OICOS PermissionGuard — 风控闸门 (v2 — 5级信任层级)
// 核心原则：权限不是 UI 弹窗，是执行前的审查管道
// 层级：plan(只读) < default(询问破坏性) < acceptEdits(自动接受编辑) < bypassPermissions(全自动)

/** 权限模式 */
export const PERMISSION_MODES = {
  PLAN: 'plan',                   // 只读探索，拒绝所有写操作
  DEFAULT: 'default',             // 询问破坏性操作（默认）
  ACCEPT_EDITS: 'acceptEdits',    // 自动接受Edit，Bash/Git需询问
  BYPASS: 'bypassPermissions',    // 全自动放行（危险，需显式开启）
  BUBBLE: 'bubble',              // 子代理模式（提示浮到父终端）
}

/**
 * 权限结果
 * @typedef {'allow'|'deny'|'ask'} PermissionDecision
 * @typedef {{ decision: PermissionDecision, reason?: string, updatedInput?: object }} PermissionResult
 */

export class PermissionGuard {
  /**
   * @param {object} rules — { mode, alwaysAllow, alwaysDeny, alwaysAsk }
   */
  constructor(rules = {}) {
    this._mode = rules.mode || PERMISSION_MODES.DEFAULT
    this._rules = {
      alwaysAllow: rules.alwaysAllow || [],
      alwaysDeny: rules.alwaysDeny || [],
      alwaysAsk: rules.alwaysAsk || [],
    }
    this._sessionGrants = new Map()
    this._denialLog = []
  }

  /** 获取/设置当前模式 */
  get mode() { return this._mode }
  setMode(mode) {
    if (!Object.values(PERMISSION_MODES).includes(mode)) {
      throw new Error(`无效权限模式: ${mode}。可选: ${Object.values(PERMISSION_MODES).join('/')}`)
    }
    this._mode = mode
  }

  /** 会话中临时授权 */
  grant(toolName, inputPattern = '*') {
    if (!this._sessionGrants.has(toolName)) {
      this._sessionGrants.set(toolName, new Set())
    }
    this._sessionGrants.get(toolName).add(inputPattern)
  }

  /** 检查工具调用权限 */
  async check(tool, input, context) {
    const toolName = tool.name
    
    // 0. Plan模式：拒绝所有非只读操作
    if (this._mode === PERMISSION_MODES.PLAN) {
      if (!tool.isReadOnly?.(input)) {
        this._denialLog.push({ toolName, input, reason: 'plan mode', mode: this._mode })
        return { decision: 'deny', reason: 'Plan模式：只允许只读操作。退出plan模式以执行写操作。' }
      }
    }
    
    // Bypass模式：全部放行
    if (this._mode === PERMISSION_MODES.BYPASS) {
      return { decision: 'allow' }
    }
    
    // 1. 工具自身校验
    if (tool.validateInput) {
      const validation = await tool.validateInput(input, context)
      if (validation !== true) {
        return {
          decision: 'deny',
          reason: typeof validation === 'string' ? validation : '工具输入校验失败',
        }
      }
    }
    
    // 2. 规则匹配
    for (const pattern of this._rules.alwaysDeny) {
      if (this._matchRule(pattern, toolName, input)) {
        this._denialLog.push({ toolName, input, reason: 'alwaysDeny', pattern })
        return { decision: 'deny', reason: `规则禁止: ${pattern}` }
      }
    }
    
    for (const pattern of this._rules.alwaysAllow) {
      if (this._matchRule(pattern, toolName, input)) {
        return { decision: 'allow' }
      }
    }
    
    // 3. 会话授权
    if (this._sessionGrants.has(toolName)) {
      return { decision: 'allow' }
    }
    
    // 4. 只读工具自动放行
    if (tool.isReadOnly?.(input)) {
      return { decision: 'allow' }
    }
    
    // 5. acceptEdits模式：自动接受Edit，其他破坏性需询问
    if (this._mode === PERMISSION_MODES.ACCEPT_EDITS) {
      if (toolName === 'Edit' || toolName === 'TodoWrite') {
        return { decision: 'allow' }
      }
      if (tool.isDestructive?.(input)) {
        return { decision: 'ask', reason: '破坏性操作（非编辑），需要确认' }
      }
    }
    
    // 6. 破坏性工具必须询问
    if (tool.isDestructive?.(input)) {
      return { decision: 'ask', reason: '破坏性操作，需要确认' }
    }
    
    // 7. alwaysAsk 规则
    for (const pattern of this._rules.alwaysAsk) {
      if (this._matchRule(pattern, toolName, input)) {
        return { decision: 'ask', reason: `需要确认: ${pattern}` }
      }
    }
    
    // 8. 默认放行
    return { decision: 'allow' }
  }

  /** 获取拒绝日志 */
  getDenialLog() {
    return [...this._denialLog]
  }

  /**
   * 规则匹配
   * 格式: "toolName:pattern" 或 "toolName"
   */
  _matchRule(rule, toolName, input) {
    const [ruleTool, ...rest] = rule.split(':')
    if (ruleTool !== toolName && ruleTool !== '*') return false
    
    if (rest.length === 0) return true  // 只匹配工具名
    
    const pattern = rest.join(':')
    const inputStr = JSON.stringify(input)
    return inputStr.includes(pattern) || this._globMatch(pattern, inputStr)
  }

  /** 简易 glob 匹配 */
  _globMatch(pattern, str) {
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
    )
    return regex.test(str)
  }
}
