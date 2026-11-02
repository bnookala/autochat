import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { sockPath, home } from '../paths.js'
import { envVar } from '../env.js'
import { appInstalled, APP_BUNDLE_ID } from '../launcher.js'

// The daemon client: one persistent agent connection to the daemon's unix socket, and waking
// AutoChat.app when nothing listens there.

export const NOT_RUNNING = "autochat isn't running: open AutoChat.app or run `autochat daemon`"
const TUI_RUNNING = 'autochat is running in a terminal, but agent rooms need the autochat daemon: open AutoChat.app or run `autochat daemon`'
const LOST = 'lost the connection to autochat; reconnecting, try again'

/**
 * One persistent agent connection to the daemon. It reconnects with backoff forever, resending
 * agent-hello with the resume token, so a daemon restart or a brief drop keeps the agent's
 * identity when possible. On macOS with AutoChat.app installed (and the default AUTOCHAT_HOME),
 * a missing daemon wakes the app.
 */
export class DaemonLink extends EventEmitter {
  constructor ({ hello, env = process.env, log = () => {}, wake = wakeApp, retryMaxMs = 15000 }) {
    super()
    this.hello = hello
    this.env = env
    this.log = log
    this.wake = wake
    this.retryMaxMs = retryMaxMs
    this.backoff = 500
    this.sock = null
    this.connected = false
    this.everConnected = false
    this.token = null
    this.agent = null
    this.lastError = null
    this.pending = new Map()
    this.ids = 0
    this.closed = false
    this.retryTimer = null
    this.wokeAt = 0
  }

  start () { this._connect() }

  _connect () {
    if (this.closed || this.sock) return
    clearTimeout(this.retryTimer)
    const sock = net.connect(sockPath())
    this.sock = sock
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify({ ...this.hello, resume: this.token }) + '\n'))
    sock.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let msg = null
        try { msg = JSON.parse(line) } catch {}
        if (msg) this._line(msg)
      }
    })
    sock.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') this.lastError = NOT_RUNNING
      else this.lastError = `can't reach autochat (${err.code || err.message})`
    })
    sock.on('close', () => this._closed(sock))
  }

  _line (msg) {
    if (msg.type === 'agent-welcome') {
      this.connected = true
      this.everConnected = true
      this.token = msg.resume
      this.agent = msg.agent
      this.backoff = 500
      this.lastError = null
      this.log(`connected as ${msg.agent?.display}`)
      this.emit('connected', msg)
    } else if (msg.type === 'error') {
      this.lastError = msg.error === 'agent rooms need the autochat daemon' ? TUI_RUNNING : `autochat refused the connection: ${msg.error}`
      this.log(this.lastError)
    } else if (msg.type === 'reply') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      p.resolve(msg)
    }
  }

  _closed (sock) {
    if (this.sock !== sock) return
    this.sock = null
    const wasConnected = this.connected
    this.connected = false
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(LOST)) }
    this.pending.clear()
    if (this.closed) return
    if (wasConnected) {
      this.lastError = LOST
      this.emit('disconnected')
    } else if (!this.everConnected && this.lastError === NOT_RUNNING) {
      this._maybeWake()
    }
    this.retryTimer = setTimeout(() => this._connect(), this.backoff)
    this.retryTimer.unref?.()
    this.backoff = Math.min(this.retryMaxMs, this.backoff * 2)
  }

  // True while a recently woken AutoChat.app may still be starting its daemon.
  _maybeWake () {
    const now = Date.now()
    if (this.wokeAt && now - this.wokeAt < 30000) return now - this.wokeAt < 8000
    if (!this.wake(this.env)) return false
    this.wokeAt = now
    this.log('woke AutoChat.app')
    return true
  }

  // Waits until connected (polling the socket), for up to timeoutMs.
  async ready (timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (!this.connected && !this.closed && Date.now() < deadline) {
      if (!this.sock) this._connect()
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return this.connected
  }

  async request (cmd, args = {}, timeoutMs = 15000) {
    if (!this.connected && !await this.ready(1500) && this._maybeWake()) await this.ready(8000)
    if (!this.connected) throw new Error(this.lastError || NOT_RUNNING)
    if (!this.sock) throw new Error(LOST)
    const id = ++this.ids
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error("autochat didn't answer in time"))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.sock.write(JSON.stringify({ type: 'cmd', id, cmd, ...args }) + '\n')
    })
  }

  close () {
    this.closed = true
    clearTimeout(this.retryTimer)
    if (this.sock) this.sock.end()
  }
}

// Wake AutoChat.app (it starts `autochat daemon`), only for the default AUTOCHAT_HOME, which is
// the only one the app serves, and never while autochat is paused (launch=off).
export function wakeApp (env = process.env) {
  if (process.platform !== 'darwin' || envVar('HOME', env) || !appInstalled(env)) return false
  try {
    if (JSON.parse(fs.readFileSync(path.join(home(), 'config.json'), 'utf8')).launch === 'off') return false
  } catch {}
  const child = spawn('open', ['-g', '-b', APP_BUNDLE_ID], { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
  return true
}
