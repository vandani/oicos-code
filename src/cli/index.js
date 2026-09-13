// ============================================================
// OICOS CODE — CLI 入口 (v2)
// ============================================================
// 模式: 交互 / 单次 / 管道
// 新增:
//   - 会话管理 (/session, /resume, /sessions)
//   - 历史记录
//   - 进度显示
//   - /new 新建会话

import { loadConfig, createProvider } from '../llm/provider.js'
import { ToolRegistry } from '../tools/registry.js'
import { ReadTool, SearchTool, EditTool, BashTool, GitTool, LintTool, TestTool, TodoWriteTool, GlobTool, createAgentTool } from '../tools/built-in.js'
import { PermissionGuard, PERMISSION_MODES } from '../permissions/guard.js'
import { ContextCompressor } from '../compact/compressor.js'
import { PromptBuilder, identitySection, toolSection, riskSection, languageSection, outputSection } from '../prompts/sections.js'
import { QueryEngine } from '../core/engine.js'
import { SessionStore } from '../core/session.js'
import fs from 'fs'
import path from 'path'
import readline from 'readline'

// ---------- 颜色工具 ----------
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  
  // 主题色
  primary: '\x1b[36m',    // 青色
  accent: '\x1b[33m',     // 金色
  success: '\x1b[32m',    // 绿色
  error: '\x1b[31m',      // 红色
  info: '\x1b[35m',       // 紫色
  highlight: '\x1b[93m',  // 亮黄
  
  // 背景
  bgPrimary: '\x1b[46m',
  bgDark: '\x1b[40m',
}

function color(c, text) { return `${c}${text}${C.reset}` }

// ---------- Logo ----------
function showLogo(engine) {
  const stats = engine.getStats?.() || {}
  console.error(`\n${color(C.primary, '╔══════════════════════════════════════╗')}`)
  console.error(`${color(C.primary, '║')}  ${color(C.accent, 'OICOS')} ${color(C.primary, 'CODE')} v0.2${' '.repeat(25)}${color(C.primary, '║')}`)
  console.error(`${color(C.primary, '║')}  ${color(C.dim, `模型: ${stats.model || 'N/A'}`)}${' '.repeat(18)}${color(C.primary, '║')}`)
  console.error(`${color(C.primary, '║')}  ${color(C.dim, `会话: ${stats.sessionId || 'N/A'}`)}${' '.repeat(14)}${color(C.primary, '║')}`)
  console.error(`${color(C.primary, '╚══════════════════════════════════════╝')}${C.reset}`)
  console.error(`${color(C.dim, '输入 /help 查看命令列表')}${C.reset}\n`)
}

// ---------- 帮助 ----------
function showHelp() {
  console.error(`\n${color(C.accent, C.bold, 'OICOS CODE 命令')}${C.reset}
  ${color(C.primary, '/quit')}  ${color(C.accent, '/exit')}   — 退出
  ${color(C.primary, '/new')}        — 新建会话
  ${color(C.primary, '/plan')}       — 切换Plan模式（只读探索）
  ${color(C.primary, '/mode')} ${color(C.dim, '<模式>')}   — 切换权限: plan / default / acceptEdits / bypassPermissions
  ${color(C.primary, '/stats')}      — 会话统计
  ${color(C.primary, '/session')}    — 会话详情
  ${color(C.primary, '/sessions')}   — 历史会话
  ${color(C.primary, '/resume')}     — 恢复上次会话
  ${color(C.primary, '/tools')}      — 列出工具
  ${color(C.primary, '/clear')}      — 清屏
  ${color(C.primary, '/help')}       — 本帮助
  ${color(C.dim, '直接输入任何内容即向 OICOS 提问')}${C.reset}\n`)
}

// ---------- 进度显示 ----------
let _spinnerInterval = null
function startSpinner(text = '') {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let i = 0
  if (_spinnerInterval) clearInterval(_spinnerInterval)
  
  const t0 = Date.now()
  _spinnerInterval = setInterval(() => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    const frame = frames[i++ % frames.length]
    process.stderr.write(`\r${color(C.primary, frame)} ${text} ${color(C.dim, `(${elapsed}s)`)}${C.reset}  `)
  }, 80)
}

function stopSpinner() {
  if (_spinnerInterval) {
    clearInterval(_spinnerInterval)
    _spinnerInterval = null
    process.stderr.write('\r' + ' '.repeat(60) + '\r')
  }
}

// ---------- 创建引擎 ----------
function createEngine(cfg, sessionStore = null) {
  const provider = createProvider(cfg)
  const registry = new ToolRegistry()
  registry.registerAll([ReadTool, SearchTool, EditTool, BashTool, GitTool, LintTool, TestTool, TodoWriteTool, GlobTool])
  
  // AgentTool需要provider和registry的引用（依赖注入）
  const agentTool = createAgentTool(
    () => provider,
    () => registry
  )
  registry.register(agentTool)
  
  const permissions = new PermissionGuard({
    mode: cfg.permissions?.mode,
    alwaysAllow: cfg.permissions?.alwaysAllow || [],
    alwaysDeny: cfg.permissions?.alwaysDeny || [],
    alwaysAsk: cfg.permissions?.alwaysAsk || [],
  })
  const compressor = new ContextCompressor({
    threshold: cfg.system?.context_compact_threshold || 80000,
    preserveTurns: 5,
    summarizeFn: async (messages) => {
      // 用LLM生成9段结构化摘要——对标Claude Code compaction
      const compactPrompt = `# 上下文压缩
请将以下对话历史压缩为结构化摘要。保留关键信息，丢弃冗余细节。

## 必须包含以下9个段落:

1. **主要请求和意图**: 用户最初要做什么，目标是什么
2. **关键技术概念**: 涉及的技术栈、框架、概念
3. **文件和代码段**: 操作了哪些文件，做了什么修改（含关键代码片段）
4. **错误和修复**: 遇到了什么错误，如何修复的
5. **问题解决过程**: 解决了什么问题，怎么解决的
6. **所有用户消息**: 用户说了什么（逐条列出）
7. **待完成的任务**: 还有什么没做完
8. **当前工作状态**: 目前正在做什么，进行到哪一步（精确到文件名）
9. **下一步建议**: 接下来应该做什么

## 要压缩的对话历史:
${messages.map(m => `[${m.role || m.type}] ${(m.content || '').slice(0, 500)}`).join('\n').slice(0, 8000)}

## 输出格式
直接输出9段结构，每段用 ## 标题。用中文。保持精确，不要编造。`
      
      try {
        const result = await provider.complete([
          { role: 'system', content: '你是一个精确的技术摘要生成器。只输出结构化摘要，不输出任何其他内容。' },
          { role: 'user', content: compactPrompt }
        ])
        const content = result.choices?.[0]?.message?.content || ''
        return content.slice(0, 3000)
      } catch {
        // LLM调用失败时回退到默认摘要
        return null
      }
    },
  })
  
  const prompts = new PromptBuilder()
  prompts
    .addStatic('identity', identitySection('OICOS CODE'))
    .addStatic('tools', toolSection())
    .addStatic('risk', riskSection())
    .addStatic('language', languageSection('中文'))
    .addStatic('output', outputSection())
  
  const engine = new QueryEngine({
    provider,
    tools: registry,
    permissions,
    compressor,
    prompts,
    system: cfg.system || {},
  })
  
  // 如果提供了已有会话，恢复消息
  if (sessionStore) {
    engine.sessionStore = sessionStore
  }
  
  return engine
}

// ---------- 交互模式 ----------
async function runInteractive(cfg, resumeSessionId = null) {
  // 尝试恢复会话
  let sessionStore = null
  if (resumeSessionId) {
    sessionStore = await SessionStore.load(resumeSessionId)
    if (sessionStore) {
      console.error(`${color(C.info, '📂 恢复会话:')} ${sessionStore.meta.id}`)
      console.error(`${color(C.dim, `   ${sessionStore.meta.turnCount} 轮, ${sessionStore.meta.messageCount} 条消息`)}${C.reset}`)
      // 显示最后话题
      const last = sessionStore.store.getLastTurns(2)
      if (last.length > 0) {
        console.error(`${color(C.dim, `   最后: ${last[0].content?.slice(0, 80)}...`)}${C.reset}`)
      }
    }
  }
  
  const engine = createEngine(cfg, sessionStore)
  showLogo(engine)
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: color(C.primary, 'OICOS> ') + C.reset,
    terminal: true,
    historySize: 100,
  })
  
  // 历史文件
  const histPath = path.resolve(process.env.OICOS_DATA_DIR || path.join(process.env.HOME || '/tmp', '.oicos', 'history'))
  if (!fs.existsSync(path.dirname(histPath))) {
    fs.mkdirSync(path.dirname(histPath), { recursive: true })
  }
  
  // 加载历史
  if (fs.existsSync(histPath)) {
    try {
      const history = fs.readFileSync(histPath, 'utf8').split('\n').filter(Boolean).reverse()
      for (const h of history) rl.history.push(h)
    } catch {}
  }
  
  rl.prompt()
  
  rl.on('line', async (line) => {
    const input = line.trim()
    if (!input) { rl.prompt(); return }
    
    // ---------- 内置命令 ----------
    if (input.startsWith('/')) {
      const cmd = input.toLowerCase()
      
      if (cmd === '/quit' || cmd === '/exit') {
        console.error(color(C.info, '正在保存会话...'))
        await engine.sessionStore.flush()
        const stats = engine.getStats()
        console.error(`\n${color(C.dim, `会话结束: ${stats.turnCount} 轮, ${((Date.now() - engine.startTime) / 1000).toFixed(1)}s`)}${C.reset}`)
        rl.close()
        return
      }
      
      if (cmd === '/new') {
        await engine.sessionStore.flush()
        const oldId = engine.sessionId
        engine.sessionStore = new SessionStore()
        engine.turnCount = 0
        console.error(`\n${color(C.info, '📂 新建会话')} (旧会话 ${oldId} 已保存)`)
        showLogo(engine)
        rl.prompt()
        return
      }
      
      if (cmd === '/stats') {
        const stats = engine.getStats()
        console.error(`\n${color(C.accent, '会话统计')}`)
        console.error(`  ID:     ${color(C.dim, stats.sessionId)}`)
        console.error(`  轮次:   ${stats.turnCount}`)
        console.error(`  消息:   ${stats.messageCount}`)
        console.error(`  耗时:   ${stats.duration > 60000 ? `${(stats.duration / 60000).toFixed(1)} min` : `${(stats.duration / 1000).toFixed(1)} s`}`)
        console.error(`  模型:   ${stats.model}`)
        rl.prompt()
        return
      }
      
      if (cmd === '/session') {
        const resume = engine.sessionStore.getResumeSummary()
        console.error(`\n${color(C.accent, '当前会话')}`)
        console.error(`  ID:      ${color(C.dim, resume.id)}`)
        console.error(`  创建:    ${resume.created}`)
        console.error(`  轮次:    ${resume.turns}`)
        console.error(`  消息:    ${resume.messages}`)
        console.error(`  模型:    ${resume.model}`)
        console.error(`  话题:    ${color(C.dim, resume.lastTopic)}`)
        console.error(`  路径:    ${color(C.dim, engine.sessionStore.sessionPath)}`)
        rl.prompt()
        return
      }
      
      if (cmd === '/sessions') {
        const sessions = await SessionStore.list()
        if (sessions.length === 0) {
          console.error(`\n${color(C.info, '没有历史会话')}`)
        } else {
          console.error(`\n${color(C.accent, `历史会话 (${sessions.length})`)}`)
          for (const s of sessions.slice(0, 10)) {
            const date = new Date(s.updated).toLocaleString('zh-CN')
            console.error(`  ${color(C.dim, s.id)}  ${date}  ${s.turnCount}turns  ${s.messageCount}msgs  ${s.model}`)
          }
          if (sessions.length > 10) {
            console.error(`  ${color(C.dim, `...还有 ${sessions.length - 10} 个`)}`)
          }
        }
        rl.prompt()
        return
      }
      
      if (cmd === '/resume') {
        const activeId = await SessionStore.getActiveSessionId()
        if (!activeId) {
          console.error(`\n${color(C.error, '没有可恢复的会话')}`)
          rl.prompt()
          return
        }
        
        const loaded = await SessionStore.load(activeId)
        if (!loaded) {
          console.error(`\n${color(C.error, `会话 ${activeId} 找不到或已损坏`)}`)
          rl.prompt()
          return
        }
        
        await engine.sessionStore.flush()
        engine.sessionStore = loaded
        engine.turnCount = loaded.meta.turnCount || 0
        console.error(`\n${color(C.info, `📂 已恢复会话: ${activeId} (${loaded.meta.turnCount} 轮)`)}`)
        rl.prompt()
        return
      }
      
      if (cmd === '/tools') {
        // Tools are on the engine
        const tools = engine.tools?.getAll() || []
        console.error(`\n${color(C.accent, `已注册工具 (${tools.length})`)}`)
        for (const t of tools) {
          const flags = []
          if (t.isReadOnly?.()) flags.push('只读')
          if (t.isDestructive?.()) flags.push('⚠破坏')
          if (t.isConcurrencySafe?.()) flags.push('并行')
          console.error(`  ${color(C.primary, t.name)} ${color(C.dim, flags.length ? `[${flags.join(', ')}]` : '')}`)
          if (t.description) {
            console.error(`    ${t.description.slice(0, 80)}`)
          }
        }
        rl.prompt()
        return
      }
      
      if (cmd === '/clear') {
        console.error('\x1b[2J\x1b[H')
        showLogo(engine)
        rl.prompt()
        return
      }
      
      if (cmd === '/plan') {
        const current = engine.permissions.mode
        if (current === PERMISSION_MODES.PLAN) {
          engine.permissions.setMode(PERMISSION_MODES.DEFAULT)
          console.error(`\n${color(C.info, '📖 退出Plan模式 → default')} 现在可以执行写操作`)
        } else {
          engine.permissions.setMode(PERMISSION_MODES.PLAN)
          console.error(`\n${color(C.accent, '📐 进入Plan模式')} 只读探索，所有写操作被拦截`)
        }
        rl.prompt()
        return
      }
      
      if (cmd.startsWith('/mode ')) {
        const modeArg = input.slice(6).trim()
        const validModes = Object.values(PERMISSION_MODES)
        if (validModes.includes(modeArg)) {
          engine.permissions.setMode(modeArg)
          const labels = { plan: '📐只读', default: '🔒询问', acceptEdits: '✏️编辑自动', bypassPermissions: '⚠️全自动', bubble: '🫧子代理' }
          console.error(`\n${color(C.info, `权限模式 → ${modeArg}`)} ${labels[modeArg] || ''}`)
        } else {
          console.error(`\n${color(C.error, `无效模式: ${modeArg}`)} 可选: ${validModes.join(' / ')}`)
        }
        rl.prompt()
        return
      }
      
      if (cmd === '/help') {
        showHelp()
        rl.prompt()
        return
      }
      
      console.error(`${color(C.error, `未知命令: ${input} (输入 /help 查看帮助)`)}`)
      rl.prompt()
      return
    }
    
    // ---------- 保存历史 ----------
    try {
      fs.appendFileSync(histPath, input + '\n')
    } catch {}
    
    // ---------- 执行查询 ----------
    let hasResult = false
    
    try {
      startSpinner(color(C.primary, '思考中...'))
      
      for await (const block of engine.submitMessage(input)) {
        switch (block.type) {
          case 'block':
            stopSpinner()
            if (block.text) process.stdout.write(block.text)
            if (block.id) {
              // 工具调用
              process.stdout.write(`\n${color(C.dim, `⚡ ${block.name}...`)}`)
            }
            break
            
          case 'tool_start':
            stopSpinner()
            startSpinner(color(C.accent, block.tool))
            break
            
          case 'tool_result':
            stopSpinner()
            if (block.persisted) {
              console.error(`${color(C.dim, `  📦 ${block.tool} 完成 (结果持久化)`)}`)
            } else {
              console.error(`${color(C.dim, `  ✓ ${block.tool} 完成`)}`)
            }
            break
            
          case 'tool_error':
            stopSpinner()
            console.error(`\n${color(C.error, `  ✗ ${block.tool}: ${block.error}`)}`)
            break
            
          case 'tool_denied':
            stopSpinner()
            console.error(`\n${color(C.error, `  🚫 ${block.tool}: ${block.reason}`)}`)
            break
            
          case 'compact':
            stopSpinner()
            const saved = `${(block.tokensSaved / 1000).toFixed(1)}K`
            console.error(`\n${color(C.info, `  📦 上下文压缩: -${saved} tokens`)}`)
            startSpinner(color(C.primary, '继续...'))
            break
            
          case 'retry':
            stopSpinner()
            console.error(`\n${color(C.accent, `  ⏳ 重试 (${block.attempt}/${block.delay}ms)...`)}`)
            startSpinner(color(C.primary, '重试中...'))
            break
            
          case 'error':
            stopSpinner()
            if (block.fatal) {
              console.error(`\n${color(C.error, `  ❌ ${block.content}`)}`)
            } else {
              console.error(`\n${color(C.error, `  ⚠ ${block.content}`)}`)
            }
            break
            
          case 'result':
            stopSpinner()
            hasResult = true
            if (block.content) {
              process.stdout.write(block.content)
            }
            console.log()
            break
            
          case 'permission_required':
            stopSpinner()
            // 自动放行，不打扰用户
            engine.permissions?.grant(block.tool)
            startSpinner(color(C.accent, block.tool))
            break
        }
      }
    } catch (err) {
      stopSpinner()
      console.error(`\n${color(C.error, `❌ 错误: ${err.message}`)}`)
      if (process.env.OICOS_DEBUG) {
        console.error(err.stack)
      }
    }
    
    // 确保有输出
    if (!hasResult) {
      stopSpinner()
    }
    
    rl.prompt()
  })
  
  rl.on('close', async () => {
    await engine.sessionStore.flush()
    console.error(`\n${color(C.dim, 'OICOS CODE 已退出')}${C.reset}`)
    process.exit(0)
  })
}

// ---------- 单次模式 ----------
async function runOnce(cfg, prompt) {
  const engine = createEngine(cfg)
  
  try {
    for await (const block of engine.submitMessage(prompt)) {
      switch (block.type) {
        case 'block':
          if (block.text) process.stdout.write(block.text)
          break
        case 'result':
          if (block.content) process.stdout.write(block.content)
          console.log()
          break
        case 'tool_start':
          console.error(color(C.dim, `  → ${block.tool}`))
          break
        case 'tool_result':
          console.error(color(C.dim, `  ✓ ${block.tool}`))
          break
        case 'tool_error':
          console.error(color(C.dim, `  ✗ ${block.tool}: ${block.error}`))
          break
        case 'compact':
          console.error(color(C.dim, `  📦 压缩: -${(block.tokensSaved / 1000).toFixed(1)}K tokens`))
          break
        case 'retry':
          console.error(color(C.dim, `  ⏳ 重试...`))
          break
        case 'error':
          console.error(color(C.dim, `  ⚠ ${block.content}`))
          break
      }
    }
  } catch (err) {
    console.error(`\n${color(C.error, `错误: ${err.message}`)}`)
    process.exit(1)
  }
  
  await engine.sessionStore.flush()
}

// ---------- 主入口 ----------
async function main() {
  const cfg = loadConfig()
  const args = process.argv.slice(2)
  
  // 解析参数
  let resumeSessionId = null
  let promptArgs = []
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resume' || args[i] === '-r') {
      resumeSessionId = args[++i] || true
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.error(`用法: node src/cli/index.js [选项] [提示词]`)
      console.error(`  --resume, -r [ID]  恢复会话`)
      console.error(`  --help, -h         本帮助`)
      console.error(`  无参数             交互模式`)
      process.exit(0)
    } else {
      promptArgs.push(args[i])
    }
  }
  
  // 如果 resume=true 但没有指定 ID，从 active 链接读取
  if (resumeSessionId === true) {
    resumeSessionId = await SessionStore.getActiveSessionId()
    if (!resumeSessionId) {
      console.error(color(C.error, '没有可恢复的会话'))
      process.exit(1)
    }
  }
  
  if (promptArgs.length > 0) {
    await runOnce(cfg, promptArgs.join(' '))
  } else if (!process.stdin.isTTY) {
    // 管道模式
    const chunks = []
    for await (const chunk of process.stdin) {
      chunks.push(chunk)
    }
    const prompt = Buffer.concat(chunks).toString('utf8').trim()
    if (prompt) {
      await runOnce(cfg, prompt)
    } else {
      await runInteractive(cfg, resumeSessionId)
    }
  } else {
    await runInteractive(cfg, resumeSessionId)
  }
}

main().catch(err => {
  console.error(`\n${color(C.error, `FATAL: ${err.message}`)}`)
  if (process.env.OICOS_DEBUG) console.error(err.stack)
  process.exit(1)
})
