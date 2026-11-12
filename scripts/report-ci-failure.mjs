import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

export function failureAnnotation(log) {
  const tail = stripVTControlCharacters(log).trimEnd().split(/\r?\n/).slice(-160).join("\n");
  const message = Buffer.from(tail).subarray(-48000).toString("utf8") || "CI failed without log output";
  const escaped = message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  return `::error title=Repository CI failed::${escaped}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(failureAnnotation(readFileSync(process.argv[2], "utf8")));
}
