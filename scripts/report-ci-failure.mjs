import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

export function failureAnnotation(log) {
  const clean = stripVTControlCharacters(log);
  const cleanup = clean.indexOf("scripts/test-api failed. Container logs:");
  const diagnostics = cleanup < 0 ? clean : clean.slice(0, cleanup);
  const tail = diagnostics.trimEnd().split(/\r?\n/).slice(-160).join("\n");
  const message = Buffer.from(tail || "CI failed without log output").subarray(-24000);
  // GitHub truncates individual annotation messages at 4096 characters.
  // Keep each chunk below that limit and the entire report below ten annotations.
  const chunks = [];
  for (let offset = 0; offset < message.length; offset += 3000) {
    const chunk = message.subarray(offset, offset + 3000).toString("utf8");
    const escaped = chunk.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
    chunks.push(`::error title=Repository CI failed::${escaped}\n`);
  }
  return chunks.join("");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(failureAnnotation(readFileSync(process.argv[2], "utf8")));
}
