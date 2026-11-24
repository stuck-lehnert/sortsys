// Shared spellings of address lexemes in the PostgreSQL search parser.
// Catalogue prefixes and document search keep their distinct query semantics.
const label = "[a-z0-9-]+";
const filePart = "[a-z0-9_][a-z0-9_-]*(?:\\.[a-z0-9_][a-z0-9_-]*)*";
const relativeFileRoot = "(?:[a-z0-9]+|(?<![_.-])\\.\\.?)";
const qualifiedHost = `(?:${label}\\.)+[a-z]{2,}`;
const port = "(?::[0-9]+)?";

export const searchHost = `${qualifiedHost}(?![a-z0-9_.-])${port}`;
// A sentence-ending period isn't part of the address. Reject a continuation
// of the host, and don't start inside a non-ASCII local part.
export const searchEmail = `(?<![\\p{L}\\p{M}\\p{N}_.-])[a-z0-9_.-]+@${qualifiedHost}(?![a-z0-9_-]|\\.[a-z0-9_.-])${port}`;
export const searchUrlPath = "/[a-z0-9_~./!$&'()*+,;=:@%?#-]*";
// A slash can start a new lexeme even after a dash. A dash before the first
// slash ends an unqualified relative root, but may occur inside a path.
export const searchFilePath = `${relativeFileRoot}?(?:/${filePart})+`;
