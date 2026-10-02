// Real Docker gateway proof with a caller-selected immutable, reviewed image.
// Never uses provider credentials, production state or global Docker cleanup.
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { SqliteStore } from "../dist/sqlite.js";
import { InferenceGateway } from "../dist/control/inferenceGateway.js";
import { StdioGateway } from "../dist/control/stdioGateway.js";
import { GatewayNetworkManager } from "../dist/control/gatewayNetwork.js";
const exec=promisify(execFile);
const image=(await readFile(process.argv[2],"utf8")).trim();
if(!/^sha256:[a-f0-9]{64}$/.test(image))throw new Error("Supply a file containing the immutable reviewed image digest");
const root=await mkdtemp(join(tmpdir(),"mc-gateway-proof-")),sessionId=`proof_${randomUUID().replaceAll("-","")}`,worker=`mc-probe-${sessionId}`;
const db=new SqliteStore(join(root,"proof.db"));let requests=0;
const gateway=new InferenceGateway(db,{fake:{protocol:"responses",endpoint:"https://example.invalid/v1",headers:async()=>({})}},()=>{},async()=>{requests++;return new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',{headers:{"content-type":"text/event-stream"}})});
const server=gateway.server();server.listen(0,"127.0.0.1");await once(server,"listening");
const bridge=new StdioGateway(gateway,`http://127.0.0.1:${server.address().port}`),networks=new GatewayNetworkManager(db,id=>gateway.revoke(id),undefined,bridge);
let record;
try{
 record=await networks.acquire({sessionId,generation:1,imageDigest:image,socketDirectory:join(root,"unused"),relayScript:new URL("../environments/worker/gateway-relay.py",import.meta.url).pathname});
 const token=gateway.issue({sessionId,goalId:"synthetic",taskId:"synthetic",generation:1,provider:"fake",protocol:"responses",model:"fake",expiresAt:Date.now()+30000});
 const python=`import json,socket,urllib.request,time\nfor i in range(30):\n try:\n  req=urllib.request.Request('http://inference-gateway:8080/v1/responses',data=json.dumps({'model':'fake','input':'synthetic','stream':True}).encode(),headers={'Authorization':'Bearer '+${JSON.stringify(token)},'Content-Type':'application/json'})\n  body=urllib.request.urlopen(req,timeout=3).read().decode();assert 'response.completed' in body;break\n except (ConnectionError,urllib.error.URLError):time.sleep(.1)\nelse:raise Exception('relay unavailable')\nfor host in ['169.254.169.254','127.0.0.1','10.0.0.1','192.168.1.1','172.17.0.1']:\n try:\n  connection=socket.create_connection((host,43190 if host=='127.0.0.1' else 80),timeout=.3);connection.close();raise Exception('private network reachable')\n except OSError:pass\nprint(json.dumps({'inference':True,'privateNetworkDenied':True}))`;
 await exec("docker",["create","--name",worker,"--label",`missioncontrol.proof=${sessionId}`,"--network",record.network,"--cap-drop","ALL","--security-opt","no-new-privileges","--read-only","--pids-limit","32","--memory","128m","--entrypoint","python3",image,"-c",python],{timeout:15000});
 await exec("docker",["start","-a",worker],{timeout:20000});const inspected=JSON.parse((await exec("docker",["inspect",worker])).stdout)[0];assert.equal(inspected.State.ExitCode,0);assert.equal(requests,1);
 const relay=JSON.parse((await exec("docker",["inspect",record.relay])).stdout)[0];assert.deepEqual(relay.Mounts,[]);assert.equal(relay.HostConfig.NetworkMode,record.network);
 console.log(JSON.stringify({passed:true,platform:process.platform,docker:(await exec("docker",["version","--format","{{.Server.Version}}"])).stdout.trim(),inference:true,privateNetworkDenied:true,relayMounts:0,macOSQualified:process.platform==="darwin"},null,2));
}finally{
 await exec("docker",["rm","-f",worker]).catch(()=>{});
 if(record)await networks.stop(sessionId);
 await new Promise(r=>server.close(r));db.close();await rm(root,{recursive:true,force:true});
}
