import type { RunContext } from "./backend.js";
import type { ExecutionEnvironment } from "./environments.js";
import type { ToolCall, ModelProvider } from "./providers.js";
import { PortableBackend } from "./backends.js";
// Trusted tool implementation executes only against the invocation's private
// container source. The controller's tool loop never reads/writes worker paths.
const tools = `import os,json,sys,pathlib,fnmatch,subprocess,selectors,time
p=json.loads(sys.argv[1]);a=p['arguments'];base=pathlib.Path('/workspace')
def scoped(name,write=False):
 path=base/name
 rel=path.relative_to(base) if path.is_relative_to(base) else None
 if rel is None or '..' in rel.parts or '.git' in rel.parts:raise ValueError('Path outside workspace')
 canonical=path.resolve()
 if not canonical.is_relative_to(base):raise ValueError('Symlink outside workspace')
 if write and (p['mode']!='implement' or not rel.parts):raise ValueError('Read-only run')
 if write and not any(fnmatch.fnmatch(str(rel),pattern) for pattern in p['allowedPaths']):raise ValueError('Path outside task scope')
 return path
try:
 name=p['name']
 if name=='read_file':
  with scoped(a['path']).open('r') as f:result=f.read(100000)
 elif name=='list_files':result=json.dumps(sorted(x.name for x in scoped(a['path']).iterdir())[:10000])
 elif name=='write_file':
  path=scoped(a['path'],True);content=a['content']
  if not isinstance(content,str) or len(content)>1000000:raise ValueError('File content exceeds bound')
  path.parent.mkdir(parents=True,exist_ok=True);path.write_text(content);result='Written'
 elif name=='shell':
  command=a['command']
  if not isinstance(command,str) or len(command)>10000:raise ValueError('Command exceeds bound')
  child=subprocess.Popen(command,shell=True,executable='/bin/sh',stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
  selector=selectors.DefaultSelector();selector.register(child.stdout,selectors.EVENT_READ);data=b'';end=time.monotonic()+p['timeoutMs']/1000
  while selector.get_map():
   if time.monotonic()>end:raise ValueError('Command time limit')
   for key,_ in selector.select(.1):
    chunk=os.read(key.fileobj.fileno(),8192)
    if not chunk:selector.unregister(key.fileobj);continue
    data+=chunk
    if len(data)>1000000:raise ValueError('Command output limit')
  result=json.dumps({'exitCode':child.wait(timeout=1),'output':data[-100000:].decode('utf8','replace')})
 else:raise ValueError('Unknown tool')
 print(json.dumps({'result':result}))
except Exception as e:print(json.dumps({'error':str(e)}))
finally:
 if 'child' in locals() and child.poll() is None:
  import signal
  os.killpg(child.pid,signal.SIGKILL);child.wait()
`;
export class IsolatedPortableTools extends PortableBackend {
  constructor(
    provider: ModelProvider,
    readonly environment: ExecutionEnvironment,
    readonly sessionId: string,
    readonly assertAuthority: () => void,
  ) {
    super(provider);
  }
  override async tool(context: RunContext, call: ToolCall): Promise<string> {
    context.signal.throwIfAborted();
    this.assertAuthority();
    if (call.name === "checkpoint") {
      await context.onCheckpoint(String(call.arguments.summary));
      return "Checkpoint saved";
    }
    const payload = {
      name: call.name,
      arguments: call.arguments,
      mode: context.mode,
      allowedPaths: context.claim.task.spec.allowedPaths,
      timeoutMs: context.claim.goal.config.timeoutMs,
    };
    const output = await this.environment.execute(
      this.sessionId,
      ["python3", "-c", tools, JSON.stringify(payload)],
      context.signal,
    );
    this.assertAuthority();
    const result = JSON.parse(output.stdout);
    if (typeof result.result === "string") return result.result;
    if (typeof result.error === "string")
      return JSON.stringify({ error: result.error });
    throw new Error("Invalid isolated tool result");
  }
}
