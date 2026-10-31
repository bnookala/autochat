import net from 'node:net'
import fs from 'node:fs'
import { sockPath, runDir, ensureDir } from './paths.js'

export const MAX = 256 * 1024
export const PROTOCOL = 1
export const MAX_SUBSCRIBERS = 8
const MAX_BACKLOG = 1024 * 1024
const MIN_INTERVAL_MS = 50

// One state line, kept under the line cap by dropping the oldest messages first.
export function encodeState (state) {
  let line = JSON.stringify(state)
  if (Buffer.byteLength(line) <= MAX || !Array.isArray(state.messages)) return line
  const s = { ...state, messages: [...state.messages] }
  while (Buffer.byteLength(line) > MAX && s.messages.length) {
    s.messages.splice(0, Math.max(1, Math.ceil(s.messages.length / 8)))
    line = JSON.stringify(s)
  }
  return line
}

/**
 * Local-only channel to the (single) lolchat process: the terminal UI or `lolchat daemon`.
 * Hooks send one-shot messages (one line in, one reply line out, then close).
 * Clients whose first line is {"type":"subscribe"} keep the connection: they get a
 * state snapshot now and after every publish() (≤ 20/s), and may send {"type":"cmd"}
 * lines. See docs/protocol.md.
 */
export function serve (onMessage, { state, command, maxSubscribers = MAX_SUBSCRIBERS } = {}) {
  const subs = new Set()
  const write = (sock, line) => {
    if (sock.destroyed) return
    sock.write(line + '\n')
    // A client that stopped reading must not grow our memory without bound.
    if (sock.writableLength > MAX_BACKLOG) sock.destroy()
  }
  const refuse = (sock, error) => { sock.end(JSON.stringify({ type: 'error', v: PROTOCOL, error }) + '\n'); return false }

  const subscribe = (sock, msg) => {
    if (!state) return refuse(sock, 'subscriptions not supported')
    if (msg.v !== undefined && msg.v !== PROTOCOL) return refuse(sock, 'unsupported protocol version')
    if (subs.size >= maxSubscribers) return refuse(sock, 'too many subscribers')
    subs.add(sock)
    sock.on('close', () => subs.delete(sock))
    write(sock, encodeState(state()))
    return true
  }

  const runCommand = (sock, msg) => {
    const id = msg?.id ?? null
    const reply = (r) => write(sock, JSON.stringify({ type: 'reply', id, ...r }))
    if (!msg || msg.type !== 'cmd') return reply({ ok: false, error: msg ? 'unknown message type' : 'invalid json' })
    Promise.resolve()
      .then(() => command(msg))
      .then(() => reply({ ok: true }), (err) => reply({ ok: false, error: err?.message || String(err) }))
  }

  const server = net.createServer((sock) => {
    let buf = ''
    let subscribed = false
    sock.setEncoding('utf8')
    sock.on('error', () => {})
    sock.on('data', (d) => {
      buf += d
      if (buf.length > MAX) { sock.destroy(); return }
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let msg = null
        try { msg = JSON.parse(line) } catch {}
        if (subscribed) { runCommand(sock, msg); continue }
        if (msg?.type === 'subscribe') {
          if (!subscribe(sock, msg)) return
          subscribed = true
          continue
        }
        let reply = { ok: !!msg }
        if (msg) {
          try { reply = { ok: true, ...(onMessage(msg) || {}) } } catch (err) { reply = { ok: false, error: err.message } }
        }
        sock.end(JSON.stringify(reply) + '\n')
      }
    })
  })

  // Snapshots are full state, so a burst of changes coalesces into one.
  let timer = null
  let last = 0
  const flush = () => {
    timer = null
    last = Date.now()
    if (!subs.size) return
    const line = encodeState(state())
    for (const sock of subs) write(sock, line)
  }
  server.publish = () => {
    if (timer || !subs.size || !state) return
    timer = setTimeout(flush, Math.max(0, last + MIN_INTERVAL_MS - Date.now()))
  }
  server.subscribers = subs
  const close = server.close.bind(server)
  server.close = (cb) => {
    clearTimeout(timer)
    for (const sock of subs) sock.end()
    return close(cb)
  }

  return new Promise((resolve, reject) => {
    const p = sockPath()
    if (process.platform !== 'win32') ensureDir(runDir())
    const listen = (retried) => {
      server.once('error', async (err) => {
        if (err.code !== 'EADDRINUSE' || retried || process.platform === 'win32') return reject(err)
        // Socket file exists: is another lolchat alive, or is it stale?
        const alive = await send({ type: 'ping' }, 400)
        if (alive) return reject(Object.assign(new Error('lolchat already running'), { code: 'ALREADY_RUNNING', info: alive }))
        try { fs.unlinkSync(p) } catch {}
        listen(true)
      })
      server.listen(p, () => {
        if (process.platform !== 'win32') { try { fs.chmodSync(p, 0o600) } catch {} }
        resolve(server)
      })
    }
    listen(false)
  })
}

// Resolves to the UI's reply object, or null if no UI is listening.
export function send (msg, timeoutMs = 500) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve(v) } }
    const sock = net.connect(sockPath())
    const timer = setTimeout(() => finish(null), timeoutMs)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'))
    sock.on('data', (d) => {
      buf += d
      const i = buf.indexOf('\n')
      if (i !== -1) {
        try { finish(JSON.parse(buf.slice(0, i))) } catch { finish(null) }
      }
    })
    sock.on('error', () => finish(null))
    sock.on('close', () => finish(null))
  })
}
