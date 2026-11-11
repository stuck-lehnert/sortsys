import { expect, test } from "bun:test";
import { deliveryChanges } from "./deliveryChanges";
import { deliveryRequestFingerprint, deliveryAllocation, checkDeliveryObjects } from "./deliveryRegistry";
import { base64 } from "@sortsys/zerotrust";
import { businessSchema } from "./schema";

test("delivery creation normalizes only allowed values before any request",()=>{
  const input={projectId:"2",comment:" Baustelle ",effectiveTimestamp:new Date("2026-11-11T11:22:33Z"),records:[{productId:"3",quantity:2.375,unit:" m ",comment:" Lager "}],specialRecords:[{name:" Anlieferung ",unit:" pauschal ",amount:1.125,pricePerUnit:23.4567}]};
  const value=deliveryChanges(input,true);expect(value.comment).toBe("Baustelle");expect(value.effectiveTimestamp).toBe("2026-11-11T11:22:33.000Z");
  expect(value.records[0]).toMatchObject({productId:"3",quantity:2.375,unit:"m",comment:"Lager"});expect(value.specialRecords[0].pricePerUnit).toBe(23.4567);
  for(const change of [{...input,extra:true},{...input,projectId:"02"},{...input,effectiveTimestamp:"2026-11-11"},{...input,records:[{...input.records[0],id:"4"}]},
    {...input,records:[{...input.records[0],quantity:NaN}]},{...input,specialRecords:[{...input.specialRecords[0],pricePerUnit:Infinity}]},{projectId:"2",records:[],specialRecords:[]}])expect(()=>deliveryChanges(change,true)).toThrow();
});
test("omitted special prices and comments remain absent and stable identifiers cannot be duplicated",()=>{
  const value=deliveryChanges({specialRecords:[{id:"5",name:"Transport",unit:"Stk",amount:2}]},false);
  expect(value.specialRecords[0].id).toBe("5");expect(Object.hasOwn(value.specialRecords[0],"pricePerUnit")).toBe(false);expect(Object.hasOwn(value.specialRecords[0],"comment")).toBe(false);
  expect(deliveryChanges({specialRecords:[{...value.specialRecords[0],pricePerUnit:null}]},false).specialRecords[0].pricePerUnit).toBeNull();
  expect(()=>deliveryChanges({specialRecords:[...value.specialRecords,...value.specialRecords]},false)).toThrow();
  expect(()=>deliveryChanges({effectiveTimestamp:null},false)).toThrow();expect(()=>deliveryChanges({},false)).toThrow();
  expect(deliveryChanges({records:null,specialRecords:[]},false)).toEqual({records:[],specialRecords:[]});
  expect(deliveryChanges({records:[],comment:undefined},false)).toEqual({records:[]});
});
test("creation receipts use a private purpose-bound fingerprint, not a public price hash",async()=>{
  const a=base64(crypto.getRandomValues(new Uint8Array(64))),b=base64(crypto.getRandomValues(new Uint8Array(64))),input={requestId:"operation_0123456789",price:98765.4321};
  const first=await deliveryRequestFingerprint(a,"test","user:1",input);
  expect(await deliveryRequestFingerprint(a,"test","user:1",input)).toBe(first);
  expect(await deliveryRequestFingerprint(b,"test","user:1",input)).not.toBe(first);
  expect(await deliveryRequestFingerprint(a,"other","user:1",input)).not.toBe(first);
  expect(await deliveryRequestFingerprint(a,"test","user:2",input)).not.toBe(first);
  expect(await deliveryRequestFingerprint(a,"test","user:1",{...input,price:1})).not.toBe(first);
});
test("private delivery numbers must match the independently fetched registry",async()=>{
  const value={format:"sortsys-delivery-note-v1",note:{format:"sortsys-row-v2",schema:businessSchema.fingerprint,table:"product_delivery_notes",values:{id:"3",project_id:"2",auto_id:"7",created_by_user_id:null,comment:null,created_at:"2026-11-11T00:00:00Z",effective_timestamp:"2026-11-11T00:00:00Z"}},records:[],specialRecords:[]};
  const object={envelope:{object:"delivery-note:2:3",scope:"project:2",facet:"contract-quantities"},value};
  let allocation={id:"3",projectId:"2",number:"7"};
  const client={query:async()=>[[{object:object.envelope.object,allocation}],null]};
  await checkDeliveryObjects(client,[object],()=>{});
  for(const update of [{number:"8"},{projectId:"4"},{id:"5"}]){const old=allocation;allocation={...old,...update};await expect(checkDeliveryObjects(client,[object],()=>{})).rejects.toThrow();allocation=old;}
  expect(()=>deliveryAllocation({...allocation,number:7})).toThrow();expect(()=>deliveryAllocation({...allocation,extra:true})).toThrow();
});
