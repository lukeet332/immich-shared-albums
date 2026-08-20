/**
 * web/tags.ts — `html` and `css` template tags for the pages this addon serves.
 *
 * Two jobs, and the second is the important one.
 *
 * READABILITY: Prettier formats embedded HTML and CSS inside template literals *tagged* `html`
 * and `css`, and skips them otherwise. Tagging the markup is therefore the entire difference
 * between the pages being the only unformatted code in the repo and being formatted like
 * everything else — no framework, no build step, no dependency.
 *
 * SAFETY: `html` escapes every interpolation by default. It has to. Peer names, URLs and album
 * names all arrive from *another server* — a peer sets `household.name` when it pairs — and they
 * are rendered into the admin panel, a page holding an authenticated admin session. Interpolating
 * those raw let a malicious or compromised peer run script there. Escaping by default means the
 * dangerous case is the one you have to ask for.
 *
 * Use `raw()` for markup you built yourself, e.g. a joined list of rows. Never wrap a value that
 * came off the wire in it.
 */

// A plain field, not a constructor parameter property: Node runs this TypeScript in strip-only
// mode, which cannot transform `constructor(readonly x: string)` and refuses to load the file.
// `tsc` accepts it, so only the runtime catches this — see the check:runtime gate.
class Raw {
  value: string;
  constructor(value: string) {
    this.value = value;
  }
}

/** Mark a string as already-safe markup. Only ever for HTML this code generated. */
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
  // arrays of parts are common (a list of rows), so join rather than stringify the array
  if (Array.isArray(value)) return value.map(escape).join('');
  return String(value).replace(/[&<>"']/g, c => ESCAPES[c] ?? c);
};

export const html = (parts: TemplateStringsArray, ...values: unknown[]) =>
  parts.reduce((out, part, i) => out + part + (i < values.length ? escape(values[i]) : ''), '');

/** CSS needs no escaping — nothing off the wire is ever interpolated into a stylesheet here. */
export const css = (parts: TemplateStringsArray, ...values: unknown[]) =>
  String.raw({ raw: parts }, ...values);
