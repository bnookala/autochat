import nodeCrypto from 'node:crypto'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { ADJECTIVES, ANIMALS } from './words.js'

export const PROTOCOL_VERSION = 1
export const DEFAULT_ROOM = 'lobby'
export const MAX_LINE = 16 * 1024
export const MAX_TEXT = 500

const sha = (s) => nodeCrypto.createHash('sha256').update(s).digest()

// Public rooms are plain names (shown as #name). Private rooms are generated
// invite codes with an `lc1-` prefix and enough randomness to be unguessable.
// `lc1-` predates the autochat rename; it stays so existing invite codes keep working.
const PUBLIC_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const PRIVATE_RE = /^lc1-[a-z0-9-]{8,80}$/

export function parseRoom (input) {
  if (typeof input !== 'string') throw new Error('room code required')
  let s = input.trim().toLowerCase()
  if (s.startsWith('#')) s = s.slice(1)
  if (PRIVATE_RE.test(s)) {
    const words = s.split('-').slice(1, 3).join('-')
    return { code: s, isPublic: false, canonical: 'priv:' + s, display: 'private:' + words }
  }
  if (PUBLIC_RE.test(s) && !s.startsWith('lc1-')) {
    return { code: s, isPublic: true, canonical: 'pub:' + s, display: '#' + s }
  }
  throw new Error(`invalid room code "${input}" (public: letters/digits/-/_ up to 32 chars; private: lc1-…)`)
}

export function generatePrivateCode () {
  const r = nodeCrypto.randomBytes(16)
  const adj = ADJECTIVES[r[0] % ADJECTIVES.length]
  const animal = ANIMALS[r[1] % ANIMALS.length]
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
  let tail = ''
  for (let i = 2; i < 14; i++) tail += alphabet[r[i] % alphabet.length]
  return `lc1-${adj}-${animal}-${tail}`
}

// Wire namespace from before the lolchat → autochat rename. It feeds the DHT topics, room
// keys, room tags and signed host claims, so renaming it would split us from existing peers.
const NS = 'lolchat:v1:'
export const topicFor = (room) => sha(NS + 'topic:' + room.canonical)
export const roomKeyFor = (room) => sha(NS + 'roomkey:' + room.canonical)
// Bound into every signed message so it can't be replayed into another room.
export const roomTagFor = (room) => sha(NS + 'roomtag:' + roomKeyFor(room).toString('hex')).toString('hex').slice(0, 32)
export const DIRECTORY_TOPIC = sha(NS + 'directory')

const instClaim = (roomTag, inst) => b4a.from(`${NS}inst:${roomTag}:${inst.iid}:${inst.createdAt}:${inst.hostId}`)

// A room instance is a claim signed by its host, so nobody can make someone else (or a ghost) host.
export function signInst (identity, roomTag, inst) {
  return { ...inst, sig: b4a.toString(hcrypto.sign(instClaim(roomTag, inst), identity.secretKey), 'hex') }
}

export function verifyInst (roomTag, inst) {
  if (!inst || typeof inst !== 'object' || typeof inst.sig !== 'string' || !/^[0-9a-f]{128}$/.test(inst.sig)) return false
  if (typeof inst.hostId !== 'string' || !/^[0-9a-f]{64}$/.test(inst.hostId)) return false
  if (typeof inst.iid !== 'string' || !/^[0-9a-f]{16}$/.test(inst.iid) || !Number.isFinite(inst.createdAt)) return false
  try {
    return hcrypto.verify(instClaim(roomTag, inst), b4a.from(inst.sig, 'hex'), b4a.from(inst.hostId, 'hex'))
  } catch { return false }
}

// Both sides of a connection derive the same proof only if they share the room key,
// without revealing the key (or the private code) to non-members.
export function proofFor (roomKey, keyA, keyB) {
  const [x, y] = b4a.compare(keyA, keyB) <= 0 ? [keyA, keyB] : [keyB, keyA]
  return nodeCrypto.createHash('sha256').update(roomKey).update(x).update(y).digest('hex')
}

export function seal (identity, body) {
  const p = JSON.stringify(body)
  const s = b4a.toString(hcrypto.sign(b4a.from(p), identity.secretKey), 'hex')
  return JSON.stringify({ p, s })
}

// Returns the verified payload, or null for anything malformed or forged.
export function open (obj) {
  if (!obj || typeof obj.p !== 'string' || typeof obj.s !== 'string') return null
  if (!/^[0-9a-f]{128}$/.test(obj.s)) return null
  let body
  try { body = JSON.parse(obj.p) } catch { return null }
  if (!body || typeof body !== 'object' || typeof body.from !== 'string' || !/^[0-9a-f]{64}$/.test(body.from)) return null
  try {
    if (!hcrypto.verify(b4a.from(obj.p), b4a.from(obj.s, 'hex'), b4a.from(body.from, 'hex'))) return null
  } catch { return null }
  return body
}

export function randomId (bytes = 8) {
  return nodeCrypto.randomBytes(bytes).toString('hex')
}

// Strip terminal escape sequences, control chars and bidi overrides from untrusted text.
export function sanitize (text, max = MAX_TEXT) {
  if (typeof text !== 'string') return ''
  let s = text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '') // OSC
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[PX^_][^\x1b]*(\x1b\\)?/g, '') // DCS/SOS/PM/APC
    .replace(/\x1b./g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, '')
    .trim()
  const chars = Array.from(s)
  if (chars.length > max) s = chars.slice(0, max - 1).join('') + '…'
  return s
}
