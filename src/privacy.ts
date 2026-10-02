/** Instance-scoped redaction. Credential references remain intact; values do not. */
export class Redactor {
 private secrets=new Set<string>();
 register(value:string){if(value.length>=8)this.secrets.add(value)}
 text(value:string){let result=value;for(const secret of [...this.secrets].sort((a,b)=>b.length-a.length))result=result.split(secret).join("[REDACTED]");return result}
 value(value:unknown):unknown{
  if(typeof value === "string")return this.text(value);
  if(Array.isArray(value))return value.map(v=>this.value(v));
  if(value && typeof value === "object")return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,typeof v === "string" && /^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passphrase|client[-_]?secret|private[-_]?key|bearer|token)$/i.test(key)?"[REDACTED]":this.value(v)]));
  return value;
 }
 json(value:unknown){return JSON.stringify(this.value(value))}
}
