import { expect, test } from "bun:test";
import { scriptModuleImportPattern, scriptModuleNames } from "./scriptModules";

test("checking and replacing dynamic imports uses the same module names", () => {
  const accepted = scriptModuleNames.map((name, index) => {
    const quote = index % 2 === 0 ? '"' : "'";
    return `import( ${quote}${name}${quote} )`;
  });
  const unsupported = [
    'import("sortsys-unknown")',
    'import("sortsys-utils-extra")',
    'import("sortsys-utils\')',
    'import * as utils from "sortsys-utils"',
  ];
  const source = [...accepted, ...unsupported].join("\n");

  expect([...source.matchAll(scriptModuleImportPattern())].map((match) => match[2]))
    .toEqual(scriptModuleNames);
  expect(source.replace(scriptModuleImportPattern(), "").trimEnd())
    .toBe("\n".repeat(accepted.length) + unsupported.join("\n"));
});
