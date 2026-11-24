const factor = Number(process.env.SORTSYS_FIXTURE_TIMEOUT_FACTOR ?? "1");

if (!Number.isSafeInteger(factor) || factor < 1 || factor > 24) {
  throw new Error("SORTSYS_FIXTURE_TIMEOUT_FACTOR must be an integer from 1 to 24");
}

export function fixtureTimeout(milliseconds) {
  return milliseconds * factor;
}
