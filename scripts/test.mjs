// `npm test`: node --test over test/*.test.js, with a 2-minute cap per test (`npm test -- <flags>`
// passes more flags to node --test).
//
// On CI it also passes --test-force-exit, so a handle a test leaves open can't keep its file, and
// the job, running for hours (#100). Not locally: on older Node releases (22.4.1, for one) that flag
// sometimes ends a test file before all of its tests have run, and the run still passes (#116). A
// local hang shows, and Ctrl-C ends it; missing tests don't show.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

process.chdir(fileURLToPath(new URL('..', import.meta.url)))
const files = fs.readdirSync('test').filter(f => f.endsWith('.test.js')).sort().map(f => `test/${f}`)
const flags = ['--test', '--test-timeout=120000', ...(process.env.CI ? ['--test-force-exit'] : [])]
const run = spawnSync(process.execPath, [...flags, ...process.argv.slice(2), ...files], { stdio: 'inherit' })
process.exit(run.status ?? 1)
