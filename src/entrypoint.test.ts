import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {pathToFileURL} from "node:url";
import {isEntrypoint} from "./entrypoint.js";
test("CLI executes through an installed release symlink",async()=>{
 const root=await mkdtemp(join(tmpdir(),"mc-entry-"));
 const release=join(root,"release");await mkdir(release);await symlink(join(process.cwd(),"dist"),join(release,"dist"));await symlink(release,join(root,"current"));
 const result=await promisify(execFile)(process.execPath,[join(root,"current/dist/cli.js"),"--help"],{env:{...process.env,MISSIONCONTROL_STATE_DIR:join(root,"state")}});
 assert.match(result.stdout,/mission-control/);
});
test("entrypoint identity compares real paths and rejects imports",async()=>{
 const root=await mkdtemp(join(tmpdir(),"mc-entry-id-"));const file=join(root,"file.js"),other=join(root,"other.js");
 await writeFile(file,"");await writeFile(other,"");await symlink(file,join(root,"link.js"));
 assert.equal(isEntrypoint(pathToFileURL(file).href,join(root,"link.js")),true);
 assert.equal(isEntrypoint(pathToFileURL(file).href,other),false);
});
