// ============================================================
// OICOS ContextCompressor — 上下文手术刀
// ============================================================
// 核心原则：不是"总结对话"，是"保留决策轨迹，砍掉噪音"
// 策略：
//   1. 保留最后 N 轮完整消息
//   2. 压缩中间轮次为结构化摘要
//   3. 保留工具调用轨迹和关键决策
//   4. 清理无效 token

/**
 * @typedef {Object} CompactResult
 * @property {Array} preservedMessages — 保留的完整消息
 * @property {string} summary — 压缩摘要
 * @property {number} originalTokenCount — 压缩前 token 数
 * @property {number} compactedTokenCount — 压缩后 token 数
 */

const AVG_CHARS_PER_TOKEN = 4  // 中文约 1.5 token/字，英文约 0.75

/** 估算 token 数 */
export function estimateTokens(text) {
  if (typeof text !== 'string') return 0
  return Math.ceil(text.length / AVG_CHARS_PER_TOKEN)
}

/** 估算消息数组 token 数 */
export function estimateMessageTokens(messages) {
  return messages.reduce((sum, m) => {
    return sum + estimateTokens(m.content || '')
  }, 0)
}

export class ContextCompressor {
  /**
   * @param {object} config
   * @param {number} config.threshold — token 超过此值触发压缩
   * @param {number} config.preserveTurns — 保留的完整轮次数
   * @param {function} config.summarizeFn — (text) => summary 的异步函数
   */
  constructor(config = {}) {
    this.threshold = config.threshold || 80000
    this.preserveTurns = config.preserveTurns || 5
    this.summarizeFn = config.summarizeFn || null
    this.stats = { compressed: 0, totalTokensSaved: 0 }
  }

  /**
   * 判断是否需要压缩
   */
  shouldCompact(messages) {
    const tokens = estimateMessageTokens(messages)
    return tokens > this.threshold
  }

  /**
   * 执行压缩
   * @param {import('./message.js').MessageStore} store
   * @returns {Promise<CompactResult|null>} 如果不需要压缩返回 null
   */
  async compact(store) {
    const messages = store.getAll()
    const originalTokens = estimateMessageTokens(messages)
    
    if (!this.shouldCompact(messages)) return null
    
    // 1. 保留最近 N 轮完整消息
    const preservedTurns = store.getLastTurns(this.preserveTurns * 2)
    
    // 2. 需要压缩的部分 = 除了最后 N 轮之外的所有消息
    const compressible = messages.slice(0, -preservedTurns.length)
    
    if (compressible.length === 0) return null
    
    // 3. 生成结构化摘要
    let summary = ''
    if (this.summarizeFn) {
      summary = await this.summarizeFn(compressible)
      if (!summary) summary = this._defaultSummarize(compressible)  // 回退
    } else {
      summary = this._defaultSummarize(compressible)
    }
    
    // 4. 构建压缩后的消息数组
    const compressedTokens = estimateTokens(summary) + estimateMessageTokens(preservedTurns)
    
    const result = {
      preservedMessages: preservedTurns,
      summary,
      originalTokenCount: originalTokens,
      compactedTokenCount: compressedTokens,
    }
    
    this.stats.compressed++
    this.stats.totalTokensSaved += originalTokens - compressedTokens
    
    return result
  }

  /**
   * 默认摘要策略（无 LLM 时使用）
   */
  _defaultSummarize(messages) {
    const parts = []
    
    // 提取用户目标
    const userMessages = messages.filter(m => m.type === 'user' || m.role === 'user')
    if (userMessages.length > 0) {
      parts.push(`用户目标: ${userMessages[0].content?.slice(0, 200)}`)
    }
    
    // 提取关键工具调用
    const toolCalls = messages.filter(m => m.toolCalls?.length > 0)
    for (const msg of toolCalls.slice(0, 10)) {
      for (const tc of msg.toolCalls) {
        parts.push(`调用工具: ${tc.name}(${JSON.stringify(tc.input).slice(0, 100)})`)
      }
    }
    
    // 提取关键输出
    const assistantMsgs = messages.filter(m => m.type === 'assistant' || m.role === 'assistant')
    const keyOutputs = assistantMsgs
      .map(m => m.content?.slice(0, 100))
      .filter(Boolean)
    
    if (keyOutputs.length > 0) {
      parts.push(`关键输出: ${keyOutputs.join(' | ').slice(0, 300)}`)
    }
    
    return parts.join('\n')
  }
}
