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

/** A useful, page-type-specific hint instead of repeating the site tagline. */
const PAGE_HINTS: [RegExp, string][] = [
  [/portfolio|manage|holdings/i, 'This is where you see everything you hold — each asset, its balance, and the yield it earns.'],
  [/points|rewards|season/i, 'This page tracks the reward points you rack up over time.'],
  [/explore|strateg|machine|market|vault|earn|invest/i, 'Browse the available strategies here — each card shows its live APY and how much money is in it (TVL).'],
  [/dashboard|overview|home/i, 'A quick snapshot of your account and what you can do.'],
  [/stake|security/i, 'Stake your tokens here to help secure the protocol and earn extra on top.'],
];
function pageHint(text: string): string {
  for (const [re, h] of PAGE_HINTS) if (re.test(text)) return h;
  return '';
}

export function overviewCaption(page: PageInfo, isFirst: boolean): string {
  const name = clean(page.pageName || page.heading || page.title || 'the app');
  const hint = pageHint(`${name} ${page.heading} ${page.title}`);
  if (isFirst) {
    return `Welcome to ${name}. ${hint || "Let's walk through what you can do here."}`.trim();
  }
  if (hint) return `Now we're on the ${name} page. ${hint}`;
  return `Now we're on the ${name} page.`;
}

// ---- Action panel (the right-side Swap / Deposit / Bridge / Stake panel) ----

const PANEL_INFO: [RegExp, { title: string; caption: string }][] = [
  [/swap|trade|exchange/i, { title: 'Swap', caption: 'The Swap tab exchanges one token for another. Pick what you’re selling and what you want to buy, enter an amount, and confirm — like a currency exchange for crypto.' }],
  [/redeem/i, { title: 'Redeem', caption: 'Redeem cashes out: it turns your vault tokens back into the underlying asset when you want your money back.' }],
  [/deposit/i, { title: 'Deposit', caption: 'The Deposit tab is how you put money to work — you deposit a token into a vault (a “Machine”) and it starts earning yield for you.' }],
  [/security|stake|module/i, { title: 'Security Module', caption: 'The Security Module lets you stake tokens to help protect the protocol. In return you earn extra rewards on top of the normal yield.' }],
  [/bridge/i, { title: 'Bridge', caption: 'The Bridge moves your tokens between networks (chains). Choose the “from” and “to” chains, enter an amount, and it transfers them across.' }],
  [/withdraw/i, { title: 'Withdraw', caption: 'Withdraw pulls your staked or deposited funds back out to your wallet.' }],
];

export function panelInfo(heading: string): { title: string; caption: string } {
  for (const [re, info] of PANEL_INFO) if (re.test(heading)) return info;
  const h = clean(heading) || 'Actions';
  return { title: h, caption: `This is the ${h} panel — one of the main tools you'll use in this app.` };
}

function panelVerb(heading: string): string {
  if (/swap|trade/i.test(heading)) return 'swap';
  if (/redeem/i.test(heading)) return 'redeem';
  if (/deposit/i.test(heading)) return 'deposit';
  if (/bridge/i.test(heading)) return 'bridge';
  if (/security|stake/i.test(heading)) return 'stake';
  if (/withdraw/i.test(heading)) return 'withdraw';
  return 'use';
}

export function controlCaption(kind: string, panelHeading: string): string {
  const verb = panelVerb(panelHeading);
  switch (kind) {
    case 'amount':
      return `Type how much you want to ${verb} in this box. Your available balance is shown just below it.`;
    case 'percent':
      return `These shortcuts fill the amount for you — 25%, 50%, 75% of your balance, or MAX for all of it.`;
    case 'token':
      return `Click here to choose which token you’re using.`;
    case 'network':
      return `Pick the network here — the chain your funds move from, and the one they move to.`;
    case 'tabswitch':
      return `These tabs flip between the two opposite actions — for example Deposit and Withdraw.`;
    case 'cta':
      return `Once you’ve entered an amount, this button confirms the ${verb}. It stays greyed out until the amount is valid.`;
    default:
      return `Part of the ${verb} form.`;
  }
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
