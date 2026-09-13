// ============================================================
// OICOS QueryEngine — 会话生命周期状态机内核 (v2)
// ============================================================
// 更新:
//   - 集成 SessionStore 持久化
//   - 自动上下文压缩触发器
//   - 工具结果磁盘溢出持久化
//   - 错误重试机制

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { MessageStore, createUserMessage, createAssistantMessage, createToolResultMessage, MessageType } from './message.js'
import { SessionStore } from './session.js'
import { estimateMessageTokens } from '../compact/compressor.js'

const OVERFLOW_DIR = path.resolve(process.env.OICOS_DATA_DIR || path.join(process.env.HOME || '/tmp', '.oicos', 'overflow'))

export class QueryEngine {
  constructor(config) {
    this.provider = config.provider
    this.tools = config.tools
    this.permissions = config.permissions
    this.compressor = config.compressor
    this.prompts = config.prompts
    this.systemConfig = config.system || {}

    this.sessionStore = new SessionStore()
    this.sessionStore.meta.model = this.provider.model
    this.sessionStore.meta.provider = this.provider.providerName

    this.turnCount = 0
    this.totalUsage = { input_tokens: 0, output_tokens: 0 }
    this.startTime = Date.now()
    this._aborted = false
    this._lastCompactTokenCount = 0
  }

  get store() { return this.sessionStore.store }
  get meta() { return this.sessionStore.meta }
  get sessionId() { return this.meta.id }

  abort() {
    this._aborted = true
  }

  getStats() {
    return {
      sessionId: this.sessionId,
      turnCount: this.turnCount,
      messageCount: this.store.length,
      totalUsage: this.totalUsage,
      duration: Date.now() - this.startTime,
      created: new Date(this.meta.created).toLocaleString(),
      model: this.meta.model,
    }
  }

  /** 持久化工具结果到磁盘（防止撑爆上下文） */
  async _persistToolResult(toolName, data) {
    const maxSize = this.systemConfig.max_result_size_chars || 50000
    const text = typeof data === 'string' ? data : JSON.stringify(data)
    
    if (text.length <= maxSize) return { data, persisted: false }
    
    // 需要持久化
    if (!fs.existsSync(OVERFLOW_DIR)) {
      fs.mkdirSync(OVERFLOW_DIR, { recursive: true })
    }
    
    const hash = crypto.createHash('md5').update(text).digest('hex').slice(0, 12)
    const filename = `${toolName}_${hash}_${Date.now().toString(36)}.overflow`
    const filepath = path.join(OVERFLOW_DIR, filename)
    
    await fsp.writeFile(filepath, text, 'utf8')
    
    const preview = text.slice(0, 2000)
    return {
      data: {
        _persisted: true,
        _path: filepath,
        _size: text.length,
        _preview: preview,
        _message: `工具结果过大 (${(text.length / 1024).toFixed(1)}KB)，已持久化到 ${filepath}`,
      },
      persisted: true,
    }
  }

  /** 自动上下文压缩检查 */
  async _autoCompact() {
    if (!this.compressor) return false
    
    const messages = this.store.getAll()
    const tokenCount = estimateMessageTokens(messages)
    
    // 只在 token 增长超过阈值时才压缩
    if (tokenCount - this._lastCompactTokenCount < this.compressor.threshold * 0.3) return false
    if (!this.compressor.shouldCompact(messages)) return false
    
    const result = await this.compressor.compact(this.store)
    if (!result) return false
    
    this.store.markCompactBoundary(result.summary)
    this._lastCompactTokenCount = result.compactedTokenCount
    this.sessionStore.markDirty()
    
    return result
  }

  /**
   * 提交用户输入 — 状态机推进
   * @param {string} prompt
   * @yields {object}
   */
  async *submitMessage(prompt) {
    if (this._aborted) throw new Error('Session aborted')
    this.turnCount++
    this.meta.turnCount = this.turnCount
    
    // ---------- 阶段 1: 处理用户输入 ----------
    const userMsg = createUserMessage(prompt)
    this.store.push(userMsg)
    this.sessionStore.markDirty()
    yield { type: 'user', content: prompt, turn: this.turnCount }
    
    // ---------- 阶段 2: 自动上下文压缩 ----------
    const compactResult = await this._autoCompact()
    if (compactResult) {
      yield {
        type: 'compact',
        summary: compactResult.summary,
        tokensSaved: compactResult.originalTokenCount - compactResult.compactedTokenCount,
        originalTokens: compactResult.originalTokenCount,
        compactedTokens: compactResult.compactedTokenCount,
      }
    }
    
    // ---------- 阶段 3: 系统提示词 ----------
    const systemPrompt = this.prompts?.build() || 'You are a helpful AI assistant.'
    
    // ---------- 阶段 4: 主循环 ----------
    const maxTurns = this.systemConfig.max_turns || 50
    const maxToolCalls = this.systemConfig.max_tool_calls_per_turn || 8
    let turnToolCalls = 0
    let consecutiveErrors = 0
    
    for (let loop = 0; loop < maxTurns; loop++) {
      if (this._aborted) {
        yield { type: 'error', content: 'Session aborted' }
        return
      }
      
      const llmMessages = this.store.toLLMMessages()
      const tools = this.tools.toLLMTools()
      
      try {
        const responseBlocks = []
        for await (const block of this.provider.stream(llmMessages, tools)) {
          responseBlocks.push(block)
          yield { type: 'block', ...block }
        }
        
        consecutiveErrors = 0  // 成功后重置错误计数
        
        const textBlocks = responseBlocks.filter(b => b.type === 'text')
        const toolUseBlocks = responseBlocks.filter(b => b.type === 'tool_use')
        const reasoningBlocks = responseBlocks.filter(b => b.type === 'reasoning')
        const responseText = textBlocks.map(b => b.text).join('')
        const reasoningText = reasoningBlocks.map(b => b.text).join('')
        
        // 纯文本回复
        if (toolUseBlocks.length === 0) {
          const assistantMsg = createAssistantMessage(responseText, [], reasoningText)
          this.store.push(assistantMsg)
          this.sessionStore.markDirty()
          yield { type: 'result', content: responseText, turnComplete: true }
          return
        }
        
        // 记录助手消息（含工具调用）
        const assistantMsg = createAssistantMessage(responseText, toolUseBlocks, reasoningText)
        this.store.push(assistantMsg)
        this.sessionStore.markDirty()
        
        // 执行工具调用
        for (const tc of toolUseBlocks.slice(0, maxToolCalls)) {
          turnToolCalls++
          
          const tool = this.tools.find(tc.name)
          if (!tool) {
            const result = createToolResultMessage(tc.id, `未知工具: ${tc.name}`, true)
            this.store.push(result)
            this.sessionStore.markDirty()
            yield { type: 'tool_error', tool: tc.name, error: '未知工具' }
            continue
          }
          
          // 权限检查
          const permission = await this.permissions.check(tool, tc.input, { turn: this.turnCount })
          if (permission.decision === 'deny') {
            const result = createToolResultMessage(tc.id, permission.reason || 'Permission denied', true)
            this.store.push(result)
            this.sessionStore.markDirty()
            yield { type: 'tool_denied', tool: tool.name, reason: permission.reason }
            continue
          }
          
          if (permission.decision === 'ask') {
            yield { type: 'permission_required', tool: tool.name, input: tc.input, reason: permission.reason, toolUseId: tc.id }
            // 默认放行，外部可通过 handlePermissionDecision 控制
          }
          
          // 执行工具
          try {
            yield { type: 'tool_start', tool: tool.name, input: tc.input }
            const toolResult = await tool.call(tc.input, { turn: this.turnCount })
            
            // 大结果持久化
            const { data: processedData } = await this._persistToolResult(tool.name, toolResult.data)
            
            const isError = toolResult.isError || false
            const resultMsg = createToolResultMessage(tc.id, processedData, isError)
            this.store.push(resultMsg)
            this.sessionStore.markDirty()
            
            yield {
              type: isError ? 'tool_error' : 'tool_result',
              tool: tool.name,
              output: processedData,
              persisted: processedData._persisted || false,
            }
          } catch (err) {
            const result = createToolResultMessage(tc.id, `执行错误: ${err.message}`, true)
            this.store.push(result)
            this.sessionStore.markDirty()
            yield { type: 'tool_error', tool: tool.name, error: err.message }
          }
        }
        
        // 继续循环，让 LLM 处理工具结果
        
      } catch (err) {
        consecutiveErrors++
        const errMsg = err.message || String(err)
        yield { type: 'error', content: `LLM 调用失败: ${errMsg}` }
        
        // 可重试错误
        if (consecutiveErrors < 3 && (errMsg.includes('rate limit') || errMsg.includes('timeout') || errMsg.includes('503') || errMsg.includes('429'))) {
          const delay = Math.min(2000 * consecutiveErrors, 10000)
          yield { type: 'retry', delay, attempt: consecutiveErrors }
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        
        // 不可恢复错误
        yield { type: 'error', content: `不可恢复错误，停止: ${errMsg}`, fatal: true }
        return
      }
    }
    
    yield { type: 'error', content: `达到最大轮数 (${maxTurns})` }
  }

  /** 外部设置 LLM 消息（用于 resume） */
  _restoreMessages(messages) {
    this.store._messages = messages
  }
}
