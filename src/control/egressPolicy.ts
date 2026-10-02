import {lookup} from "node:dns/promises";
import {isIP} from "node:net";
import {z} from "zod";
export const egressPolicySchema=z.object({hosts:z.array(z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)).min(1).max(40),maxConnections:z.number().int().min(1).max(16).default(8),maxBytes:z.number().int().min(1024).max(1024**3).default(128*1024**2),timeoutMs:z.number().int().min(1000).max(3600000).default(600000)}).strict();
export type EgressPolicy=z.output<typeof egressPolicySchema>;
/** Conservative public IPv4 only. IPv6 is denied until independently qualified. */
export function publicIPv4(address:string){
 if(isIP(address)!==4)return false;
 const [a,b,c]=address.split(".").map(Number);
 if(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19))return false;
 if(a===192&&b===0||a===192&&b===88&&c===99||a===198&&b===51&&c===100||a===203&&b===0&&c===113)return false;
 return true;
}
export async function resolveEgress(policy:EgressPolicy,host:string,port:number,resolver:typeof lookup=lookup){
 if(port!==443||!policy.hosts.includes(host)||isIP(host))throw new Error("Egress destination is not authorized");
 const addresses=await resolver(host,{all:true,verbatim:true,family:4});
 if(!addresses.length||addresses.some(a=>a.family!==4||!publicIPv4(a.address)))throw new Error("Egress DNS returned a private or unsupported address");
 return addresses[0].address; // Connect to this pinned result, never resolve again.
}
