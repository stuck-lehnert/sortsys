import { frame, identifier, InvalidProtectedData, record, revision, sized, unbase64, utf8 } from "./encoding";

export type MigrationReceipt = {
  tenant: string; migration: string; schema: string; generation: string; table: string; part: string;
  row: string; byte: string; nextRow: string; nextByte: string;
  object: string; revision: string; ciphertextHash: string; author: string; proof: string;
};
export type LegacyPart = {
  format: "sortsys-legacy-part-v1"; tenant: string; migration: string; schema: string;
  table: string; part: string; row: string; byte: string; nextRow: string; nextByte: string;
  encoding: "rows" | "row-chunk"; data: string;
};
export function migrationNumber(input: unknown): asserts input is string {
  if (typeof input !== "string" || !/^(?:0|[1-9]\d{0,18})$/.test(input) || BigInt(input) > 9223372036854775807n) throw new InvalidProtectedData();
}
function schemaFingerprint(input: unknown): asserts input is string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/.test(input)) throw new InvalidProtectedData();
}
export function migrationStartFrame(tenant: string, generation: string, schema: string, id: string): Uint8Array<ArrayBuffer> {
  identifier(tenant); identifier(id); revision(generation); schemaFingerprint(schema);
  return frame("sortsys/migration-start/v1", [tenant,generation,schema,id]);
}
export function migrationReceiptFrame(input: Omit<MigrationReceipt,"proof"> | MigrationReceipt): Uint8Array<ArrayBuffer> {
  for (const value of [input.tenant,input.migration,input.table,input.object,input.author]) identifier(value);
  for (const value of [input.part,input.row,input.byte,input.nextRow,input.nextByte]) migrationNumber(value);
  revision(input.generation); revision(input.revision); schemaFingerprint(input.schema); sized(input.ciphertextHash,32);
  return frame("sortsys/migration-receipt/v1", [input.tenant,input.migration,input.schema,input.generation,input.table,input.part,input.row,input.byte,input.nextRow,input.nextByte,input.object,input.revision,input.ciphertextHash,input.author]);
}
export function migrationReceipt(input: unknown): MigrationReceipt {
  const value = record(input,["tenant","migration","schema","generation","table","part","row","byte","nextRow","nextByte","object","revision","ciphertextHash","author","proof"]) as MigrationReceipt;
  migrationReceiptFrame(value); sized(value.proof,64); return { ...value };
}
function sourceRow(source:string,expected:{schema:string;table:string}):void {
  try {
    const header=record(JSON.parse(source),["format","schema","table","values"]);
    if(header.format!=="sortsys-row-v2" || header.schema!==expected.schema || header.table!==expected.table || !header.values || typeof header.values!=="object" || Array.isArray(header.values)) throw new InvalidProtectedData();
  } catch { throw new InvalidProtectedData(); }
}
export function legacyPart(input: unknown): LegacyPart {
  const value = record(input,["format","tenant","migration","schema","table","part","row","byte","nextRow","nextByte","encoding","data"]) as LegacyPart;
  if(value.format!=="sortsys-legacy-part-v1") throw new InvalidProtectedData();
  for(const id of [value.tenant,value.migration,value.table]) identifier(id);
  schemaFingerprint(value.schema);
  for(const n of [value.part,value.row,value.byte,value.nextRow,value.nextByte]) migrationNumber(n);
  if(typeof value.data!=="string") throw new InvalidProtectedData();
  const data=unbase64(value.data,2*1024*1024);
  const row=BigInt(value.row),byte=BigInt(value.byte),nextRow=BigInt(value.nextRow),nextByte=BigInt(value.nextByte);
  if(value.encoding==="rows") {
    if(byte!==0n || nextByte!==0n || nextRow<=row || nextRow-row>32n) throw new InvalidProtectedData();
    let rows:unknown;
    try { rows=JSON.parse(utf8(data)); } catch { throw new InvalidProtectedData(); }
    if(!Array.isArray(rows) || BigInt(rows.length)!==nextRow-row) throw new InvalidProtectedData();
    for(const source of rows) {
      if(typeof source!=="string") throw new InvalidProtectedData();
      sourceRow(source,value);
    }
  } else if(value.encoding==="row-chunk") {
    if(!data.length || data.length>65536 || !((nextRow===row && nextByte===byte+BigInt(data.length)) || (nextRow===row+1n && nextByte===0n))) throw new InvalidProtectedData();
  } else throw new InvalidProtectedData();
  return { ...value };
}

/** Reassemble raw source JSON without parsing/reformatting nested business
 * values. In particular, JSON integers beyond Number.MAX_SAFE_INTEGER survive. */
export class LegacyRows {
  private row=0n;
  private byte=0n;
  private part=0n;
  private chunks:Uint8Array<ArrayBuffer>[]=[];
  private length=0;
  constructor(private readonly expected:{tenant:string;migration:string;schema:string;table:string}) {}
  push(input:unknown):string[] {
    const value=legacyPart(input);
    for(const key of ["tenant","migration","schema","table"] as const) if(value[key]!==this.expected[key]) throw new InvalidProtectedData();
    if(BigInt(value.row)!==this.row || BigInt(value.byte)!==this.byte || BigInt(value.part)!==this.part) throw new InvalidProtectedData();
    const data=unbase64(value.data,2*1024*1024);
    let result:string[]=[];
    if(value.encoding==="rows") result=JSON.parse(utf8(data)) as string[];
    else {
      if(this.length+data.length>128*1024*1024) throw new InvalidProtectedData();
      this.chunks.push(data); this.length+=data.length;
      if(BigInt(value.nextRow)>this.row) {
        const joined=new Uint8Array(this.length); let offset=0;
        for(const chunk of this.chunks) {joined.set(chunk,offset);offset+=chunk.length;}
        const source=utf8(joined);
        // Validate only the wrapper; do not turn nested JSON numbers into JS
        // numbers and then serialize the rounded result back to storage.
        sourceRow(source,value);
        result=[source]; this.chunks=[]; this.length=0;
      }
    }
    this.row=BigInt(value.nextRow);this.byte=BigInt(value.nextByte);this.part++;
    return result;
  }
  finish(rows:string):void {
    migrationNumber(rows);
    if(this.row!==BigInt(rows) || this.byte!==0n || this.length) throw new InvalidProtectedData();
  }
}
