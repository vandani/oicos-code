// ============================================================
// OICOS 内置工具 — Read, Search, Edit, Bash
// ============================================================

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { execSync, exec } from 'child_process'
import { defineTool } from './registry.js'

// ---------- Read — 读文件 ----------

export const ReadTool = defineTool('Read', {
  description: '读取文件内容。支持文本文件和有限大小的二进制文件。',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '文件路径（绝对或相对）' },
      offset: { type: 'number', description: '起始行（从1开始）', default: 1 },
      limit: { type: 'number', description: '最多读取行数', default: 200 },
    },
    required: ['file_path'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSize: 100000,

  async call(args) {
    if (!args.file_path || typeof args.file_path !== 'string') {
      return { data: { error: '缺少参数 file_path' }, isError: true }
    }
    const absPath = path.resolve(args.file_path)
    
    // 安全检查：不能读取隐藏系统文件
    if (absPath.startsWith('/etc/shadow') || absPath.startsWith('/etc/sudoers')) {
      return { data: { error: '无权读取此文件' }, isError: true }
    }
    
    try {
      const stat = await fsp.stat(absPath)
      if (!stat.isFile()) {
        return { data: { error: '不是文件' }, isError: true }
      }
      
      const content = await fsp.readFile(absPath, 'utf8')
      const lines = content.split('\n')
      const offset = (args.offset || 1) - 1
      const limit = args.limit || 200
      const selected = lines.slice(offset, offset + limit)
      
      return {
        data: {
          file_path: absPath,
          total_lines: lines.length,
          lines: selected,
          showing: `第 ${offset + 1}-${Math.min(offset + limit, lines.length)} 行 / 共 ${lines.length} 行`,
        },
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { data: { error: `文件不存在: ${absPath}` }, isError: true }
      }
      if (err.code === 'EACCES') {
        return { data: { error: `无权限读取: ${absPath}` }, isError: true }
      }
      return { data: { error: err.message }, isError: true }
    }
  },
})

// ---------- Search — 搜索文件内容 ----------

export const SearchTool = defineTool('Search', {
  description: '在文件中搜索文本。支持正则表达式，自动跳过 .git node_modules 等目录。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（正则或普通文本）' },
      path: { type: 'string', description: '搜索路径', default: '.' },
      file_glob: { type: 'string', description: '文件过滤（如 *.js, *.py）' },
      max_results: { type: 'number', description: '最大结果数', default: 30 },
    },
    required: ['pattern'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async call(args) {
    const searchPath = path.resolve(args.path || '.')
    const maxResults = args.max_results || 30
    const pattern = args.pattern
    
    try {
      // 使用 ripgrep（如果可用）或 fallback 到 grep
      let command
      const ignoreDirs = '--no-ignore-vcs --ignore-case'
      
      if (args.file_glob) {
        command = `grep -rn --include="${args.file_glob}" -e "${pattern.replace(/"/g, '\\"')}" "${searchPath}" 2>/dev/null | head -${maxResults}`
      } else {
        command = `grep -rn --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.hermes -e "${pattern.replace(/"/g, '\\"')}" "${searchPath}" 2>/dev/null | head -${maxResults}`
      }
      
      const output = execSync(command, { encoding: 'utf8', timeout: 10000 })
      const lines = output.split('\n').filter(Boolean)
      
      const results = lines.map(line => {
        const parts = line.split(':', 2)
        return {
          file: parts[0],
          line: parseInt(parts[1]) || 0,
          content: parts.slice(2).join(':') || '',
        }
      })
      
      return {
        data: {
          pattern,
          total: results.length,
          truncated: results.length >= maxResults,
          results,
        },
      }
    } catch (err) {
      if (err.status === 1 && !err.stdout) {
        return { data: { pattern, total: 0, results: [], message: '未找到匹配' } }
      }
      const stdout = err.stdout?.toString() || ''
      const lines = stdout.split('\n').filter(Boolean)
      return {
        data: {
          pattern,
          total: lines.length,
          results: lines.map(l => {
            const parts = l.split(':', 2)
            return { file: parts[0], line: parseInt(parts[1]) || 0, content: parts.slice(2).join(':') || '' }
          }),
        },
      }
    }
  },
})

// ---------- Edit — 编辑文件 ----------

// Edit/Write 合一 —— 金刚经：凡所有相皆是虚妄，Write即Edit之空相
// 文件存在 → 查找替换；文件不存在 → 创建新文件（old_string用空字符串标记）
export const EditTool = defineTool('Edit', {
  description: '编辑或创建文件。文件存在时查找替换修改；文件不存在时直接创建新文件（old_string留空，new_string为完整内容）。',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '被替换的原文。创建新文件时留空字符串""' },
      new_string: { type: 'string', description: '替换后的新内容。创建新文件时为完整文件内容' },
      replace_all: { type: 'boolean', description: '替换所有匹配项（默认false，仅替换首次匹配）', default: false },
    },
    required: ['file_path', 'new_string'],
  },
  isReadOnly: () => false,
  isDestructive: () => true,
  isConcurrencySafe: () => false,

  async call(args) {
    const absPath = path.resolve(args.file_path)
    
    // 金刚经：文件不存在时，old_string为空 → 创建新文件
    if (!fs.existsSync(absPath)) {
      // 确保父目录存在
      const dir = path.dirname(absPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      await fsp.writeFile(absPath, args.new_string, 'utf8')
      return {
        data: { file_path: absPath, created: true, size: args.new_string.length },
      }
    }
    
    // 文件存在 → 查找替换
    try {
      const content = await fsp.readFile(absPath, 'utf8')
      const oldStr = args.old_string || ''
      
      if (!oldStr) {
        return { data: { error: '文件已存在，old_string不能为空。请提供要替换的原文。' }, isError: true }
      }
      
      const idx = content.indexOf(oldStr)
      if (idx === -1) {
        return { data: { error: `未找到匹配的原文: "${oldStr.slice(0, 50)}..."` }, isError: true }
      }
      
      // replace_all: 替换所有匹配；默认: 必须唯一
      if (!args.replace_all) {
        const lastIdx = content.lastIndexOf(oldStr)
        if (idx !== lastIdx) {
          return { data: { error: '原文匹配到多处，请提供更多上下文以确保唯一匹配，或设置 replace_all:true' }, isError: true }
        }
      }
      
      const occurrenceCount = content.split(oldStr).length - 1
      const newContent = args.replace_all ? content.split(oldStr).join(args.new_string) : content.replace(oldStr, args.new_string)
      
      const bakPath = absPath + '.bak'
      await fsp.writeFile(bakPath, content)
      await fsp.writeFile(absPath, newContent, 'utf8')
      
      return {
        data: {
          file_path: absPath,
          replaced: oldStr.slice(0, 100),
          occurrences: args.replace_all ? occurrenceCount : 1,
          backup: bakPath,
        },
      }
    } catch (err) {
      return { data: { error: err.message }, isError: true }
    }
  },
})

// ---------- Bash — 执行命令 ----------

export const BashTool = defineTool('Bash', {
  description: '在 Shell 中执行命令。支持标准输入输出，超时控制。',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      timeout: { type: 'number', description: '超时时间（毫秒）', default: 30000 },
      workdir: { type: 'string', description: '工作目录' },
      description: { type: 'string', description: '命令说明（给人类看的）' },
    },
    required: ['command'],
  },
  isReadOnly: () => false,
  isDestructive: () => true,
  isConcurrencySafe: () => false,

  async call(args) {
    const options = {
      encoding: 'utf8',
      timeout: args.timeout || 30000,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    }
    
    if (args.workdir) {
      options.cwd = path.resolve(args.workdir)
    }
    
    try {
      const stdout = execSync(args.command, options)
      return {
        data: {
          exit_code: 0,
          stdout: stdout?.toString() || '',
          stderr: '',
        },
      }
    } catch (err) {
      return {
        data: {
          exit_code: err.status || 1,
          stdout: err.stdout?.toString() || '',
          stderr: err.stderr?.toString() || '',
          error: err.message,
        },
        isError: err.status !== 0 && err.status !== undefined,
      }
    }
  },
})

// ---------- Git — 版本控制 ----------
// 瑜伽师地论：一切法不离识。Git操作本质是文件状态快照的查询与变更。

const GIT_READONLY = ['log', 'diff', 'status', 'show', 'branch', 'remote']
const GIT_DESTRUCTIVE = ['add', 'commit', 'checkout', 'reset', 'stash', 'pull', 'push', 'merge']

export const GitTool = defineTool('Git', {
  description: 'Git版本控制。支持 log/diff/status/show/branch(只读) 和 add/commit/checkout/stash(破坏性)。',
  inputSchema: {
    type: 'object',
    properties: {
      subcommand: { type: 'string', description: `Git子命令: ${[...GIT_READONLY, ...GIT_DESTRUCTIVE].join('/')}` },
      args: { type: 'string', description: '子命令参数，如 --oneline -n 5 或 文件名', default: '' },
      message: { type: 'string', description: 'commit消息（仅commit时使用）', default: '' },
      workdir: { type: 'string', description: '工作目录（git仓库路径）', default: '.' },
    },
    required: ['subcommand'],
  },
  isReadOnly: (args) => GIT_READONLY.includes(args?.subcommand),
  isDestructive: (args) => GIT_DESTRUCTIVE.includes(args?.subcommand),
  isConcurrencySafe: () => false,

  async call(args) {
    const sub = args.subcommand
    const cwd = path.resolve(args.workdir || '.')
    
    let cmd = `git ${sub}`
    if (sub === 'commit' && args.message) {
      cmd += ` -m "${args.message.replace(/"/g, '\\"')}"`
    }
    if (args.args) cmd += ` ${args.args}`
    
    // 只读命令加 --no-pager
    if (GIT_READONLY.includes(sub) && !args.args?.includes('--no-pager')) {
      cmd = `git --no-pager ${sub}`
      if (args.message && sub === 'commit') cmd += ` -m "${args.message.replace(/"/g, '\\"')}"`
      if (args.args) cmd += ` ${args.args}`
    }
    
    try {
      const stdout = execSync(cmd, { encoding: 'utf8', timeout: 15000, cwd, maxBuffer: 5 * 1024 * 1024 })
      return {
        data: { command: cmd, stdout: stdout || '(空)', stderr: '', exit_code: 0 },
      }
    } catch (err) {
      return {
        data: {
          command: cmd,
          stdout: err.stdout?.toString() || '',
          stderr: err.stderr?.toString() || '',
          exit_code: err.status || 1,
          error: err.message,
        },
        isError: true,
      }
    }
  },
})

// ---------- Lint — 代码诊断 ----------
// 心经：照见五蕴皆空。代码错误是蕴，Lint是照。

export const LintTool = defineTool('Lint', {
  description: '代码静态诊断。运行eslint/tsc检查代码错误，返回结构化诊断结果。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要检查的文件或目录路径', default: '.' },
      linter: { type: 'string', description: '检查器: eslint / tsc / auto', default: 'auto' },
    },
    required: [],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSize: 50000,

  async call(args) {
    const checkPath = path.resolve(args.path || '.')
    const results = []
    
    // 自动检测
    let linter = args.linter || 'auto'
    if (linter === 'auto') {
      const hasTS = fs.existsSync(path.join(checkPath, 'tsconfig.json'))
      const hasESLint = fs.existsSync(path.join(checkPath, '.eslintrc.js')) || 
                        fs.existsSync(path.join(checkPath, '.eslintrc.json')) ||
                        fs.existsSync(path.join(checkPath, 'eslint.config.js'))
      if (hasTS) linter = 'tsc'
      else if (hasESLint) linter = 'eslint'
      else {
        return { data: { message: '未检测到 tsconfig.json 或 eslint 配置文件，跳过诊断', results: [] } }
      }
    }
    
    try {
      if (linter === 'eslint') {
        const cmd = `npx eslint --format json "${checkPath}" 2>/dev/null`
        const stdout = execSync(cmd, { encoding: 'utf8', timeout: 30000, maxBuffer: 5 * 1024 * 1024 })
        const eslintResults = JSON.parse(stdout || '[]')
        let errorCount = 0, warningCount = 0
        for (const file of eslintResults) {
          for (const msg of file.messages || []) {
            if (msg.severity === 2) errorCount++
            else warningCount++
            results.push({
              file: file.filePath,
              line: msg.line,
              column: msg.column,
              severity: msg.severity === 2 ? 'error' : 'warning',
              message: msg.message,
              rule: msg.ruleId || '',
            })
          }
        }
        return { data: { linter: 'eslint', errorCount, warningCount, total: results.length, results } }
      }
      
      if (linter === 'tsc') {
        const cmd = `npx tsc --noEmit --pretty false 2>&1`
        const stdout = execSync(cmd, { encoding: 'utf8', timeout: 60000, cwd: checkPath, maxBuffer: 5 * 1024 * 1024 })
        const lines = stdout.split('\n').filter(l => l.includes('error TS'))
        for (const line of lines) {
          const match = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error)\s+(TS\d+):\s*(.+)/)
          if (match) {
            results.push({
              file: match[1],
              line: parseInt(match[2]),
              column: parseInt(match[3]),
              severity: match[4],
              code: match[5],
              message: match[6],
            })
          }
        }
        return { data: { linter: 'tsc', total: results.length, results } }
      }
      
      return { data: { message: `未知检查器: ${linter}`, results: [] } }
    } catch (err) {
      const stdout = err.stdout?.toString() || ''
      if (linter === 'tsc' && stdout) {
        const lines = stdout.split('\n').filter(l => l.includes('error TS'))
        for (const line of lines) {
          const match = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error)\s+(TS\d+):\s*(.+)/)
          if (match) {
            results.push({
              file: match[1], line: parseInt(match[2]), column: parseInt(match[3]),
              severity: match[4], code: match[5], message: match[6],
            })
          }
        }
        return { data: { linter: 'tsc', total: results.length, results } }
      }
      return { data: { error: err.message, results } }
    }
  },
})

// ---------- Test — 测试运行 ----------
// 易经：一阴一阳之谓道。写为阳，测为阴，阴阳相推而生变化。

export const TestTool = defineTool('Test', {
  description: '运行项目测试并返回结果。自动检测测试框架(npm test/pytest/go test/cargo test)。跑测试不改代码，纯只读。',
  inputSchema: {
    type: 'object',
    properties: {
      workdir: { type: 'string', description: '项目路径', default: '.' },
      framework: { type: 'string', description: '测试框架: npm / pytest / go / cargo / auto', default: 'auto' },
      filter: { type: 'string', description: '只跑匹配的测试（如文件名或测试名）', default: '' },
    },
    required: [],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  maxResultSize: 80000,

  async call(args) {
    const cwd = path.resolve(args.workdir || '.')
    let framework = args.framework || 'auto'
    
    if (framework === 'auto') {
      if (fs.existsSync(path.join(cwd, 'package.json'))) framework = 'npm'
      else if (fs.existsSync(path.join(cwd, 'go.mod'))) framework = 'go'
      else if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) framework = 'cargo'
      else if (fs.existsSync(path.join(cwd, 'requirements.txt')) || fs.existsSync(path.join(cwd, 'pyproject.toml'))) framework = 'pytest'
      else return { data: { error: '未检测到已知测试框架，请手动指定 framework' }, isError: true }
    }
    
    const cmds = { npm: 'npm test', pytest: 'python -m pytest -q', go: 'go test ./...', cargo: 'cargo test -q' }
    let cmd = cmds[framework]
    if (!cmd) return { data: { error: `未知框架: ${framework}` }, isError: true }
    if (args.filter) cmd += ` -k "${args.filter.replace(/"/g, '\\"')}"`  // pytest/npm filter
    
    const start = Date.now()
    try {
      const stdout = execSync(cmd, { encoding: 'utf8', timeout: 120000, cwd, maxBuffer: 10 * 1024 * 1024 })
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      return {
        data: { framework, command: cmd, passed: true, duration: `${elapsed}s`, output: stdout.slice(-3000) },
      }
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      const stderr = err.stderr?.toString() || ''
      const stdout = err.stdout?.toString() || ''
      const output = (stderr + '\n' + stdout).slice(-3000)
      return {
        data: { framework, command: cmd, passed: false, duration: `${elapsed}s`, output, exit_code: err.status || 1 },
        isError: false,  // 测试失败不是工具错误，是正常结果
      }
    }
  },
})

// ---------- TodoWrite — 任务追踪 ----------
// 金刚经：应无所住而生其心。任务不执著于初始计划，随进展而更新。

export const TodoWriteTool = defineTool('TodoWrite', {
  description: '创建和更新任务清单。用于多步操作时追踪进度。格式: [{id, content, status: pending|in_progress|completed|cancelled}]',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: '任务列表。每项含 id(唯一标识), content(描述), status(状态)',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '任务ID' },
            content: { type: 'string', description: '任务描述' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'], description: '状态' },
          },
          required: ['id', 'content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  async call(args) {
    const todos = args.todos || []
    const counts = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 }
    for (const t of todos) {
      if (counts[t.status] !== undefined) counts[t.status]++
    }
    return {
      data: {
        todos,
        summary: `${todos.length}个任务: ${counts.completed}完成 ${counts.in_progress}进行中 ${counts.pending}待办 ${counts.cancelled}取消`,
      },
    }
  },
})

// ---------- Glob — 文件查找 ----------
// 易：探赜索隐。find之形，grep之补。

export const GlobTool = defineTool('Glob', {
  description: '按文件名模式查找文件。使用find命令，比Search更快更精确。如: "*.js", "test*.ts", "**/*.vue"',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '文件名模式（glob语法）' },
      path: { type: 'string', description: '搜索目录', default: '.' },
      max_results: { type: 'number', description: '最大结果数', default: 50 },
    },
    required: ['pattern'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSize: 30000,

  async call(args) {
    const searchPath = path.resolve(args.path || '.')
    const maxResults = args.max_results || 50
    
    try {
      const cmd = `find "${searchPath}" -type f -name "${args.pattern.replace(/"/g, '\\"')}" -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null | head -${maxResults}`
      const stdout = execSync(cmd, { encoding: 'utf8', timeout: 10000 })
      const files = stdout.split('\n').filter(Boolean)
      return {
        data: { pattern: args.pattern, total: files.length, truncated: files.length >= maxResults, files },
      }
    } catch (err) {
      return { data: { pattern: args.pattern, total: 0, files: [], error: err.message } }
    }
  },
})

// ---------- Agent — 子代理分派 ----------
// 金刚经：一即一切，一切即一。子代理即主代理之分身，各司其职。

export function createAgentTool(getProvider, getFullRegistry) {
  return defineTool('Agent', {
    description: '创建子代理并行执行任务。explore型(只读探索: Read+Search+Glob)用于快速了解代码库；general型(全工具)用于独立子任务。可并行调用多个Agent。',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '子任务简述' },
        prompt: { type: 'string', description: '给子代理的详细指令' },
        type: { type: 'string', enum: ['explore', 'general'], description: 'explore=只读 / general=全工具', default: 'explore' },
      },
      required: ['description', 'prompt'],
    },
    isReadOnly: (args) => args?.type === 'explore',
    isConcurrencySafe: () => true,

    async call(args) {
      const provider = getProvider()
      const allTools = getFullRegistry().getAll()
      
      const allowedTools = args.type === 'explore'
        ? allTools.filter(t => ['Read', 'Search', 'Glob'].includes(t.name))
        : allTools.filter(t => t.name !== 'Agent')
      
      const messages = [
        { role: 'system', content: `你是OICOS CODE子代理(${args.type})。用工具完成任务，输出简洁精确。` },
        { role: 'user', content: args.prompt },
      ]
      
      const maxTurns = args.type === 'explore' ? 3 : 5
      let finalOutput = '(无输出)'
      
      for (let turn = 0; turn < maxTurns; turn++) {
        const tools = allowedTools.map(t => ({
          type: 'function',
          function: { name: t.name, description: t.description || '', parameters: t.inputSchema || {} },
        }))
        
        let response
        try { response = await provider.complete(messages, tools) }
        catch (err) { return { data: { error: `子代理${err.message}` }, isError: true } }
        
        const msg = response.choices?.[0]?.message
        if (!msg) return { data: { error: '子代理无响应' }, isError: true }
        
        messages.push(msg)
        
        if (!msg.tool_calls?.length) {
          finalOutput = msg.content || ''
          break
        }
        
        for (const tc of msg.tool_calls) {
          const tool = allowedTools.find(t => t.name === tc.function?.name)
          if (!tool) { messages.push({ role: 'tool', tool_call_id: tc.id, content: `未知工具` }); continue }
          
          let input = {}
          try { input = JSON.parse(tc.function?.arguments || '{}') } catch {}
          
          try {
            const result = await tool.call(input)
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result.data || result).slice(0, 4000) })
          } catch (err) {
            messages.push({ role: 'tool', tool_call_id: tc.id, content: `错误: ${err.message}` })
          }
        }
        
        finalOutput = messages.filter(m => m.role === 'assistant').map(m => m.content).filter(Boolean).slice(-1).join('\n') || finalOutput
      }
      
      return {
        data: { type: args.type, description: args.description, output: finalOutput.slice(0, 5000), turns: messages.filter(m => m.role === 'tool').length },
      }
    },
  })
}
