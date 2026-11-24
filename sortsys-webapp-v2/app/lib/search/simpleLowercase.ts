/** Use PostgreSQL's simple lowercase mapping in C.UTF-8.
 * JavaScript otherwise adds a combining dot or chooses a final sigma. */
export function simpleLowercase(text: string): string {
  return text
    .replace(/[İΣ]/g, (letter) => (letter === "İ" ? "i" : "σ"))
    .toLowerCase();
}
