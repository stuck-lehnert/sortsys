/** Replace only the numeric text of a native scalar. Vendor attributes,
 * comments, processing instructions and the surrounding XML remain intact. */
export function nativeScalarPatch(
  source: string,
  span: {
    start: number;
    openEnd: number;
    closeStart: number;
    end: number;
    name: string;
  },
  value: string,
) {
  if (span.closeStart === span.end) {
    const opening = source.slice(span.start, span.end).replace(/\/\s*>$/, ">");
    return {
      start: span.start,
      end: span.end,
      value: `${opening}${value}</${span.name}>`,
    };
  }
  const content = source.slice(span.openEnd, span.closeStart);
  let inserted = false;
  const replaced = content.replace(
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|[^<]+/g,
    (token) => {
      if (token.startsWith("<!--") || token.startsWith("<?")) {
        return token;
      }
      const cdata = token.startsWith("<![CDATA[");
      const text = cdata ? token.slice(9, -3) : token;
      if (!text.trim()) {
        return token;
      }
      const replacement = inserted ? "" : value;
      inserted = true;
      const next = text.replace(/\S[\s\S]*\S|\S/, replacement);
      return cdata ? `<![CDATA[${next}]]>` : next;
    },
  );
  return {
    start: span.openEnd,
    end: span.closeStart,
    value: inserted ? replaced : value + replaced,
  };
}
