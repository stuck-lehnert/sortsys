import type { Client, QueryResult } from "@sortsys/v2-client";
import {
  ACTIONS, allows, areaKey, base64, bytes, createDomain, decryptObject, digest, encryptedObject, encryptObject,
  InvalidProtectedData, legacyPart, migrationReceiptFrame, migrationStartFrame,
  objectFrame, openBox, policy, policyFrame, publicIdentity, randomSecret, record, sign, signPolicy,
  signedPacketFrame, verify, verifyDomain,
} from "@sortsys/zerotrust";
import type { LegacyPart, MigrationReceipt, Policy } from "@sortsys/zerotrust";
import { businessSchemaFingerprint } from "../data/database";
import { openAuthority } from "./setup";
import { trustedHistory, unlockedAccount } from "./session";

export type MigrationStatus = NonNullable<QueryResult<"zerotrust.migration.status">>;
export type MigrationProgress = { done: bigint; total: bigint; phase: "copying" | "copied" };

async function required<T>(promise: Promise<[T | null, Error | null]>): Promise<T> {
  const [result,error] = await promise;
  if (error) throw error;
  if (result === null) throw new InvalidProtectedData();
  return result;
}
async function signedPolicy(client:Client,tenant:string,key:CryptoKey):Promise<Policy> {
  const value=record(await required(client.query("zerotrust.policy.get",undefined,{strategy:"network-only"})),["tenant","version","rules","signature"]);
  if(typeof value.signature!=="string") throw new InvalidProtectedData();
  const {signature,...unsigned}=value;
  const checked=policy(unsigned);
  if(checked.tenant!==tenant) throw new InvalidProtectedData();
  await verify(key,signature,policyFrame(checked)); return checked;
}

/** This prepares a durable encrypted source archive. It deliberately does not
 * erase the old database or activate the tenant before all feature paths move. */
export async function archiveLegacyData(client:Client,subject:string,onProgress:(value:MigrationProgress)=>void,signal:AbortSignal):Promise<MigrationStatus> {
  const account=unlockedAccount();
  if(!account) throw new InvalidProtectedData();
  const live=()=>{ if(signal.aborted || unlockedAccount()!==account) throw new InvalidProtectedData(); };
  const status=await required(client.query("zerotrust.status",undefined,{strategy:"network-only"})); live();
  if(status.tenant!==account.tenant || status.phase!=="enrolling" || !status.profile) throw new InvalidProtectedData();
  const history=await trustedHistory(client); live();
  const authority=await openAuthority(client,status.profile); live();
  const root=history.current;
  let [migration,error]=await client.query("zerotrust.migration.status",undefined,{strategy:"network-only"});
  if(error) throw error;
  if(!migration) {
    const id=`mig_${base64(randomSecret())}`;
    const proof=await sign(account.identity.signingKey.privateKey,migrationStartFrame(account.tenant,root.generation,businessSchemaFingerprint,id));
    const [,beginError]=await client.mutate("zerotrust.migration.begin",{id,schema:businessSchemaFingerprint,generation:root.generation,proof});
    [migration,error]=await client.query("zerotrust.migration.status",undefined,{strategy:"network-only"});
    if(error) throw error;
    if(!migration) throw beginError ?? new InvalidProtectedData();
  }
  live();
  if(migration.schema!==businessSchemaFingerprint) throw new InvalidProtectedData();
  const scope=`migration:${migration.id}`,domainId=`archive:${migration.id}`;
  let permissions=await signedPolicy(client,account.tenant,history.authority(root.generation)); live();
  const canRead=()=>ACTIONS.every(action=>allows(permissions,{tenant:account.tenant,version:permissions.version,subjects:[subject],scope,facet:"attachment",action}));
  if(!canRead()) {
    const next=await signPolicy({tenant:account.tenant,version:(BigInt(permissions.version)+1n).toString(),rules:[...permissions.rules,{subject,scope,facet:"attachment",actions:[...ACTIONS],effect:"allow"}]},authority);
    const [,failure]=await client.mutate("zerotrust.policy.replace",next);
    permissions=await signedPolicy(client,account.tenant,history.authority(root.generation));
    if(!canRead()) throw failure ?? new InvalidProtectedData();
  }
  const domains=await required(client.query("zerotrust.domains.list",undefined,{strategy:"network-only"})); live();
  let domain=domains.find(value=>value.id===domainId);
  if(!domain) {
    const made=await createDomain({tenant:account.tenant,id:domainId,scope,facet:"attachment",generation:"1",policyVersion:permissions.version,authorityGeneration:root.generation,authorityKey:authority,
      recovery:{encryptionKey:root.recoveryEncryptionKey,signingKey:root.recoverySigningKey},readers:[{subject,identity:await publicIdentity(account.identity)}]});
    const [,failure]=await client.mutate("zerotrust.domains.put",made.definition);
    const current=await required(client.query("zerotrust.domains.list",undefined,{strategy:"network-only"}));
    domain=current.find(value=>value.id===domainId);
    if(!domain) throw failure ?? new InvalidProtectedData();
  }
  if(domain.rotationRequired) throw new InvalidProtectedData();
  const definition=await required(client.query("zerotrust.domains.get",{domain:domainId,generation:domain.generation},{strategy:"network-only"}));
  await verifyDomain(definition,{tenant:account.tenant,id:domainId,scope,facet:"attachment",generation:domain.generation},history.authority);
  const box=await required(client.query("zerotrust.keys.get",{domain:domainId,generation:domain.generation},{strategy:"network-only"}));
  const authorGeneration=box.author.match(/^authority:([1-9]\d*)$/)?.[1];
  if(!authorGeneration) throw new InvalidProtectedData();
  const raw=await openBox(box,{tenant:account.tenant,purpose:"area-key",object:domainId,generation:domain.generation,recipient:subject,author:box.author},account.identity.encryptionKey.privateKey,history.authority(authorGeneration));
  let key:CryptoKey;
  try {key=await areaKey(raw);} finally {raw.fill(0);}
  live();
  const total=migration.tables.reduce((sum,t)=>sum+BigInt(t.rows),0n);
  let done=migration.tables.reduce((sum,t)=>sum+BigInt(t.row),0n);
  onProgress({done,total,phase:"copying"});
  for(const table of migration.tables) {
    let row=table.row,byte=table.byte,part=table.parts;
    while(BigInt(row)<BigInt(table.rows)) {
      live();
      const source=await required(client.query("zerotrust.migration.read",{id:migration.id,table:table.table,row,byte},{strategy:"network-only"})); live();
      const payload:LegacyPart=legacyPart({format:"sortsys-legacy-part-v1",tenant:account.tenant,migration:migration.id,schema:businessSchemaFingerprint,table:table.table,part,row,byte,nextRow:source.nextRow,nextByte:source.nextByte,encoding:source.encoding,data:source.data});
      const plaintext=bytes(JSON.stringify(payload));
      const context={tenant:account.tenant,scope,facet:"attachment" as const,object:`src_${base64(randomSecret())}`,revision:"1",generation:domain.generation,policyVersion:permissions.version,author:subject};
      try {
        const envelope=await encryptObject(context,plaintext,key,account.identity.signingKey.privateKey); live();
        const [,saveError]=await client.mutate("zerotrust.objects.save",{domain:domainId,messageId:`msg_${base64(randomSecret())}`,envelope}); live();
        const [saved,readError]=await client.query("zerotrust.objects.get",{id:context.object},{strategy:"network-only"});
        if(readError) throw readError;
        if(!saved) throw saveError ?? new InvalidProtectedData();
        const checked=encryptedObject(saved);
        const opened=await decryptObject(checked,context,key,account.identity.signingKey.publicKey);
        try { if(await digest(opened)!==await digest(plaintext)) throw new InvalidProtectedData(); } finally {opened.fill(0);}
        live();
        const unsigned:Omit<MigrationReceipt,"proof">={tenant:account.tenant,migration:migration.id,schema:businessSchemaFingerprint,generation:root.generation,table:table.table,part,row,byte,nextRow:source.nextRow,nextByte:source.nextByte,object:context.object,revision:context.revision,ciphertextHash:await digest(signedPacketFrame(objectFrame(checked),checked.signature)),author:subject};
        const receipt:MigrationReceipt={...unsigned,proof:await sign(account.identity.signingKey.privateKey,migrationReceiptFrame(unsigned))};
        await required(client.mutate("zerotrust.migration.stage",receipt));
      } finally {plaintext.fill(0);}
      done+=BigInt(source.nextRow)-BigInt(row);
      row=source.nextRow;byte=source.nextByte;part=(BigInt(part)+1n).toString();
      onProgress({done,total,phase:"copying"});
    }
  }
  const completed=await required(client.query("zerotrust.migration.status",undefined,{strategy:"network-only"})); live();
  if(completed.phase!=="copied") throw new InvalidProtectedData();
  onProgress({done:total,total,phase:"copied"});
  return completed;
}
