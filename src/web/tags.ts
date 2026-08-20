/** web/tags.ts — `html` and `css` template tags for the pages this addon serves. See http-router.md. */

class Raw {
  value: string;
  constructor(value: string) {
    this.value = value;
  }
}

export const raw = (markup: string) => new Raw(markup);

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const escape = (value: unknown): string => {
  if (value instanceof Raw) return value.value;
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(escape).join('');
  return String(value).replace(/[&<>"']/g, c => ESCAPES[c] ?? c);
};

export const html = (parts: TemplateStringsArray, ...values: unknown[]) =>
  parts.reduce((out, part, i) => out + part + (i < values.length ? escape(values[i]) : ''), '');

export const css = (parts: TemplateStringsArray, ...values: unknown[]) =>
  String.raw({ raw: parts }, ...values);
