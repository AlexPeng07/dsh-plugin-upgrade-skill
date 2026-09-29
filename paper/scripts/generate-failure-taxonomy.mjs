// Generate the failure-mode taxonomy assets from the hand-coded task corpus.
// Coding source of truth: the CODING array below. The script asserts it covers
// every benchmark/tasks entry, so a newly added task fails --check until coded.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../..', import.meta.url))
const C = (id, loudness, radius, basis) => ({ id, loudness, radius, basis })
const CODING = [
  C("S1-static-scan", "procedural", "none", "coverage scan exercise, no single incident"),
  C("S2-negative-scan", "procedural", "none", "negative control, no incident"),
  C("S5-negative-naming", "procedural", "none", "negative control, no incident"),
  C("S10-paste-rename-and-version-chip", "procedural", "none", "post-release follow-up procedures"),
  C("S3-snapshot-migration", "silent", "local", "legacy snapshot reads degrade without errors"),
  C("S4-legacy-client-imports", "loud", "local", "module resolution fails at build/boot"),
  C("S6-corridor-net-state", "silent", "local", "intermediate-state defense mis-handles new state"),
  C("S7-unpublished-cohort", "silent", "local", "packaging trap: installs locally, absent on registry"),
  C("S8-release-routing-trap", "misdirected", "local", "install failure blames mirror; cause is tag routing"),
  C("S9-composer-coordinate-trap", "silent", "local", "first use works, later ones silently misbehave"),
  C("S11-mermaid-lazyload-trap", "loud", "local", "chunk 404 and window errors at load"),
  C("S12-global-upgrade-ebusy-trap", "misdirected", "system", "EBUSY/MSVC errors blame locks; cause is live-process self-upgrade"),
  C("S13-peer-range-vs-runtime", "loud", "local", "installs clean, crashes at runtime start"),
  C("S14-link-install-lock-trap", "silent", "local", "link edits silently never reach the GUI"),
  C("S15-slot-error-boundary-crash", "loud", "cotenant", "one entry's throw unmounts the whole shared dock"),
  C("S16-self-host-upgrade-trap", "misdirected", "system", "npm replaces files under the running host itself"),
  C("S17-external-ui-plugin-onboarding-trap", "loud", "local", "raw-ESM bundle fails the module loader"),
  C("S18-terminal-sprite-render-trap", "silent", "local", "phantom pixels, no error"),
  C("S19-phantom-update-stale-host", "silent", "local", "update badge misleads about currency"),
  C("S20-msvc-flock-trap", "loud", "system", "native build dies, environment-level"),
  C("S21-resource-service-unavailable-trap", "silent", "local", "document tab opens but content silently fails"),
  C("S22-duplicate-insert-boot-crash-trap", "loud", "system", "duplicate loader id crashes boot"),
  C("S23-passing-compat-guard-trap", "silent", "local", "field-level removal passes presence guards"),
  C("S24-dock-cotenant-crash-trap", "loud", "cotenant", "shared drawer boundary unmounts innocent co-tenant"),
  C("M1-host-migration", "loud", "local", "plugin fails to start on new host"),
  C("M2-optional-dep-trap", "loud", "local", "unconditional import of optional dep"),
  C("M3-session-projection", "silent", "local", "degraded behavior without declared projection service"),
  C("M4-peer-prerelease-range", "silent", "local", "semver prerelease exclusion installs clean"),
  C("M5-token-auth-smoke", "silent", "local", "channel works, host auth silently missing"),
  C("M6-sleep-tool", "silent", "local", "tool shape drifts silently"),
  C("M7-d399-overlay", "loud", "local", "inject names deleted runtime, boot-fatal"),
  C("M8-brand-text", "loud", "local", "moved store engine and stale peer"),
  C("M9-mcpanel", "loud", "local", "removed runtime in inject, boot-fatal"),
  C("M10-tools-tree", "silent", "local", "service moved, missing silently"),
  C("M11-sidebar-spur", "loud", "local", "Context import from deleted runtime"),
  C("M12-interpreters-card", "silent", "local", "renamed Settings service unresolved"),
  C("M13-repository-plugins-removal", "loud", "local", "removed plugin shape never loads"),
  C("M14-service-renames-0812", "loud", "local", "pre-0812 service names fail resolution"),
  C("H1-plane-trap", "misdirected", "local", "source comments steer toward a fatal change"),
  C("H2-baseline-trap", "misdirected", "local", "pre-existing red test predates the migration"),
  C("H3-client-plane", "loud", "local", "missing required declaration refuses load"),
  C("H4-tsbuildinfo-trap", "misdirected", "local", "stale build artifact implicates deleted API"),
  C("H5-runtime-export-drift", "silent", "local", "green locally, drifts at runtime"),
  C("H6-remote-error-trap", "misdirected", "local", "comment pins old error handling"),
  C("H7-locale-trap", "silent", "local", "display-text anchoring breaks silently"),
  C("H8-fire-drill", "misdirected", "cotenant", "three plugins, three trap states in one release"),
  C("H9-dsh-web-alpha2", "loud", "local", "real-repo migration, import surface fails loudly"),
  C("H10-browser-activation-trap", "silent", "local", "manifest lists it, bundle 200s, never activates"),
  C("H11-dual-cohort-rpc", "silent", "local", "passes mocks, fails the real host"),
  C("H12-remote-result-boundary-trap", "silent", "local", "error vocabulary right, control flow wrong"),
  C("H13-ghost-host-trap", "silent", "system", "disk upgraded, host process still old"),
  C("H14-mineru-api", "loud", "local", "channel 404s after apiPrefix change"),
  C("H15-locale-pack", "silent", "local", "monkey-patch target moves silently"),
  C("H16-history-dock", "silent", "local", "contenteditable needs capture-phase listener"),
  C("H17-merge-calls", "loud", "local", "deleted derivations fail imports"),
  C("H18-blame-bubbles", "loud", "local", "deleted facade fails the call"),
  C("H19-workspace-ya", "silent", "cotenant", "official disabled UI must be taken over via slots"),
  C("H20-session-events-ledger", "loud", "local", "removed getter throws on iteration"),
  C("H21-question-answerer-waterfall", "silent", "local", "single-seat registration silently degrades"),
  C("H22-dsh-data-agent-alpha2", "loud", "local", "real-repo migration, loud import breaks"),
  C("H23-storage-domain-version-compat-trap", "silent", "local", "domain bump silently opens old data"),
  C("H24-invalid-record-salvage-trap", "misdirected", "local", "salvage logic implicates the wrong record"),
  C("H25-session-seed-boundary-trap", "silent", "local", "seed boundary semantics drift"),
  C("H26-notlisted-trap", "silent", "local", "installs cleanly, never registers"),
  C("H27-undeclared-import-trap", "loud", "local", "ERR_MODULE_NOT_FOUND at load"),
]
const taskDirs = fs.readdirSync(path.join(root, 'benchmark/tasks')).filter(d => /^[SMH]\d/.test(d)).sort()
const coded = new Set(CODING.map(c => c.id))
assert.deepEqual([...coded].filter(c => !taskDirs.includes(c)), [], 'coded tasks missing from benchmark/tasks')
assert.deepEqual(taskDirs.filter(t => !coded.has(t)), [], 'benchmark/tasks entries without taxonomy coding')
const LOUD = ['silent', 'misdirected', 'loud']
const RADIUS = ['local', 'cotenant', 'system']
const incident = CODING.filter(c => c.loudness !== 'procedural')
const counts = Object.fromEntries(LOUD.map(l => [l, Object.fromEntries(RADIUS.map(r => [r, incident.filter(c => c.loudness === l && c.radius === r).length]))]))
const byLoudness = Object.fromEntries(LOUD.map(l => [l, incident.filter(c => c.loudness === l).length]))
const byRadius = Object.fromEntries(RADIUS.map(r => [r, incident.filter(c => c.radius === r).length]))
const output = { coding: CODING, incidentTasks: incident.length, proceduralTasks: CODING.length - incident.length, counts, byLoudness, byRadius,
  interpretation: 'Author-coded from task provenance (fleet incidents and release diffs); single-coder, not independently annotated. loudness=silent|misdirected|loud, radius=local|cotenant|system.' }
const cell = (l, r) => { const ids = incident.filter(c => c.loudness === l && c.radius === r).map(c => c.id.split('-')[0]); const n = counts[l][r]; return n === 0 ? '---' : n + (ids.length ? ' (' + ids.slice(0, 6).join(', ') + (ids.length > 6 ? ', \\ldots' : '') + ')' : '') }
const row = (label, l) => label + ' & ' + cell(l, 'local') + ' & ' + cell(l, 'cotenant') + ' & ' + cell(l, 'system') + ' \\\\'
const summary = [
  '% AUTO-GENERATED by paper/scripts/generate-failure-taxonomy.mjs. DO NOT EDIT.',
  '\\begin{table}[t]', '\\centering', '\\small', '\\begin{tabular}{lccc}', '\\toprule',
  ' & plugin-local & co-tenant & system \\\\', '\\midrule',
  row('silent', 'silent'), row('misdirected', 'misdirected'), row('loud', 'loud'),
  '\\bottomrule', '\\end{tabular}',
  '\\caption{Failure-mode taxonomy of the ' + incident.length + ' incident-derived tasks (of ' + CODING.length + ' total; the rest are procedural controls), coded by first-observable-failure loudness and blast radius. Author-coded from task provenance; single-coder.}',
  '\\label{tab:taxonomy}', '\\end{table}', ''
].join('\n')
const esc = s => s.replace(/&/g, '\\&').replace(/_/g, '\\_').replace(/%/g, '\\%')
const rows = CODING.slice().sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })).map(c =>
  esc(c.id) + ' & ' + (c.loudness === 'procedural' ? 'procedural' : c.loudness) + ' & ' + (c.radius === 'none' ? '---' : c.radius) + ' & ' + esc(c.basis) + ' \\\\').join('\n')
const full = [
  '% AUTO-GENERATED by paper/scripts/generate-failure-taxonomy.mjs. DO NOT EDIT.',
  '\\begin{longtable}{p{4.6cm}llp{6.2cm}}', '\\toprule',
  'Task & Loudness & Radius & Basis \\\\', '\\midrule', '\\endhead', '\\label{tab:taxonomy_full}',
  rows, '\\bottomrule', '\\end{longtable}', ''
].join('\n')
const target = (name, content) => { const p = path.join(root, 'paper/generated', name); const serialized = content + '\n'; if (process.argv.includes('--check')) assert.equal(fs.readFileSync(p, 'utf8'), serialized); else fs.writeFileSync(p, serialized) }
target('failure-taxonomy.json', JSON.stringify(output, null, 2))
target('failure-taxonomy-summary.tex', summary)
target('failure-taxonomy-table.tex', full)
console.log(JSON.stringify({ tasks: CODING.length, incident: incident.length, byLoudness, byRadius }))
