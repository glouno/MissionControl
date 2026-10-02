import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {execFileSync} from "node:child_process";
import {createHash,randomBytes} from "node:crypto";
import {connectorServiceCommand} from "../dist/connectorServices.js";

// Actual Linux user manager proof with a synthetic idle connector. No accounts,
// transport calls, real configuration, production ports or legacy service changes.
process.umask(0o077);
if(process.platform !== "linux") throw Error("This proof requires actual Linux systemd; macOS remains a separate gate");
const evidence=process.argv[2];
if(!evidence) throw Error("Supply a new private evidence file");
const commit=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();
if(execFileSync("git",["status","--porcelain"],{encoding:"utf8"}).trim()) throw Error("Commit the reviewed proof before qualification");
const root=await mkdtemp(join(tmpdir(),"mc-service-proof-")),id="proof-"+randomBytes(8).toString("hex");
const cli=join(root,"synthetic.mjs"),pidFile=join(root,"pid");
await writeFile(cli,`import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)},String(process.pid),{mode:0o600});\nprocess.once('SIGTERM',()=>process.exit(0));\nsetInterval(()=>{},1000);\n`,{mode:0o600});
const config={root,connectors:[{id,kind:"telegram",enabled:true,credential:{kind:"file",path:"unused-synthetic"},bindings:[{enabled:true}]}]};
const options={cli};
let installed=false;
async function waitPid(previous){
 const deadline=Date.now()+15000;
 while(Date.now()<deadline){
  const pid=Number(await readFile(pidFile,"utf8").catch(()=>"0"));
  if(pid && pid!==previous){process.kill(pid,0);return pid;}
  await new Promise(r=>setTimeout(r,50));
 }
 throw Error("Synthetic connector did not start/restart");
}
try {
 const definition=await connectorServiceCommand(config,id,"install",options);installed=true;
 const initial=await connectorServiceCommand(config,id,"status",options);
 if(!initial.status.includes("ActiveState=inactive")) throw Error("Install unexpectedly activated connector");
 execFileSync("systemctl",["--user","start",`mission-control-v1-connector-${id}.service`]);
 const first=await waitPid(0);
 const active=await connectorServiceCommand(config,id,"status",options);
 if(!active.status.includes("ActiveState=active")) throw Error("Synthetic service inactive");
 await connectorServiceCommand(config,id,"restart",options);
 const second=await waitPid(first);
 await connectorServiceCommand(config,id,"stop",options);
 const stopped=await connectorServiceCommand(config,id,"status",options);
 if(!stopped.status.includes("ActiveState=inactive")) throw Error("Synthetic connector failed to stop");
 await connectorServiceCommand(config,id,"uninstall",options);installed=false;
 if((await connectorServiceCommand(config,id,"status",options)).installed) throw Error("Definition remains installed");
 const receipt={schemaVersion:1,passed:true,candidate:commit,platform:process.platform,architecture:process.arch,node:process.version,systemd:execFileSync("systemctl",["--version"],{encoding:"utf8"}).split("\n")[0],implementationSha256:createHash("sha256").update(await readFile(new URL("../dist/connectorServices.js",import.meta.url))).digest("hex"),installationDidNotStart:true,restartReplacedProcess:first!==second,stopAndUninstall:true,realTransportQualified:false,macOSQualified:false,productionServicesChanged:false};
 await writeFile(resolve(evidence),JSON.stringify(receipt,null,2)+"\n",{flag:"wx",mode:0o600});
 process.stdout.write(JSON.stringify({passed:true,productionServicesChanged:false})+"\n");
} finally {
 if(installed){await connectorServiceCommand(config,id,"stop",options);await connectorServiceCommand(config,id,"uninstall",options);}
 await rm(root,{recursive:true,force:true});
}
