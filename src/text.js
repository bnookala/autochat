// Untrusted-text cleanup shared by the lounge, the agent room and the terminal views.
// No dependencies: the agent room imports this and must stay free of network modules.

export const MAX_TEXT = 500

const BIDI = /[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g

function stripEscapes (s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '') // OSC
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[PX^_][^\x1b]*(\x1b\\)?/g, '') // DCS/SOS/PM/APC
    .replace(/\x1b./g, '')
}

function clip (s, max) {
  const chars = Array.from(s)
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : s
}

// Strip terminal escape sequences, control chars and bidi overrides from untrusted text.
export function sanitize (text, max = MAX_TEXT) {
  if (typeof text !== 'string') return ''
  const s = stripEscapes(text)
    .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(BIDI, '')
    .trim()
  return clip(s, max)
}

// Like sanitize(), but keeps line breaks: tabs become spaces, trailing spaces go, and runs
// of more than 2 blank lines collapse to 2.
export function sanitizeMultiline (text, max = Infinity) {
  if (typeof text !== 'string') return ''
  const s = stripEscapes(text)
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(BIDI, '')
    .split('\n').map(l => l.trimEnd()).join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/^\n+|\n+$/g, '')
  return clip(s, max)
}

export const charCount = (s) => Array.from(s).length
