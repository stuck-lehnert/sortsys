// Maintainer-only. Seeding reads the committed bytes and never runs this file.
import { readFile, writeFile } from 'node:fs/promises';
import { burn } from '../../sortsys-webapp-v2/node_modules/@kenjiuno/msgreader/lib/Burner.js';
import { TypeEnum } from '../../sortsys-webapp-v2/node_modules/@kenjiuno/msgreader/lib/Reader.js';
const base = new URL('./', import.meta.url);
for (const [name,subject,body,attachment] of [
 ['baubesprechung', 'Baubesprechung Musterhaus - Protokoll', 'Guten Tag,\n\nanbei das Protokoll unserer heutigen Baubesprechung. Bitte die zusätzlichen Leibungsarbeiten als Nachtragsangebot vorbereiten.\n\nFreundliche Grüße\nAnna Beispiel', 'baubesprechung.pdf'],
 ['materialfreigabe','Materialfreigabe - Innenanstrich','Guten Tag,\n\ndie Musterfläche ist freigegeben. Die PDF mit den besprochenen Materialien liegt bei. Lieferung am Montag zwischen 08:00 und 10:00 Uhr.\n\nViele Grüße\nJan Muster','materialfreigabe.pdf'],
]) {
 const data = await readFile(new URL(attachment,base));
 const headers=['From: "Anna Beispiel" <anna@planung.example>', 'To: "Malerbetrieb Beispiel GmbH" <buero@malerbetrieb.example>', `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, 'Date: Thu, 05 Nov 2026 09:15:00 +0100', `Message-ID: <${name}@seed.sortsys.example>`, 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="sortsys-demo-boundary"'];
 const wrap=bytes=>Buffer.from(bytes).toString('base64').match(/.{1,76}/g).join('\r\n');
 const eml=headers.join('\r\n')+'\r\n\r\n--sortsys-demo-boundary\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'+wrap(Buffer.from(body))+'\r\n--sortsys-demo-boundary\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="'+attachment+'"\r\nContent-Transfer-Encoding: base64\r\n\r\n'+wrap(data)+'\r\n--sortsys-demo-boundary--\r\n';
 await writeFile(new URL(name+'.eml',base),eml);
 const entries=[{name:'Root Entry',type:TypeEnum.ROOT,length:0,children:[]}];
 function stream(parent,tag,content) {
  const bytes=typeof content==='string'?new Uint8Array(Buffer.from(content+'\0','utf16le')):new Uint8Array(content);
  entries[parent].children.push(entries.length);
  entries.push({name:'__substg1.0_'+tag,type:TypeEnum.DOCUMENT,length:bytes.length,binaryProvider:()=>bytes});
 }
 function folder(name) {const index=entries.length;entries[0].children.push(index);entries.push({name,type:TypeEnum.DIRECTORY,length:0,children:[]});return index;}
 stream(0,'0037001F',subject);stream(0,'0C1A001F','Anna Beispiel');stream(0,'5D01001F','anna@planung.example');stream(0,'1000001F',body);
 const recipient=folder('__recip_version1.0_#00000000');stream(recipient,'3001001F','Malerbetrieb Beispiel GmbH');stream(recipient,'39FE001F','buero@malerbetrieb.example');
 const part=folder('__attach_version1.0_#00000000');stream(part,'3707001F',attachment);stream(part,'370E001F','application/pdf');stream(part,'37010102',data);
 await writeFile(new URL(name+'.msg',base),new Uint8Array(burn(entries)));
}
