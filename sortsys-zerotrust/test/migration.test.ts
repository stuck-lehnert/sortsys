import { expect, test } from "bun:test";
import { base64, bytes, createDomain, createIdentity, LegacyRows, legacyPart, migrationReceiptFrame, migrationStartFrame, publicIdentity, sign, signingPair, verify, verifyDomain } from "../src/sortsys";
import type { LegacyPart, MigrationReceipt } from "../src/sortsys";

const common={tenant:"test",migration:"mig:test",schema:"a".repeat(64),table:"global_settings"};
function part(input:Partial<LegacyPart>={}):LegacyPart {
  const source=JSON.stringify({format:"sortsys-row-v2",schema:common.schema,table:"global_settings",values:{key:"example",name:'{"id":9223372036854775807,"amount":1234567890123.45}'}});
  return legacyPart({format:"sortsys-legacy-part-v1",...common,part:"0",row:"0",byte:"0",nextRow:"1",nextByte:"0",encoding:"rows",data:base64(bytes(JSON.stringify([source]))),...input});
}
test("source archives preserve nested JSON integers and decimals without a parse/stringify round-trip",()=>{
  const archive=new LegacyRows(common);
  const [source]=archive.push(part());
  expect(JSON.parse(source!).values.name).toContain('"id":9223372036854775807');
  expect(JSON.parse(source!).values.name).toContain('"amount":1234567890123.45');
  archive.finish("1");
  expect(()=>archive.finish("2")).toThrow();
  expect(()=>archive.push(part())).toThrow();
});
test("large UTF-8 rows are reassembled across byte boundaries before interpreting text",()=>{
  const source=JSON.stringify({format:"sortsys-row-v2",schema:common.schema,table:common.table,values:{key:"text",name:JSON.stringify("Fensteröffnung äöü ".repeat(120000))}});
  const raw=bytes(source),archive=new LegacyRows(common);
  let result:string[]=[];
  for(let offset=0,index=0;offset<raw.length;offset+=65536,index++) {
    const data=raw.slice(offset,offset+65536),end=offset+data.length,last=end===raw.length;
    result=archive.push({...part(),part:String(index),row:"0",byte:String(offset),nextRow:last?"1":"0",nextByte:last?"0":String(end),encoding:"row-chunk",data:base64(data)});
    if(!last) expect(result).toEqual([]);
  }
  expect(result).toEqual([source]); archive.finish("1");
});
test("archive cursors cannot skip source rows or claim a different scope",()=>{
  expect(()=>legacyPart({...part(),nextRow:"2"})).toThrow();
  expect(()=>new LegacyRows(common).push({...part(),migration:"other"})).toThrow();
  expect(()=>legacyPart({...part(),encoding:"row-chunk",nextRow:"0",nextByte:"9999999"})).toThrow();
  expect(()=>legacyPart({...part(),row:"00"})).toThrow();
});
test("migration receipts bind every technical checkpoint and the exact ciphertext",async()=>{
  const identity=await createIdentity();
  const unsigned:Omit<MigrationReceipt,"proof">={...common,generation:"1",part:"0",row:"0",byte:"0",nextRow:"1",nextByte:"0",object:"source:1",revision:"1",ciphertextHash:base64(new Uint8Array(32)),author:"user:1"};
  const proof=await sign(identity.signingKey.privateKey,migrationReceiptFrame(unsigned));
  await verify(identity.signingKey.publicKey,proof,migrationReceiptFrame(unsigned));
  for(const change of [{nextRow:"2"},{object:"source:other"},{migration:"other"},{schema:"b".repeat(64)}]) {
    await expect(verify(identity.signingKey.publicKey,proof,migrationReceiptFrame({...unsigned,...change}))).rejects.toThrow();
  }
  expect(()=>migrationStartFrame("test","1","invalid","migration:1")).toThrow();
});
test("a valid key package cannot be relabeled as a different permission facet",async()=>{
  const ca=await signingPair(),owner=await createIdentity(),recovery=await createIdentity();
  const {definition}=await createDomain({tenant:"test",id:"domain:1",scope:"project:1",facet:"contract-quantities",generation:"1",policyVersion:"1",authorityGeneration:"1",authorityKey:ca.privateKey,recovery:await publicIdentity(recovery),readers:[{subject:"user:1",identity:await publicIdentity(owner)}]});
  const expected={tenant:"test",id:"domain:1",scope:"project:1",facet:"contract-quantities" as const,generation:"1"};
  expect(await verifyDomain(definition,expected,()=>ca.publicKey)).toEqual(definition);
  await expect(verifyDomain({...definition,facet:"calculation"},{...expected,facet:"calculation"},()=>ca.publicKey)).rejects.toThrow();
  await expect(verifyDomain({...definition,scope:"project:2"},{...expected,scope:"project:2"},()=>ca.publicKey)).rejects.toThrow();
});
