import Hyperswarm from 'hyperswarm'
import { DIRECTORY_TOPIC, PROTOCOL_VERSION, parseRoom } from './protocol.js'

// Lists live public rooms by briefly asking peers on the shared directory topic.
export async function listRooms ({ waitMs = 8000, bootstrap } = {}) {
  const swarm = new Hyperswarm(bootstrap ? { bootstrap } : {})
  const rooms = new Map()
  swarm.on('connection', (conn) => {
    conn.on('error', () => {})
    let buf = ''
    conn.write(JSON.stringify({ h: { v: PROTOCOL_VERSION } }) + '\n')
    conn.on('data', (d) => {
      buf += d.toString('utf8')
      if (buf.length > 64 * 1024) { conn.destroy(); return }
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let dir
        try { dir = JSON.parse(line)?.h?.dir } catch {}
        if (!dir || typeof dir.name !== 'string') continue
        let room
        try { room = parseRoom(dir.name) } catch { continue }
        if (!room.isPublic) continue
        const prev = rooms.get(room.code) || { name: room.display, code: room.code, active: 0, members: 0, peers: 0 }
        prev.active = Math.max(prev.active, Number(dir.active) || 0)
        prev.members = Math.max(prev.members, Number(dir.members) || 0)
        prev.peers++
        rooms.set(room.code, prev)
      }
    })
  })
  const discovery = swarm.join(DIRECTORY_TOPIC, { server: false, client: true })
  const t = setTimeout(() => discovery.refresh({ client: true, server: false }).catch(() => {}), Math.min(3000, waitMs / 2))
  await new Promise(resolve => setTimeout(resolve, waitMs))
  clearTimeout(t)
  await swarm.destroy().catch(() => {})
  return [...rooms.values()].sort((a, b) => b.active - a.active || a.name.localeCompare(b.name))
}
