import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// Temp dirs for tests that put a unix socket in them (<dir>/<home>/run/ui.sock). A socket's path
// is at most 104 bytes on macOS (108 on Linux): a longer one is cut short, and the sockets of
// different tests collide. A long TMPDIR, as in agents' sandboxes, leaves no room for one. So
// the dirs go in the first of these that's short enough and writable: os.tmpdir(), the per-user
// temp dir (XDG_RUNTIME_DIR, or macOS's DARWIN_USER_TEMP_DIR, which TMPDIR overrides), /tmp.

// What a test may put under its dir, "/lc-app-bad/run/ui.sock" at most, with room to spare.
const ROOM = 40
const SUN_PATH = process.platform === 'linux' ? 108 : 104
const DIR = '/ac-XXXXXX'

function* candidates () {
  yield os.tmpdir()
  yield process.env.XDG_RUNTIME_DIR
  if (process.platform === 'darwin') {
    try { yield execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch {}
  }
  yield '/tmp'
}

let base = null
function shortBase () {
  if (base) return base
  for (const dir of candidates()) {
    if (!dir || !path.isAbsolute(dir)) continue
    const d = dir.length > 1 ? dir.replace(/\/+$/, '') : dir
    if (Buffer.byteLength(d) + DIR.length + ROOM >= SUN_PATH) continue
    try {
      fs.accessSync(d, fs.constants.W_OK)
      base = d
      return base
    } catch {}
  }
  throw new Error(`no temp dir is short enough for the tests' unix sockets: set TMPDIR to a path of at most ${SUN_PATH - DIR.length - ROOM - 1} bytes`)
}

/** A new temp dir, <short temp dir>/ac-XXXXXX, with room for the unix sockets a test puts in it. */
export function tmpDir () {
  return fs.mkdtempSync(path.join(shortBase(), 'ac-'))
}
