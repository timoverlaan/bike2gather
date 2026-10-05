export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function $(sel: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...a), ms);
  };
}
