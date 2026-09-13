// ============================================================
// OICOS Message — 消息类型 & 可审计消息流
// ============================================================
// 核心原则：所有输出都进入状态机，不是聊天文本

import crypto from 'crypto'

// ---------- 消息类型常量 ----------

export const MessageType = {
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL_USE: 'tool_use',
  TOOL_RESULT: 'tool_result',
  SYSTEM: 'system',
  ERROR: 'error',
  COMPACT_BOUNDARY: 'compact_boundary',
}

// ---------- 工厂函数 ----------

let _seq = 0
function nextId() {
  return `msg_${Date.now().toString(36)}_${(++_seq).toString(36)}_${crypto.randomUUID().slice(0, 8)}`
}

/**
 * 创建用户消息
 */
export function createUserMessage(content, extra = {}) {
  return {
    id: nextId(),
    type: MessageType.USER,
    role: 'user',
    content,
    createdAt: Date.now(),
    ...extra,
  }
}

/**
 * 创建助手消息（含可能的工具调用）
 * @param {string} text — 文本内容
 * @param {Array} [toolCalls] — [{ id, name, input }]
 */
export function createAssistantMessage(text, toolCalls = [], reasoningContent = '') {
  return {
    id: nextId(),
    type: MessageType.ASSISTANT,
    role: 'assistant',
    content: text || '',
    toolCalls,
    reasoningContent: reasoningContent || '',
    createdAt: Date.now(),
  }
}

/**
 * 创建工具结果消息
 */
export function createToolResultMessage(toolUseId, output, isError = false) {
  return {
    id: nextId(),
    type: MessageType.TOOL_RESULT,
    role: 'tool',
    content: typeof output === 'string' ? output : JSON.stringify(output),
    toolUseId,
    isError,
    createdAt: Date.now(),
  }
}

// ---------- MessageStore — 可审计消息流 ----------

export class MessageStore {
  constructor(initialMessages = []) {
    /** @type {import('./types.js').Message[]} */
    this._messages = [...initialMessages]
    this._compactBoundaries = []  // 压缩边界索引
  }

  /** 当前消息数 */
  get length() {
    return this._messages.length
  }

  /** 获取所有消息 */
  getAll() {
    return [...this._messages]
  }

  /** 获取第 n 条 */
  get(index) {
    return this._messages[index]
  }

  /** 最后一条 */
  get last() {
    return this._messages[this._messages.length - 1]
  }

  /** 追加消息 */
  push(...messages) {
    this._messages.push(...messages)
  }

  /** 转换为 LLM API 格式 */
  toLLMMessages() {
    const result = []
    for (const msg of this._messages) {
      switch (msg.type) {
        case MessageType.USER:
          result.push({ role: 'user', content: msg.content })
          break
        case MessageType.ASSISTANT: {
          const entry = { role: 'assistant', content: msg.content || '' }
          if (msg.reasoningContent) {
            entry.reasoning_content = msg.reasoningContent
          }
          if (msg.toolCalls?.length > 0) {
            entry.tool_calls = msg.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            }))
          }
          result.push(entry)
          break
        }
        case MessageType.TOOL_RESULT:
          result.push({
            role: 'tool',
            tool_call_id: msg.toolUseId,
            content: msg.content,
          })
          break
        case MessageType.SYSTEM:
          // system 消息在 prompt 层单独处理
          break
        default:
          break
      }
    }
    return result
  }

  /** 从后往前找最近 N 条 USER 和 ASSISTANT 消息 */
  getLastTurns(n) {
    const relevant = this._messages.filter(
      m => m.type === MessageType.USER || m.type === MessageType.ASSISTANT
    )
    return relevant.slice(-n)
  }

  /** 记录压缩边界 */
  markCompactBoundary(summary) {
    this._compactBoundaries.push({
      index: this._messages.length,
      summary,
      timestamp: Date.now(),
    })
  }

  /** 获取压缩边界信息 */
  getCompactBoundaries() {
    return [...this._compactBoundaries]
  }

  /** 获取上次压缩后的消息（从最后一个压缩边界之后） */
  getMessagesAfterLastCompact() {
    if (this._compactBoundaries.length === 0) return this._messages
    const last = this._compactBoundaries[this._compactBoundaries.length - 1]
    return this._messages.slice(last.index)
  }

  /** 序列化（用于持久化） */
  serialize() {
    return {
      messages: this._messages,
      compactBoundaries: this._compactBoundaries,
    }
  }

  /** 反序列化 */
  static deserialize(data) {
    const store = new MessageStore(data.messages)
    store._compactBoundaries = data.compactBoundaries || []
    return store
  }
}
