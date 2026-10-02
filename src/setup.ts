import {mkdir,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import type {LoadedConfiguration} from "./config.js";
const exec=promisify(execFile);
export async function createSyntheticProject(config:LoadedConfiguration){
 const repo=join(config.settings.stateDir,"examples","repository");await mkdir(repo,{recursive:true,mode:0o700});
 await exec("git",["init","-b","main"],{cwd:repo,env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"}});
 await writeFile(join(repo,"README.md"),"Synthetic installation fixture for MissionControl.\n",{flag:"wx",mode:0o600});
 await exec("git",["add","README.md"],{cwd:repo});
 await exec("git",["-c","user.name=Example","-c","user.email=example@example.invalid","commit","-m","Synthetic installation fixture"],{cwd:repo});
 const project={id:"synthetic",name:"Synthetic installation",family:"Examples",enabled:true,executionMode:"fake",profile:"builtin.synthetic",config:{repoPath:repo,repository:{mode:"local",branch:"main"},policy:{targetBranch:"main"},verificationCommands:["test -f implement.txt"]}};
 await mkdir(join(config.root,"projects"),{recursive:true,mode:0o700});
 await writeFile(join(config.root,"projects/synthetic.json"),JSON.stringify(project,null,2)+"\n",{flag:"wx",mode:0o600});
 await writeFile(join(config.root,"synthetic-goal.txt"),"Create the synthetic artifact and pass the installation checks.\n",{flag:"wx",mode:0o600});
 await writeFile(join(config.root,"config.json"),JSON.stringify({...config.settings,files:{...config.settings.files,projects:[...config.settings.files.projects,"projects/synthetic.json"]}},null,2)+"\n",{mode:0o600});
 return {projectId:project.id,goalFile:join(config.root,"synthetic-goal.txt")};
}
