import test from "node:test";
import assert from "node:assert/strict";
import {egressPolicySchema,publicIPv4,resolveEgress} from "./egressPolicy.js";
test("subscription egress denies private networks, literals, ports, wildcards and DNS rebinding",async()=>{
 const policy=egressPolicySchema.parse({hosts:["provider.example"]});
 for(const address of ["0.0.0.0","10.1.2.3","127.0.0.1","169.254.169.254","172.17.0.1","192.168.1.1","100.100.100.100","198.18.0.1","224.0.0.1","::1","::ffff:127.0.0.1"])assert.equal(publicIPv4(address),false,address);
 assert.equal(publicIPv4("8.8.8.8"),true);
 let lookups=0;const publicLookup:any=async()=>{lookups++;return [{address:"8.8.8.8",family:4}]};
 assert.equal(await resolveEgress(policy,"provider.example",443,publicLookup),"8.8.8.8");assert.equal(lookups,1);
 for(const [host,port]of [["other.example",443],["provider.example",80],["127.0.0.1",443]] as const)await assert.rejects(resolveEgress(policy,host,port,publicLookup),/not authorized/);
 await assert.rejects(resolveEgress(policy,"provider.example",443,(async()=>[{address:"8.8.8.8",family:4},{address:"127.0.0.1",family:4}]) as any),/DNS/);
 assert.throws(()=>egressPolicySchema.parse({hosts:["*.example"]}));
});

test("TLS egress requires a bounded exact DNS SNI and rejects malformed handshakes",async()=>{
 const {clientHelloServerName}=await import("./tlsSni.js");
 const host=Buffer.from("provider.example"),name=Buffer.concat([Buffer.from([0,0,host.length]),host]),list=Buffer.alloc(2);list.writeUInt16BE(name.length);
 const extension=Buffer.concat([list,name]),extensionHeader=Buffer.alloc(4);extensionHeader.writeUInt16BE(0);extensionHeader.writeUInt16BE(extension.length,2);
 const extensions=Buffer.concat([extensionHeader,extension]),extensionsSize=Buffer.alloc(2);extensionsSize.writeUInt16BE(extensions.length);
 const hello=Buffer.concat([Buffer.from([3,3]),Buffer.alloc(32),Buffer.from([0,0,2,0x13,1,1,0]),extensionsSize,extensions]),handshake=Buffer.alloc(4);handshake[0]=1;handshake.writeUIntBE(hello.length,1,3);
 const record=Buffer.concat([handshake,hello]),header=Buffer.from([22,3,3,0,0]);header.writeUInt16BE(record.length,3);const bytes=Buffer.concat([header,record]);
 assert.deepEqual(clientHelloServerName(bytes),{complete:true,host:"provider.example"});assert.deepEqual(clientHelloServerName(bytes.subarray(0,10)),{complete:false});
 assert.throws(()=>clientHelloServerName(Buffer.from("GET / HTTP/1.1")),/TLS/);
 const malformed=Buffer.from(bytes);malformed[5]=2;assert.throws(()=>clientHelloServerName(malformed),/ClientHello/);
});
