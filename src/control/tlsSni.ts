/** Parse only a bounded, unfragmented TLS ClientHello; unknown forms fail closed. */
export function clientHelloServerName(bytes:Buffer):{complete:false}|{complete:true;host:string}{
 if(bytes.length<5)return {complete:false};
 if(bytes[0]!==22||bytes[1]!==3)throw new Error("Egress requires TLS ClientHello");
 const length=bytes.readUInt16BE(3);if(length>16384||length<4)throw new Error("TLS handshake exceeds limit");
 if(bytes.length<length+5)return {complete:false};
 const record=bytes.subarray(5,5+length);if(record[0]!==1)throw new Error("Egress requires initial ClientHello");
 const declared=record.readUIntBE(1,3);if(declared!==record.length-4)throw new Error("Fragmented or invalid ClientHello is unsupported");
 let offset=4+2+32;
 const take=(count:number)=>{if(count<0||offset+count>record.length)throw new Error("Truncated TLS ClientHello");const result=record.subarray(offset,offset+count);offset+=count;return result};
 const u8=()=>take(1)[0],u16=()=>take(2).readUInt16BE();
 take(u8());take(u16());take(u8());const extensions=u16();if(offset+extensions!==record.length)throw new Error("Invalid TLS extensions");
 let serverName:string|undefined;
 while(offset<record.length){const type=u16(),size=u16(),content=take(size);
  if(type===0){
   if(serverName||content.length<5||content.readUInt16BE()!==content.length-2)throw new Error("Invalid TLS server name extension");
   if(content[2]!==0||content.readUInt16BE(3)!==content.length-5)throw new Error("TLS requires one DNS server name");
   serverName=content.subarray(5).toString("ascii");if(!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(serverName))throw new Error("Invalid TLS DNS name");
  }
  if(type===0xfe0d)throw new Error("Encrypted client hello is unsupported by egress policy");
 }
 if(!serverName)throw new Error("TLS server name is required");
 return {complete:true,host:serverName};
}
