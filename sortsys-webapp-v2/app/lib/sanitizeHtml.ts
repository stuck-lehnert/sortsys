const ALLOWED_TAGS = new Set([
  'A', 'B', 'BR', 'CODE', 'DIV', 'EM', 'I', 'LI', 'OL', 'P', 'PRE', 'SMALL', 'SPAN', 'STRONG', 'UL',
]);

const ALLOWED_GLOBAL_ATTRS = new Set(['title']);
const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSafeUrl(value: string) {
  try {
    const url = new URL(value, window.location.origin);
    return ALLOWED_URL_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

function sanitizeElement(element: Element) {
  if (!ALLOWED_TAGS.has(element.tagName)) {
    element.replaceWith(...Array.from(element.childNodes));
    return;
  }

  for (const attr of Array.from(element.attributes)) {
    const name = attr.name.toLowerCase();
    const value = attr.value;

    if (name.startsWith('on')) {
      element.removeAttribute(attr.name);
      continue;
    }

    if (ALLOWED_GLOBAL_ATTRS.has(name)) continue;

    if (element.tagName === 'A' && name === 'href' && isSafeUrl(value)) {
      element.setAttribute('rel', 'noopener noreferrer');
      element.setAttribute('target', '_blank');
      continue;
    }

    element.removeAttribute(attr.name);
  }
}

export function sanitizeHtml(input: unknown) {
  const html = `${input ?? ''}`;
  if (typeof document !== 'object') return escapeHtml(html);

  const template = document.createElement('template');
  template.innerHTML = html;

  for (const blocked of Array.from(template.content.querySelectorAll('script, iframe, object, embed, style, link, meta'))) {
    blocked.remove();
  }

  for (const element of Array.from(template.content.querySelectorAll('*'))) {
    sanitizeElement(element);
  }

  return template.innerHTML;
}
