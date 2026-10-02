import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url),npmLock=await readFile(new URL('package-lock.json',root)),lock=JSON.parse(npmLock);
const npm=[];
for(const [path,entry]of Object.entries(lock.packages)){
 if(!path||entry.dev)continue;
 const metadata=JSON.parse(await readFile(new URL(`${path}/package.json`,root),'utf8'));
 npm.push({name:metadata.name,version:entry.version,license:metadata.license??'UNRESOLVED',integrity:entry.integrity,source:metadata.repository?.url??metadata.repository??metadata.homepage??'UNRESOLVED'});
}
const metadata=JSON.parse(execFileSync('cargo',['metadata','--locked','--format-version','1','--manifest-path','connectors/matrix/Cargo.toml'],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']}));
const rust=metadata.packages.filter(p=>p.source).map(p=>({name:p.name,version:p.version,license:p.license??'UNRESOLVED',source:p.repository??p.source,checksum:undefined}));
const rustLock=await readFile(new URL('connectors/matrix/Cargo.lock',root));
const unresolved=[...npm,...rust].filter(p=>p.license==='UNRESOLVED');
const report={schemaVersion:1,qualification:'Declared package licenses; redistribution notices and corresponding-source review still required',lockfiles:{npmSha256:createHash('sha256').update(npmLock).digest('hex'),rustSha256:createHash('sha256').update(rustLock).digest('hex')},npm:npm.sort((a,b)=>a.name.localeCompare(b.name)),rust:rust.sort((a,b)=>a.name.localeCompare(b.name)),redistributedVendorBinaries:[],images:[],unresolved};
await writeFile(new URL('docs/dependencies.json',root),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({npm:npm.length,rust:rust.length,unresolved:unresolved.length,redistributionReviewComplete:false}));
