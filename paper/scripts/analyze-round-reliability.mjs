// Cross-round scoring stability for the GLM-5.2 and GLM-5.3 three-round supplements.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
const root=fileURLToPath(new URL('../..',import.meta.url))
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8').replace(/^\uFEFF/,''))
const GROUPS={glm52:['2026-09-13-glm-5.2-s1-s22','2026-09-13-glm-5.2-s1-s22-round2','2026-09-13-glm-5.2-s1-s22-round3'],glm53:['2026-09-15-glm-5.3-s1-s22','2026-09-16-glm-5.3-s1-s22-r2','2026-09-17-glm-5.3-s1-s22-r3']}
const median=a=>{const s=[...a].sort((x,y)=>x-y);const m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2}
const output={groups:{}}
for(const [name,dirs] of Object.entries(GROUPS)){
 const rounds=dirs.map(d=>read(`benchmark/results/artifacts/${d}/aggregate.json`))
 for(const r of rounds){assert.equal(r.length,22)}
 const tasks=rounds[0].map(r=>r.task)
 const perArm={}
 for(const arm of ['noskill','skill']){
  const spreads=tasks.map(t=>({task:t,values:rounds.map(r=>r.find(x=>x.task===t)[arm])}))
  const spreadOf=s=>Math.max(...s.values)-Math.min(...s.values)
  let pairs=0,same=0
  for(const s of spreads){for(let i=0;i<3;i++)for(let j=i+1;j<3;j++){pairs++;if(s.values[i]===s.values[j])same++}}
  perArm[arm]={exactThreeRounds:spreads.filter(s=>spreadOf(s)===0).length,medianSpread:median(spreads.map(spreadOf)),meanSpread:spreads.reduce((a,s)=>a+spreadOf(s),0)/tasks.length,pairwiseIdentical:[same,pairs],meanSpreadExcludingS17:spreads.filter(s=>!s.task.startsWith('S17-')).reduce((a,s)=>a+spreadOf(s),0)/(tasks.length-1),widestTasks:spreads.map(s=>({task:s.task,spread:spreadOf(s),values:s.values})).sort((a,b)=>b.spread-a.spread).slice(0,4)}
 }
 const deltas=rounds.map(r=>(r.reduce((s,x)=>s+x.skill,0)-r.reduce((s,x)=>s+x.noskill,0))/22)
 output.groups[name]={rounds:dirs,roundDeltas:deltas,effectDirectionConsistent:deltas.every(d=>d>0),perArm}
}
output.interpretation='Descriptive round-to-round stability of archived scores; not a designed reliability study and no significance test was run. Rounds differ in judge and protocol details (see the supplement sections), so agreement reflects run-plus-judge stability combined. For GLM-5.3 the arms tie on median spread (0 vs 0) and exact three-round agreement (14/22 each); the mean-spread gap is driven mostly by the S17 no-skill swing (round-three contradiction cap and judge change). With-skill scores are near the ceiling, so a smaller spread there is partly mechanical; no arm is claimed to be more stable.'
const target=path.join(root,'paper/generated/round-reliability.json'),serialized=JSON.stringify(output,null,2)+'\n'
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),serialized);else fs.writeFileSync(target,serialized)
console.log(JSON.stringify(output.groups,null,1))
