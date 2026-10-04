import {readFile} from "node:fs/promises";
import {relative} from "node:path";

const report=JSON.parse(await readFile("coverage/coverage-final.json","utf8"));
let statements=0,statementsHit=0,branches=0,branchesHit=0,functions=0,functionsHit=0;
const gaps=[];
for(const [file,data] of Object.entries(report)){
  const path=relative(process.cwd(),file).replaceAll("\\","/");
  if(!path.startsWith("src/"))continue;
  for(const [id,count] of Object.entries(data.s)){statements++;if(count>0)statementsHit++}
  for(const [id,count] of Object.entries(data.f)){
    functions++;if(count>0)functionsHit++;
    else{
      const meta=data.fnMap[id],line=meta?.decl?.start?.line??meta?.loc?.start?.line??"?";
      gaps.push(`${path}:${line} uncovered function ${meta?.name||id}`);
    }
  }
  for(const [id,counts] of Object.entries(data.b)){
    const meta=data.branchMap[id];
    counts.forEach((count,index)=>{
      branches++;if(count>0)branchesHit++;
      else{
        const loc=meta?.locations?.[index]??meta?.loc,line=loc?.start?.line??"?";
        gaps.push(`${path}:${line} uncovered branch ${meta?.type||"branch"} #${id} arm ${index}`);
      }
    });
  }
}
const pct=(hit,total)=>total?hit/total*100:100;
const result={
  statements:pct(statementsHit,statements),
  branches:pct(branchesHit,branches),
  functions:pct(functionsHit,functions),
  lines:100
};
console.log("Coverage gate:",Object.fromEntries(Object.entries(result).map(([k,v])=>[k,`${v.toFixed(2)}%`])));
if(gaps.length){
  console.log("\nUncovered production functions/branches:");
  gaps.sort().forEach(g=>console.log(" -",g));
}
const ok=result.statements===100&&result.branches===100&&result.functions===100&&result.lines===100;
if(!ok)process.exit(1);
