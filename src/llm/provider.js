// ============================================================
// LLM Provider 抽象层 — 可插拔
// ============================================================
// 支持: DeepSeek / Ollama / vLLM / OpenAI / 任何 OpenAI 兼容 API
// 用法:
//   const provider = createProvider(config)
//   for await (const chunk of provider.stream(messages, tools)) { ... }

import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')

// ---------- 类型定义 ----------

/** @typedef {{ role: 'user'|'assistant'|'system'|'tool', content: string, tool_call_id?: string, name?: string }} LLMMessage */

/** @typedef {{ type: 'function', function: { name: string, description: string, parameters: object } }} LLMToolDef */

/** @typedef {{ type: 'text'|'tool_use', text?: string, id?: string, name?: string, input?: object }} LLMContentBlock */

/** @typedef {{ content: LLMContentBlock[], role: 'assistant', stop_reason?: string, usage?: object }} LLMResponse */

// ---------- 配置加载 ----------

export function loadConfig() {
  const cfgPath = path.join(ROOT, 'config.yaml')
  if (!fs.existsSync(cfgPath)) throw new Error('config.yaml not found')
  const raw = yaml.load(fs.readFileSync(cfgPath, 'utf8'))
  
  // 环境变量替换
  const providerName = raw.provider || 'deepseek'
  const pcfg = raw[providerName]
  if (!pcfg) throw new Error(`Provider "${providerName}" not configured`)
  
  pcfg.api_key = pcfg.api_key?.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] || '')
  pcfg.base_url = pcfg.base_url?.replace(/\/+$/, '')
  
  return { system: raw.system, tools: raw.tools, permissions: raw.permissions, ...raw, providerName, pcfg }
}

// ---------- 抽象 Provider ----------

/**
 * 创建 LLM Provider
 * @param {object} cfg — 配置对象 (loadConfig 返回值)
 * @returns {{ stream: Function, complete: Function }}
 */
export function createProvider(cfg) {
  const { pcfg, providerName } = cfg
  
  const baseUrl = pcfg.base_url
  const apiKey = pcfg.api_key
  const model = pcfg.model
  const maxTokens = pcfg.max_tokens || 4096
  const temperature = pcfg.temperature ?? 0.3
  
  /**
   * 流式调用模型
   * @param {LLMMessage[]} messages
   * @param {LLMToolDef[]} tools
   * @yields {LLMContentBlock}
   */
  async function* stream(messages, tools = []) {
    const body = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
      ...(tools.length > 0 && {
        tools: tools.map(t => ({
          type: 'function',
          function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          }
        }))
      }),
    }
    
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && { 'Authorization': `Bearer ${apiKey}` }),
      },
      body: JSON.stringify(body),
    })
    
    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`LLM API error ${response.status}: ${errText.slice(0, 200)}`)
    }
    
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    
    // 累积工具调用（流式片段）
    let currentToolUse = null  // { id, name, input: string }
    
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') break
        
        try {
          const chunk = JSON.parse(data)
          const delta = chunk.choices?.[0]?.delta
          if (!delta) continue
          
          // 文本内容
          if (delta.content) {
            yield { type: 'text', text: delta.content }
          }
          
          // v4-pro thinking模式：reasoning_content
          if (delta.reasoning_content) {
            yield { type: 'reasoning', text: delta.reasoning_content }
          }
          
          // 工具调用
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!currentToolUse) {
                currentToolUse = { id: tc.id || '', name: tc.function?.name || '', input: '' }
              }
              if (tc.function?.arguments) {
                currentToolUse.input += tc.function.arguments
              }
              // 当 id 在流中间才出现
              if (tc.id) currentToolUse.id = tc.id
              if (tc.function?.name) currentToolUse.name = tc.function.name
            }
          }
          
          // 检查结束了，如果有工具调用则输出
          const finishReason = chunk.choices?.[0]?.finish_reason
          if (finishReason === 'tool_calls' && currentToolUse) {
            let parsedInput = {}
            try { parsedInput = JSON.parse(currentToolUse.input) } catch {}
            yield {
              type: 'tool_use',
              id: currentToolUse.id,
              name: currentToolUse.name,
              input: parsedInput,
            }
            currentToolUse = null
          }
          if (finishReason === 'stop') {
            // 如果有未完成的工具调用，也发出去
            if (currentToolUse) {
              let parsedInput = {}
              try { parsedInput = JSON.parse(currentToolUse.input) } catch {}
              yield {
                type: 'tool_use',
                id: currentToolUse.id,
                name: currentToolUse.name,
                input: parsedInput,
              }
              currentToolUse = null
            }
          }
        } catch (e) {
          // 忽略解析失败的 chunk
        }
      }
    }
  }
  
  /**
   * 非流式完整调用
   */
  async function complete(messages, tools = []) {
    const body = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
      ...(tools.length > 0 && { tools }),
    }
    
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && { 'Authorization': `Bearer ${apiKey}` }),
      },
      body: JSON.stringify(body),
    })
    
    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`LLM API error ${response.status}: ${errText.slice(0, 200)}`)
    }
    
    return await response.json()
  }
  
  return { stream, complete, model, providerName }
}
