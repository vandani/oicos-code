// ============================================================
// OICOS CODE — 完整测试 (v2)
// ============================================================

import fs from 'fs'
import path from 'path'
import { loadConfig, createProvider } from '../llm/provider.js'
import { ToolRegistry, defineTool } from '../tools/registry.js'
import { PermissionGuard } from '../permissions/guard.js'
import { ContextCompressor, estimateTokens } from '../compact/compressor.js'
import { PromptBuilder } from '../prompts/sections.js'
import { MessageStore, createUserMessage, createAssistantMessage, createToolResultMessage, MessageType } from '../core/message.js'
import { SessionStore } from '../core/session.js'
import { ReadTool, SearchTool, EditTool, BashTool, GitTool, LintTool, TestTool, TodoWriteTool, GlobTool } from '../tools/built-in.js'
import { log } from '../utils/log.js'
import { MCPClient } from '../mcp/client.js'

let passed = 0
let failed = 0

function assert(condition, name) {
  if (condition) {
    console.log(`  \x1b[32m✓ ${name}\x1b[0m`)
    passed++
  } else {
    console.log(`  \x1b[31m✗ ${name}\x1b[0m`)
    failed++
  }
}

// ---------- 1. MessageStore ----------
console.log('\n\x1b[36mMessageStore\x1b[0m')
{
  const store = new MessageStore()
  assert(store.length === 0, '初始为空')
  
  store.push(createUserMessage('你好'))
  assert(store.length === 1, '添加用户消息后长度为1')
  assert(store.get(0).content === '你好', '消息内容正确')
  
  store.push(createAssistantMessage('你好！有什么可以帮助你的？'))
  assert(store.length === 2, '添加助手消息后长度为2')
  
  const llmMsgs = store.toLLMMessages()
  assert(llmMsgs.length === 2, 'LLM 格式消息数为2')
  assert(llmMsgs[0].role === 'user', 'LLM 格式 role 正确')
  assert(llmMsgs[1].role === 'assistant', 'LLM 格式 assistant role 正确')
  
  // 工具调用消息
  store.push(createAssistantMessage('', [
    { id: 'call_1', name: 'Read', input: { file_path: 'test.txt' } },
  ]))
  assert(store.length === 3, '含工具调用的助手消息')
  
  store.push(createToolResultMessage('call_1', '文件内容'))
  assert(store.length === 4, '工具结果消息')
  
  const llmWithTools = store.toLLMMessages()
  assert(llmWithTools.length === 4, 'LLM 格式含工具消息')
  assert(llmWithTools[3].role === 'tool', 'tool role 正确')
  
  // 序列化/反序列化
  const serialized = store.serialize()
  const restored = MessageStore.deserialize(serialized)
  assert(restored.length === store.length, '序列化/反序列化后长度一致')
  
  // 最后 N 轮
  const lastTurns = store.getLastTurns(2)
  assert(lastTurns.length === 2, 'getLastTurns 返回正确数量')
  
  // 压缩边界
  store.markCompactBoundary('测试摘要')
  assert(store.getCompactBoundaries().length === 1, '压缩边界记录')
  assert(store.getCompactBoundaries()[0].summary === '测试摘要', '压缩边界摘要正确')
  
  // 压缩边界后的消息
  const afterCompact = store.getMessagesAfterLastCompact()
  assert(afterCompact.length === 0, '压缩边界后无新消息（边界在最后）')
}

// ---------- 2. ToolRegistry ----------
console.log('\n\x1b[36mToolRegistry\x1b[0m')
{
  const registry = new ToolRegistry()
  registry.registerAll([ReadTool, SearchTool, EditTool, BashTool, GitTool, LintTool, TestTool, TodoWriteTool, GlobTool])
  
  assert(registry.getAll().length === 9, '9个工具注册')
  assert(registry.find('Read') !== undefined, '按名称查找到 Read')
  assert(registry.find('不存在的工具') === undefined, '查找不存在返回 undefined')
  
  const llmTools = registry.toLLMTools()
  assert(llmTools.length === 9, 'LLM 工具格式9个')
  assert(llmTools[0].type === 'function', '工具类型为 function')
  
  const readOnly = registry.getReadOnlyTools()
  assert(readOnly.length === 5, '5个只读工具（Read, Search, Lint, Test, Glob）')
  assert(readOnly[0].name === 'Read', 'Read 是只读工具')
  
  const destructive = registry.getDestructiveTools()
  assert(destructive.length === 2, '2个破坏性工具（Edit, Bash）')
}

// ---------- 3. PermissionGuard ----------
console.log('\n\x1b[36mPermissionGuard\x1b[0m')
{
  const guard = new PermissionGuard({
    alwaysDeny: ['Bash:rm -rf'],
    alwaysAllow: ['Read'],
  })
  
  // 只读工具自动放行
  const readPerm = await guard.check(ReadTool, { file_path: 'test.txt' }, {})
  assert(readPerm.decision === 'allow', '只读工具自动放行')
  
  // 规则 allow
  const readPerm2 = await guard.check(ReadTool, { file_path: '/etc/passwd' }, {})
  assert(readPerm2.decision === 'allow', 'alwaysAllow 规则生效')
  
  // 破坏性工具需要询问
  const editPerm = await guard.check(EditTool, { file_path: 'x', old_string: 'a', new_string: 'b' }, {})
  assert(editPerm.decision === 'ask', '破坏性工具需询问')
  
  // 会话授权
  guard.grant('Edit')
  const editPerm2 = await guard.check(EditTool, { file_path: 'x', old_string: 'a', new_string: 'b' }, {})
  assert(editPerm2.decision === 'allow', '会话授权后放行')
  
  // 规则匹配
  const bashPerm = await guard.check(BashTool, { command: 'rm -rf /' }, {})
  assert(bashPerm.decision === 'deny', '规则禁止 rm -rf')
  
  const bashPerm2 = await guard.check(BashTool, { command: 'ls -la' }, {})
  assert(bashPerm2.decision !== 'deny', '正常命令不受影响')
  
  assert(guard.getDenialLog().length >= 1, '拒绝日志记录')
}

// ---------- 4. ContextCompressor ----------
console.log('\n\x1b[36mContextCompressor\x1b[0m')
{
  const compressor = new ContextCompressor({ threshold: 50, preserveTurns: 1 })
  
  const store = new MessageStore()
  const text = 'A'.repeat(300)  // ~75 tokens
  store.push(createUserMessage(text))
  store.push(createAssistantMessage(text))
  store.push(createUserMessage(text))
  store.push(createAssistantMessage(text))  // 4 messages = ~300 tokens
  
  assert(compressor.shouldCompact(store.getAll()), '应触发压缩')
  
  const result = await compressor.compact(store)
  assert(result !== null, '压缩返回结果')
  assert(result.originalTokenCount > 0, '原始 token 数 > 0')
  assert(result.compactedTokenCount <= result.originalTokenCount, '压缩后 token 数减少')
  assert(result.summary.length > 0, '摘要非空')
  assert(typeof result.summary === 'string', '摘要为字符串')
  assert(result.preservedMessages.length > 0, '保留了消息')
  
  // 小消息不触发
  const smallStore = new MessageStore()
  smallStore.push(createUserMessage('hi'))
  assert(!compressor.shouldCompact(smallStore.getAll()), '小消息不触发压缩')
}

// ---------- 5. PromptBuilder ----------
console.log('\n\x1b[36mPromptBuilder\x1b[0m')
{
  const builder = new PromptBuilder()
  builder
    .addStatic('test1', () => '# 身份\n你是助手')
    .addStatic('test2', () => '# 规则\n要帮助用户')
    .addDynamic('cache_test', () => '# 动态内容\n只有第一次生成')
  
  const result = builder.build()
  assert(result.includes('身份'), '包含身份节')
  assert(result.includes('规则'), '包含规则节')
  assert(result.includes('动态内容'), '包含动态节')
  
  // 缓存机制
  const calls = []
  const builder2 = new PromptBuilder()
  builder2.addDynamic('cached', () => { calls.push(1); return '# 缓存测试' })
  builder2.build()
  builder2.build()
  assert(calls.length === 1, '动态节只计算一次（缓存命中）')
  
  // 清除缓存后重新计算
  builder2.clearCache()
  builder2.build()
  assert(calls.length === 2, '清除缓存后重新计算')
  
  // 返回 null 的动态节不入缓存
  const nullCalls = []
  const builder3 = new PromptBuilder()
  builder3.addDynamic('null_test', () => { nullCalls.push(1); return null })
  builder3.build()
  builder3.build()
  assert(nullCalls.length === 2, '返回 null 的动态节每次都计算')
}

// ---------- 6. 内置工具 ----------
console.log('\n\x1b[36m内置工具 — Read\x1b[0m')
{
  const result1 = await ReadTool.call({ file_path: 'package.json' })
  assert(!result1.isError, '读 package.json 成功')
  assert(result1.data.file_path.endsWith('package.json'), '文件路径正确')
  assert(result1.data.lines.length > 0, '有内容')
  assert(result1.data.total_lines > 0, '总行数 > 0')
  
  const result2 = await ReadTool.call({ file_path: '/etc/shadow' })
  assert(result2.isError, '不允许读 /etc/shadow')
  
  const result3 = await ReadTool.call({ file_path: '不存在的文件.xyz' })
  assert(result3.isError, '不存在的文件返回错误')
  
  // offset+limit
  const result4 = await ReadTool.call({ file_path: 'package.json', offset: 1, limit: 3 })
  assert(!result4.isError, 'offset+limit')
  assert(result4.data.lines.length <= 3, 'limit 生效')
}

console.log('\x1b[36m内置工具 — Search\x1b[0m')
{
  const result = await SearchTool.call({ pattern: 'OICOS', path: '.', max_results: 5 })
  assert(!result.isError, '搜索 OICOS 成功')
  // 可能搜到也可能搜不到，取决于当前是否有匹配
  assert(typeof result.data.total === 'number', '搜索结果数有效')
  assert(Array.isArray(result.data.results), '结果是数组')
}

console.log('\x1b[36m内置工具 — Edit\x1b[0m')
{
  // 先写一个测试文件
  const testFile = '/tmp/oicos_test_edit.txt'
  fs.writeFileSync(testFile, '原始内容\n第二行\n第三行', 'utf8')
  
  const result = await EditTool.call({ file_path: testFile, old_string: '原始内容', new_string: '修改后的内容' })
  assert(!result.isError, '编辑文件成功')
  assert(result.data.file_path === testFile, '文件路径正确')
  assert(result.data.backup, '有备份')
  
  const content = fs.readFileSync(testFile, 'utf8')
  assert(content.includes('修改后的内容'), '内容已修改')
  
  // 清理
  fs.unlinkSync(testFile)
  if (fs.existsSync(testFile + '.bak')) fs.unlinkSync(testFile + '.bak')
  
  // 创建新文件（金刚经：Edit即Write，文件不存在时创建）
  const result2 = await EditTool.call({ file_path: '/tmp/oicos_test_created.txt', old_string: '', new_string: '新创建的文件内容' })
  assert(!result2.isError, '创建新文件成功')
  assert(result2.data.created === true, '标记为创建')
  const createdContent = fs.readFileSync('/tmp/oicos_test_created.txt', 'utf8')
  assert(createdContent === '新创建的文件内容', '创建的文件内容正确')
  fs.unlinkSync('/tmp/oicos_test_created.txt')
  
  // 文件存在但old_string为空 → 应报错
  fs.writeFileSync('/tmp/oicos_test_existing.txt', 'existing', 'utf8')
  const result2b = await EditTool.call({ file_path: '/tmp/oicos_test_existing.txt', old_string: '', new_string: 'xxx' })
  assert(result2b.isError, '文件已存在时old_string不能为空')
  fs.unlinkSync('/tmp/oicos_test_existing.txt')
  
  // 不存在的原文
  fs.writeFileSync(testFile, 'hello', 'utf8')
  const result3 = await EditTool.call({ file_path: testFile, old_string: 'world', new_string: 'xxx' })
  assert(result3.isError, '不存在的原文返回错误')
  fs.unlinkSync(testFile)
}

console.log('\x1b[36m内置工具 — Bash\x1b[0m')
{
  const result = await BashTool.call({ command: 'echo "hello oicos"', timeout: 5000 })
  assert(result.data.exit_code === 0, '命令成功')
  assert(result.data.stdout.includes('hello'), '输出正确')
  
  const result2 = await BashTool.call({ command: 'echo "error test" >&2; exit 1', timeout: 5000 })
  assert(result2.isError !== false, '失败命令标记错误')
}

// ---------- 7. SessionStore ----------
console.log('\n\x1b[36mSessionStore\x1b[0m')
{
  const store = new SessionStore()
  assert(store !== null, '创建成功')
  assert(store.store.length === 0, '初始消息为空')
  
  store.store.push(createUserMessage('测试消息'))
  store.markDirty()
  await store.flush()
  
  // 检查文件是否存在
  assert(fs.existsSync(store.metaPath), 'meta 文件存在')
  assert(fs.existsSync(store.messagesPath), 'messages 文件存在')
  
  // 重新加载
  const loaded = await SessionStore.load(store.meta.id)
  assert(loaded !== null, '加载成功')
  assert(loaded.store.length === 1, '加载后消息数正确')
  
  // 列出会话
  const sessions = await SessionStore.list()
  assert(sessions.length >= 1, '至少有一个会话')
  
  // 清理测试数据
  fs.rmSync(store.sessionPath, { recursive: true, force: true })
}

// ---------- 8. Logger ----------
console.log('\n\x1b[36mLogger\x1b[0m')
{
  // 只是调用，不崩溃即可
  log.debug('test', 'debug msg')
  log.info('test', 'info msg')
  log.warn('test', 'warn msg')
  log.error('test', 'error msg')
  log.info('test', 'with data', { key: 'value' })
  assert(true, '日志调用不崩溃')
}

// ---------- 9. MCP Client ----------
console.log('\n\x1b[36p\x1b[36mMCP Client\x1b[0m')
{
  const client = new MCPClient()
  assert(!client.isConnected, '初始未连接')
  assert(client.tools.length === 0, '初始无工具')
  assert(client.servers.length === 0, '初始无服务器')
  
  client.addServer({ name: 'test-server', type: 'stdio', command: 'echo', args: [] })
  assert(client.servers.length === 1, '添加服务器')
  assert(client.servers[0] === 'test-server', '服务器名正确')
  
  // connectAll 为占位，确认不崩溃
  const result = await client.connectAll()
  assert(result.connected === 1, '连接计数')
}

// ---------- 10. Estimate tokens ----------
console.log('\n\x1b[36mToken估算\x1b[0m')
{
  const tokens = estimateTokens('Hello World')
  assert(tokens > 0, '英文字符估算')
  
  const tokens2 = estimateTokens('你好世界')
  assert(tokens2 > 0, '中文字符估算')
  
  const tokens3 = estimateTokens('')
  assert(tokens3 === 0, '空字符串估算为0')
}

// ---------- 总结果 ----------
console.log(`\n\x1b[36m═══════════════════════════`)
console.log(`  结果: ${passed} 通过, ${failed} 失败`)
console.log(`═══════════════════════════\x1b[0m`)
if (failed > 0) process.exit(1)
