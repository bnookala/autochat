import net from 'node:net'
import fs from 'node:fs'
import { sockPath, runDir, ensureDir } from './paths.js'

const MAX = 256 * 1024

// Local-only channel from hook processes to the (single) lolchat UI process.
export function serve (onMessage) {
  return new Promise((resolve, reject) => {
    const p = sockPath()
    if (process.platform !== 'win32') ensureDir(runDir())
    const server = net.createServer((sock) => {
      let buf = ''
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
          let reply = { ok: !!msg }
          if (msg) {
            try { reply = { ok: true, ...(onMessage(msg) || {}) } } catch (err) { reply = { ok: false, error: err.message } }
          }
          sock.end(JSON.stringify(reply) + '\n')
        }
      })
    })
    const listen = (retried) => {
      server.once('error', async (err) => {
        if (err.code !== 'EADDRINUSE' || retried || process.platform === 'win32') return reject(err)
        // Socket file exists: is another UI alive, or is it stale?
        const alive = await send({ type: 'ping' }, 400)
        if (alive) return reject(Object.assign(new Error('lolchat UI already running'), { code: 'ALREADY_RUNNING' }))
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
