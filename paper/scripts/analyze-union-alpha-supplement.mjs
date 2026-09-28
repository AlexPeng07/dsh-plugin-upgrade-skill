// Recompute the union-alpha supplementary round from frozen rubrics and original verdicts.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../../benchmark/report-judge/judge.mjs'
import { pairedBootstrap, wilcoxonSignedRank } from '../../benchmark/scripts/measure-paired-effect.mjs'
const root=fileURLToPath(new URL('../..',import.meta.url))
const git=p=>execFileSync('git',['show',`e0a9ff5:${p}`],{cwd:root,encoding:'utf8'})
const source=git('benchmark/report-judge/judge.mjs')
const {scoreDecisions}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8').replace(/^\uFEFF/,''))
const base='benchmark/results/artifacts/2026-09-17-union-alpha-s1-s22-r1'
const EXPOSED=['S1-static-scan','S2-negative-scan','S3-snapshot-migration','S8-release-routing-trap','S17-external-ui-plugin-onboarding-trap','S20-msvc-flock-trap']
const rows=read(base+'/aggregate.json')
assert.equal(rows.length,22);assert.equal(new Set(rows.map(r=>r.task)).size,22)
const checked=[]
for(const row of rows){const packet=JSON.parse(git(`benchmark/tasks/${row.task}/tests/packet.json`));const output={task:row.task}
 for(const arm of ['noskill','skill']){
  const report=fs.readFileSync(path.join(root,`${base}/${arm}/${row.task}/report.md`),'utf8')
  const verdict=read(`${base}/judge/${arm}/${row.task}.verdict.json`)
  const scored=scoreDecisions(packet,{'report.md':report},verdict)
  assert.equal(scored.score,row[arm],`${row.task} ${arm}`)
  output[arm]=scored.score;output[arm+'ReportSha256']=sha256(report)
  output[arm+'VerdictSha256']=sha256(fs.readFileSync(path.join(root,`${base}/judge/${arm}/${row.task}.verdict.json`),'utf8'))
 }checked.push(output)}
const summarize=subset=>{const deltas=subset.map(r=>r.skill-r.noskill)
 const totals=Object.fromEntries(['noskill','skill'].map(a=>[a,subset.reduce((s,r)=>s+r[a],0)]))
 return {tasks:subset.length,totals,meanDelta:(totals.skill-totals.noskill)/subset.length,nonZeroTasks:deltas.filter(d=>d!==0).length,seed:20260907,bootstrap:pairedBootstrap(deltas),wilcoxon:wilcoxonSignedRank(deltas),rows:subset}}
const manifest=read(base+'/run-manifest.json')
const output={rubricCommit:'e0a9ff5',scorerSha256:sha256(source),checkedAnswers:44,model:manifest.model,modelNotes:manifest.model_notes,judge:'GLM-5.3-Flash (44/44 verdicts, canonical judge)',exposedTasks:EXPOSED,full:summarize(checked),cleanExcludingExposed:summarize(checked.filter(r=>!EXPOSED.includes(r.task))),interpretation:'Single-round descriptive supplement on an anonymous beta model; the paired interval includes zero and nonzero differences concentrate in two tasks (ceiling effects). No cross-model comparison is implied.'}
const target=path.join(root,'paper/generated/union-alpha-supplement.json'),serialized=JSON.stringify(output,null,2)+'\n'
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),serialized);else fs.writeFileSync(target,serialized)
console.log(JSON.stringify({full:output.full.meanDelta,fullCi:output.full.bootstrap.ci95,fullNonZero:output.full.nonZeroTasks,clean:output.cleanExcludingExposed.meanDelta,cleanCi:output.cleanExcludingExposed.bootstrap.ci95,cleanNonZero:output.cleanExcludingExposed.nonZeroTasks},null,2))
