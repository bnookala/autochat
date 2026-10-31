import fs from 'node:fs'
import path from 'node:path'
import nodeCrypto from 'node:crypto'
import hcrypto from 'hypercore-crypto'
import b4a from 'b4a'
import { home, ensureDir } from './paths.js'
import { ADJECTIVES, ANIMALS } from './words.js'

// Readable 256-color palette indices for handles.
const PALETTE = [39, 45, 49, 78, 114, 149, 179, 185, 203, 209, 213, 177, 141, 105, 81, 220]

export function identityPath () {
  return path.join(home(), 'identity.json')
}

function fromKeyPair (kp) {
  const publicKey = b4a.toString(kp.publicKey, 'hex')
  return {
    publicKey,
    secretKey: kp.secretKey,
    publicKeyBuf: kp.publicKey,
    handle: handleFor(publicKey),
    color: colorFor(publicKey)
  }
}

// A fresh identity that is never saved (used by `autochat sim` and tests).
export function ephemeralIdentity () {
  return fromKeyPair(hcrypto.keyPair())
}

export function loadIdentity () {
  const file = identityPath()
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return fromKeyPair({
      publicKey: b4a.from(raw.publicKey, 'hex'),
      secretKey: b4a.from(raw.secretKey, 'hex')
    })
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  ensureDir(home())
  const kp = hcrypto.keyPair()
  const data = {
    publicKey: b4a.toString(kp.publicKey, 'hex'),
    secretKey: b4a.toString(kp.secretKey, 'hex'),
    createdAt: new Date().toISOString()
  }
  // wx: never clobber an identity another process created concurrently.
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  } catch (err) {
    if (err.code === 'EEXIST') return loadIdentity()
    throw err
  }
  return fromKeyPair(kp)
}

// Keeps the pre-rename `lolchat:` namespace: peers derive each other's handles from it,
// so changing it would rename everyone (and disagree with older clients).
function digest (pubHex) {
  return nodeCrypto.createHash('sha256').update('lolchat:v1:handle:' + pubHex).digest()
}

export function handleFor (pubHex) {
  const h = digest(pubHex)
  const adj = ADJECTIVES[h[0] % ADJECTIVES.length]
  const animal = ANIMALS[h[1] % ANIMALS.length]
  return `${adj}-${animal}-${h.subarray(2, 3).toString('hex')}`
}

export function colorFor (pubHex) {
  return PALETTE[digest(pubHex)[3] % PALETTE.length]
}
