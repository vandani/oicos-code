// ============================================================
// OICOS Log — 结构化日志
// ============================================================

import fs from 'fs'

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }

let currentLevel = process.env.OICOS_LOG_LEVEL || 'info'
const logFile = process.env.OICOS_LOG_FILE || null

// 延迟初始化文件流
let _logStream = null
function getLogStream() {
  if (!logFile) return null
  if (!_logStream) {
    _logStream = fs.createWriteStream(logFile, { flags: 'a' })
  }
  return _logStream
}

export function setLevel(level) {
  if (level in LOG_LEVELS) currentLevel = level
}

function shouldLog(level) {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel]
}

function timestamp() {
  return new Date().toISOString()
}

function write(level, tag, msg, data) {
  if (!shouldLog(level)) return
  
  const prefix = `[${timestamp()}] [${level.toUpperCase()}] [${tag}]`
  const line = data ? `${prefix} ${msg} ${JSON.stringify(data)}` : `${prefix} ${msg}`
  
  // 控制台
  if (level === 'error' || level === 'warn') {
    console.error(line)
  } else if (process.env.OICOS_DEBUG) {
    console.error(line)
  }
  
  // 日志文件
  const stream = getLogStream()
  if (stream) {
    stream.write(line + '\n')
  }
}

export const log = {
  debug: (tag, msg, data) => write('debug', tag, msg, data),
  info: (tag, msg, data) => write('info', tag, msg, data),
  warn: (tag, msg, data) => write('warn', tag, msg, data),
  error: (tag, msg, data) => write('error', tag, msg, data),
}
