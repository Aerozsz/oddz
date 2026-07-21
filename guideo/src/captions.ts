/**
 * Turns raw element/page metadata into beginner-friendly narration. Fully
 * offline and deterministic — no model calls — so a guide can be regenerated
 * anywhere. The Tweak tab lets a human rewrite any of these afterward.
 */

export interface ElementInfo {
  kind: string;
  tag: string;
  type: string;
  text: string;
  ariaLabel: string;
  placeholder: string;
  label: string;
  href: string;
  name: string;
}

export interface PageInfo {
  title: string;
  heading: string;
  intro: string;
  pageName: string;
}

function clean(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/** Best human name for an element, in priority order. */
function elementName(el: ElementInfo): string {
  return clean(el.text || el.ariaLabel || el.label || el.placeholder || el.name) || 'this';
}

export function overviewCaption(page: PageInfo, isFirst: boolean): string {
  const name = page.pageName || page.heading || page.title || 'this page';
  if (isFirst) {
    const intro = page.intro ? ` ${page.intro}` : '';
    return `Welcome! This is the ${name} page.${intro} Let's take a quick tour.`;
  }
  if (page.intro) return `You're now on the ${name} page. ${page.intro}`;
  if (page.heading) return `This is the ${name} page — “${page.heading}”.`;
  return `This is the ${name} page.`;
}

export function actionCaption(el: ElementInfo): string {
  const name = elementName(el);
  switch (el.kind) {
    case 'nav':
      return `Click “${name}” in the menu at the top to open that section.`;
    case 'cta':
      return `Click the “${name}” button to get started.`;
    case 'search':
      return `Click the search box and start typing — the list filters instantly as you type.`;
    case 'text':
      return `Click this box and type your ${(el.label || el.placeholder || 'details').toLowerCase()}.`;
    case 'select':
      return `Open the “${el.label || name}” dropdown and pick the option that fits you.`;
    case 'checkbox':
      return `Click the circle to mark this item as done — it's that simple.`;
    case 'submit':
      return `When everything looks right, click “${name}” to finish.`;
    case 'button':
      return `Click the “${name}” button.`;
    case 'link':
    default:
      return `Click “${name}” to continue.`;
  }
}

export function typedCaption(el: ElementInfo, value: string): string {
  if (el.kind === 'search') {
    return `Here we've typed “${value}” — notice the list narrows down to just the matching items.`;
  }
  return `We've entered “${value}” into the ${(el.label || 'field').toLowerCase()}.`;
}

export function resultCaption(el: ElementInfo): string {
  switch (el.kind) {
    case 'checkbox':
      return `Done! The item is now checked off. Repeat this for anything you finish.`;
    case 'submit':
      return `That's it — the form is submitted and you're all set. 🎉`;
    default:
      return `Nicely done.`;
  }
}
