import type { Page } from '@playwright/test';

/**
 * Measurements taken inside the page. Each function is serialised by
 * Playwright and run with `page.evaluate`, which the apps' enforced
 * Content-Security-Policy does not apply to, so they must be self-contained
 * (no closures over module scope).
 */

export interface TargetMeasurement {
  selector: string;
  name: string;
  role: string;
  width: number;
  height: number;
  /** WCAG 2.5.8: under 24×24 and the 24 px spacing circle hits a neighbour. */
  fails24: boolean;
  /** Under 24×24 but passes on spacing, or inline in a sentence (exempt). */
  exempt: 'spacing' | 'inline' | null;
  /** PRD 03 "Spacing and density": touch targets at least 44×44. */
  under44: boolean;
}

export interface OverflowMeasurement {
  /** Page scrolls sideways (WCAG 1.4.10 reflow). */
  pageScrollWidth: number;
  viewportWidth: number;
  /** Elements whose box crosses the right edge outside any sideways-scrolling region. */
  offenders: Array<{ selector: string; right: number; text: string }>;
  /** Text clipped by its own box (overflow hidden/clip with content larger than the box). */
  clipped: Array<{ selector: string; text: string; scroll: string; client: string }>;
}

export interface AnimationMeasurement {
  running: Array<{ selector: string; name: string; duration: number; iterations: number | string; kind: string }>;
}

export interface FocusStep {
  index: number;
  selector: string;
  role: string;
  name: string;
  visibleIndicator: boolean;
  inViewport: boolean;
  obscured: boolean;
}

function helpers() {
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`${part}#${CSS.escape(node.id)}`);
        break;
      }
      const label = node.getAttribute('aria-label');
      if (label && label.length < 40) part += `[aria-label="${label.replace(/"/g, '\\"')}"]`;
      else {
        const parent: Element | null = node.parentElement;
        if (parent) {
          const same = [...parent.children].filter((c) => c.tagName === node!.tagName);
          if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const visible = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.01;
  };
  const accName = (el: Element): string => {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const text = labelled
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
        .trim();
      if (text) return text;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      const label = el.labels?.[0]?.textContent?.trim();
      if (label) return label;
      return el.getAttribute('placeholder') ?? el.getAttribute('title') ?? '';
    }
    return ((el as HTMLElement).innerText || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  };
  const role = (el: Element): string => el.getAttribute('role') ?? el.tagName.toLowerCase();
  const INTERACTIVE =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="option"], [role="slider"], [tabindex]:not([tabindex="-1"])';
  return { cssPath, visible, accName, role, INTERACTIVE };
}

/** Installs the helpers on window for the measurement functions below. */
async function install(page: Page): Promise<void> {
  await page.evaluate(`window.__sfAudit = (${helpers.toString()})()`);
}

type Helpers = ReturnType<typeof helpers>;
declare global {
  interface Window {
    __sfAudit: Helpers;
  }
}

export async function measureTargets(page: Page): Promise<TargetMeasurement[]> {
  await install(page);
  return page.evaluate(() => {
    const { cssPath, visible, accName, role, INTERACTIVE } = window.__sfAudit;
    const elements = [...document.querySelectorAll(INTERACTIVE)].filter((el) => {
      if (!visible(el)) return false;
      // A visually hidden native input whose <label> is the real target is
      // measured through its label instead.
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        const box = el.getBoundingClientRect();
        if (box.width <= 2 || box.height <= 2) return false;
      }
      return true;
    });
    const boxes = elements.map((el) => {
      let box = el.getBoundingClientRect();
      // A checkbox or radio wrapped in its label is hit through the whole label.
      if (el instanceof HTMLInputElement && el.closest('label')) box = el.closest('label')!.getBoundingClientRect();
      return { el, box };
    });
    const centre = (b: DOMRect) => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
    const distToRect = (p: { x: number; y: number }, b: DOMRect) => {
      const dx = Math.max(b.left - p.x, 0, p.x - b.right);
      const dy = Math.max(b.top - p.y, 0, p.y - b.bottom);
      return Math.hypot(dx, dy);
    };
    const small = (b: DOMRect) => b.width < 24 - 0.01 || b.height < 24 - 0.01;
    return boxes.map(({ el, box }, i) => {
      let exempt: 'spacing' | 'inline' | null = null;
      let fails24 = false;
      if (small(box)) {
        const inline =
          el.tagName === 'A' &&
          getComputedStyle(el).display === 'inline' &&
          ((el.parentElement?.textContent ?? '').trim().length > (el.textContent ?? '').trim().length + 10);
        if (inline) exempt = 'inline';
        else {
          const c = centre(box);
          const collides = boxes.some(({ box: other }, j) => {
            if (j === i) return false;
            if (distToRect(c, other) < 12) return true;
            if (small(other)) {
              const o = centre(other);
              return Math.hypot(c.x - o.x, c.y - o.y) < 24;
            }
            return false;
          });
          if (collides) fails24 = true;
          else exempt = 'spacing';
        }
      }
      return {
        selector: cssPath(el),
        name: accName(el),
        role: role(el),
        width: Math.round(box.width * 10) / 10,
        height: Math.round(box.height * 10) / 10,
        fails24,
        exempt,
        under44: box.width < 44 - 0.01 || box.height < 44 - 0.01,
      };
    });
  });
}

export async function measureOverflow(page: Page): Promise<OverflowMeasurement> {
  await install(page);
  return page.evaluate(() => {
    const { cssPath, visible } = window.__sfAudit;
    const viewportWidth = document.documentElement.clientWidth;
    const scrollsSideways = (el: Element | null): boolean => {
      for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && node.scrollWidth > node.clientWidth) return true;
      }
      return false;
    };
    const clippedBy = (el: Element): boolean => {
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.overflowX === 'hidden' || style.overflowX === 'clip') {
          const box = node.getBoundingClientRect();
          if (box.right <= viewportWidth + 1) return true;
        }
      }
      return false;
    };
    const offenders: OverflowMeasurement['offenders'] = [];
    const clipped: OverflowMeasurement['clipped'] = [];
    const all = [...document.body.querySelectorAll('*')];
    for (const el of all) {
      if (!visible(el)) continue;
      const box = el.getBoundingClientRect();
      if (box.right > viewportWidth + 1 && !scrollsSideways(el) && !clippedBy(el)) {
        // Report the outermost offender only.
        const parent = el.parentElement;
        if (parent && parent.getBoundingClientRect().right > viewportWidth + 1 && !scrollsSideways(parent) && parent !== document.body) continue;
        offenders.push({ selector: cssPath(el), right: Math.round(box.right), text: (el.textContent ?? '').trim().slice(0, 60) });
      }
      const style = getComputedStyle(el);
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0);
      if (!hasText) continue;
      const hides = ['hidden', 'clip'];
      const overX = hides.includes(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
      const overY = hides.includes(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
      // An intentional single-line ellipsis keeps the full text in a title or
      // nearby; it is still clipping and is reported, but tagged.
      if (overX || overY) {
        clipped.push({
          selector: cssPath(el),
          text: (el.textContent ?? '').trim().slice(0, 60) + (style.textOverflow === 'ellipsis' ? ' [ellipsis]' : ''),
          scroll: `${el.scrollWidth}×${el.scrollHeight}`,
          client: `${el.clientWidth}×${el.clientHeight}`,
        });
      }
    }
    return { pageScrollWidth: document.documentElement.scrollWidth, viewportWidth, offenders: offenders.slice(0, 25), clipped: clipped.slice(0, 25) };
  });
}

/** WCAG 1.4.12: the bookmarklet values, applied with !important. */
export const TEXT_SPACING_CSS = `
  * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
  p { margin-bottom: 2em !important; }
`;

export async function applyTextSpacing(page: Page): Promise<void> {
  // Through evaluate rather than addStyleTag: the apps' CSP refuses inline styles
  // added by a script tag, but a constructed stylesheet is not subject to it.
  await page.evaluate((css) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, TEXT_SPACING_CSS);
}

export async function measureAnimations(page: Page): Promise<AnimationMeasurement> {
  await install(page);
  return page.evaluate(() => {
    const { cssPath } = window.__sfAudit;
    const running = document
      .getAnimations()
      .filter((a) => a.playState === 'running')
      .map((a) => {
        const timing = a.effect?.getComputedTiming();
        const target = (a.effect as KeyframeEffect | null)?.target ?? null;
        return {
          selector: target ? cssPath(target) : '(none)',
          name: (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? a.id ?? 'animation',
          duration: Number(timing?.duration ?? 0),
          iterations: timing?.iterations === Infinity ? 'infinite' : Number(timing?.iterations ?? 1),
          kind: a.constructor.name,
        };
      })
      .filter((a) => a.duration > 1);
    return { running };
  });
}

/** The element that has focus now, described for a keyboard walkthrough. */
export async function describeFocus(page: Page, index: number): Promise<FocusStep> {
  await install(page);
  return page.evaluate((index) => {
    const { cssPath, accName, role } = window.__sfAudit;
    const el = document.activeElement;
    if (!el || el === document.body) {
      return { index, selector: 'body', role: 'body', name: '', visibleIndicator: false, inViewport: true, obscured: false };
    }
    const style = getComputedStyle(el);
    // An outline or a ring drawn with box-shadow. Indicators drawn another way
    // (a border or background change) read as "no indicator" here and are
    // checked by eye on the step's screenshot.
    const visibleIndicator = (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 1) || style.boxShadow !== 'none';
    const box = el.getBoundingClientRect();
    const inViewport = box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
    const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, box.left + box.width / 2)), Math.min(innerHeight - 1, Math.max(0, box.top + box.height / 2)));
    const obscured = inViewport && hit !== null && hit !== el && !el.contains(hit) && !hit.contains(el);
    return { index, selector: cssPath(el), role: role(el), name: accName(el), visibleIndicator, inViewport, obscured };
  }, index);
}

/** Landmarks, headings and the skip link: the structure a screen-reader user navigates by. */
export async function measureStructure(page: Page): Promise<{
  title: string;
  lang: string;
  mains: number;
  navs: number;
  h1: string[];
  skipLink: boolean;
  headingOrder: string[];
}> {
  return page.evaluate(() => {
    const first = document.querySelector('a[href^="#"]');
    const skipLink = Boolean(first && /skip|main content/i.test(first.textContent ?? ''));
    return {
      title: document.title,
      lang: document.documentElement.lang,
      mains: document.querySelectorAll('main, [role="main"]').length,
      navs: document.querySelectorAll('nav, [role="navigation"]').length,
      h1: [...document.querySelectorAll('h1')].map((h) => (h.textContent ?? '').trim().replace(/\s+/g, ' ')),
      skipLink,
      headingOrder: [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].slice(0, 30).map((h) => `${h.tagName.toLowerCase()}: ${(h.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 50)}`),
    };
  });
}
