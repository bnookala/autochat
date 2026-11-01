// Outbound secret scanning for the agent room: post text, status summaries, thread titles
// and outcomes. findSecret() names the kind of secret and never returns the match itself.

const mixed = (s) => /\d/.test(s) && /[A-Za-z]/.test(s)

const RULES = [
  ['private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g],
  ['github token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ['aws access key', /\b(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}\b/g],
  ['slack token', /\b(?:xox[a-z]|xapp)-[A-Za-z0-9-]{10,}|hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/g],
  ['anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['api key', /\bsk-(?:proj-|svcacct-|admin-)?([A-Za-z0-9_-]{20,})/g, (m) => mixed(m[1])],
  ['jwt', /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}/g],
  ['connection string', /\b(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+/]{20,}/gi]
]

// `password = …`, `client_secret: "…"`, `GITHUB_TOKEN=…`: the key ends in a credential word.
const ASSIGN = /\b[\w.-]*?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)["']?[ \t]*(?:=|:)[ \t]*(["'`]?)([^\s"'`,;]{8,})\1/gi
const PLACEHOLDER = /^(?:null|undefined|none|nil|true|false|string|number|boolean|redacted|changeme|example|placeholder|x{3,}|\*{3,}|\.{3,}|<[^>]*>)$/i

function looksLikeValue (v) {
  if (PLACEHOLDER.test(v)) return false
  if (/^(?:\$|process\.env|os\.environ|env\.|getenv|https?:)/i.test(v)) return false
  if (/[()[\]{}<>]/.test(v)) return false
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v)) return false
  if (/\//.test(v) && /\.[a-z]{1,5}(?::\d+)?$/i.test(v)) return false
  return mixed(v)
}

/** The kind of secret `text` seems to contain ("github token", …), or null. */
export function findSecret (text) {
  if (typeof text !== 'string' || !text) return null
  for (const [kind, re, check = () => true] of RULES) {
    for (const m of text.matchAll(re)) if (check(m)) return kind
  }
  for (const m of text.matchAll(ASSIGN)) {
    if (looksLikeValue(m[2])) return 'credential assignment'
  }
  return null
}
