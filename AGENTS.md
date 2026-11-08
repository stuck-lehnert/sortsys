# Documentation style

- Write project-owned Markdown documentation in German. `AGENTS.md` files and third-party package READMEs may remain in English. Preserve upstream license and attribution text.
- Do not address readers with "du" in German documentation. Prefer impersonal wording for product descriptions and instructions.
- Explain what contractors and trade businesses can do with each feature. Make its benefit clear through actual workflows and examples; avoid general praise and unsupported claims.
- Write natural German: concrete subjects and verbs, consistent technical terms, and sentence lengths that follow the content. Avoid slogan-like openings, formulaic conclusions, rhetorical contrasts, forced three-part lists, and abstract noun chains. Use headings, lists, bold text and dashes where they help readers, without repeating the same pattern throughout.
- Review documentation using [Wikipedia's German writing guidance](https://de.wikipedia.org/wiki/Wikipedia:Anzeichen_f%C3%BCr_KI-generierte_Inhalte), its [English counterpart](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing), and [humanizer-de](https://github.com/marmbiz/humanizer-de). Apply these references in context; preserve necessary technical language, factual qualifications and legal wording. Do not add invented experience or artificial mistakes to make prose seem human.
- Favor readable explanations over maximum information density. Keep conditions close to the steps they govern, explain unfamiliar terms, and split dense sentences instead of stacking nouns or inventing compounds. This applies an editorial lesson from [Clark, Martin and Mahowald (2026)](https://arxiv.org/abs/2610.29162); their study analyzes English, so do not treat its specific linguistic findings as rules for German.
- Organize each document around its reader and task. Use READMEs as entry points and link to sustained user guides, workflow descriptions or implementation details. Avoid imposing the same outline on every document, mixing instructions with change history, and adding empty introductions or closing summaries. Choose tables for comparisons and lists for steps or reference material, not as a default for prose.
- Keep technical instructions precise and concise. The root README is a short entry point; link to detailed guides instead of expanding it.
- Preserve commands, API identifiers, filenames and checksums. Update internal links when translating headings.

# Search results

- Server-side search and query-aware option providers own text matching. Disable built-in label filtering when displaying their results; do not apply another client-side text filter.
- Local text matching is appropriate for complete local datasets. Keep eligibility checks, such as excluding the current user from their own supervisor choices, separate from search matching.

# LLM interactions

- Chat and document import must use authenticated MCP for tool discovery and tool calls. Provider adapters must preserve this path, including OpenRouter's MCP bridge.
- Document import uses its own scoped delegation for product catalogue searches. Preserve tenant, session and permission checks when extending these interactions.
