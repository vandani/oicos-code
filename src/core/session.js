// ============================================================
// OICOS Session — 会话持久化 & Resume
// ============================================================
// 每次消息变更自动持久化，下次启动可恢复

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { MessageStore } from './message.js'

const SESSIONS_DIR = path.resolve(process.env.OICOS_DATA_DIR || path.join(process.env.HOME || '/tmp', '.oicos', 'sessions'))
const ACTIVE_SESSION_LINK = path.resolve(SESSIONS_DIR, 'active.json')

export function ensureSessionsDir() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  }
}

/** 会话元数据 */
function createMeta(store, config = {}) {
  return {
    id: config.id || `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    created: Date.now(),
    updated: Date.now(),
    turnCount: 0,
    messageCount: store.length,
    model: config.model || 'unknown',
    provider: config.provider || 'unknown',
    totalTokens: config.totalTokens || 0,
  }
}

export class SessionStore {
  constructor() {
    ensureSessionsDir()
    /** @type {import('./message.js').MessageStore} */
    this.store = new MessageStore()
    this.meta = createMeta(this.store)
    this._dirty = false
    this._flushTimer = null
    this._sessionDir = path.join(SESSIONS_DIR, this.meta.id)
  }

  /** 当前会话路径 */
  get sessionPath() { return this._sessionDir }
  get messagesPath() { return path.join(this._sessionDir, 'messages.json') }
  get metaPath() { return path.join(this._sessionDir, 'meta.json') }

  /** 从磁盘加载已有会话 */
  static async load(sessionId) {
    const dir = path.join(SESSIONS_DIR, sessionId)
    const metaPath = path.join(dir, 'meta.json')
    const msgPath = path.join(dir, 'messages.json')

    if (!fs.existsSync(metaPath) || !fs.existsSync(msgPath)) {
      return null
    }

    const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'))
    const messagesData = JSON.parse(await fsp.readFile(msgPath, 'utf8'))
    const store = MessageStore.deserialize(messagesData)

    const session = new SessionStore()
    session.store = store
    session.meta = meta
    session._sessionDir = dir
    return session
  }

  /** 列出所有可用会话 */
  static async list() {
    ensureSessionsDir()
    const entries = await fsp.readdir(SESSIONS_DIR, { withFileTypes: true })
    const sessions = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const metaPath = path.join(SESSIONS_DIR, entry.name, 'meta.json')
      if (!fs.existsSync(metaPath)) continue
      try {
        const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'))
        sessions.push(meta)
      } catch {}
    }
    return sessions.sort((a, b) => b.updated - a.updated)
  }

  /** 标记为脏，调度持久化 */
  markDirty() {
    this._dirty = true
    this.meta.updated = Date.now()
    this.meta.messageCount = this.store.length

    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => this.flush(), 100)
    }
  }

  /** 立即持久化 */
  async flush() {
    this._flushTimer = null
    if (!this._dirty) return
    this._dirty = false

    ensureSessionsDir()

    // 使用临时文件 + 原子重命名防损坏
    const tmpDir = this._sessionDir + '.tmp'
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true })
    }

    await fsp.writeFile(path.join(tmpDir, 'meta.json'), JSON.stringify(this.meta, null, 2), 'utf8')
    await fsp.writeFile(path.join(tmpDir, 'messages.json'), JSON.stringify(this.store.serialize(), null, 2), 'utf8')

    // 原子重命名
    if (fs.existsSync(this._sessionDir)) {
      const oldDir = this._sessionDir + '.old'
      await fsp.rename(this._sessionDir, oldDir).catch(() => {})
      await fsp.rename(tmpDir, this._sessionDir)
      await fsp.rm(oldDir, { recursive: true, force: true }).catch(() => {})
    } else {
      await fsp.rename(tmpDir, this._sessionDir)
    }

    // 更新 active 链接
    await fsp.writeFile(ACTIVE_SESSION_LINK, JSON.stringify({
      activeSessionId: this.meta.id,
      updated: Date.now(),
    }), 'utf8')
  }

  /** 获取最后活跃的会话ID */
  static async getActiveSessionId() {
    ensureSessionsDir()
    if (!fs.existsSync(ACTIVE_SESSION_LINK)) return null
    try {
      const data = JSON.parse(await fsp.readFile(ACTIVE_SESSION_LINK, 'utf8'))
      return data.activeSessionId || null
    } catch {
      return null
    }
  }

  /** 获取会话摘要（用于 resume） */
  getResumeSummary() {
    const lastMessages = this.store.getLastTurns(3)
    return {
      id: this.meta.id,
      created: new Date(this.meta.created).toLocaleString('zh-CN'),
      turns: this.meta.turnCount,
      messages: this.meta.messageCount,
      model: this.meta.model,
      lastTopic: lastMessages[0]?.content?.slice(0, 100) || '(空)',
    }
  }
}
