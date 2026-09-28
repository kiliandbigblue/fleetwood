import { stepIndex } from './fleetSignals.ts';

/*
 * The fleet from the keyboard: `j`/`k` down and up the cards, `n` to the next
 * one that needs you, Enter to go to the one you are on, a digit to answer its
 * prompt (`a`/`d` for the approve and deny ones), `m` for its menu, and →/← to
 * unfold and fold a parked card.
 *
 * Read off the document rather than held in state, on purpose. The list is
 * redrawn every second from a fresh snapshot and reordered by what the agents
 * are doing, so an index held in React would point at a different card after
 * the next poll; the focused element is the one thing a redraw keeps where it
 * was. Every card's title is a real button, so "where you are" is just focus,
 * and a screen reader and a mouse user agree with the keyboard about it.
 */

/** Every card title in the list on screen, top to bottom. */
function cardTitles(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.body .card-title')];
}

/** The card the keyboard is on, if it is on one. */
function focusedCard(): Element | null {
  return document.activeElement?.closest('.card') ?? null;
}

/** Move focus one card down or up the list, keeping it in view. */
export function moveCardFocus(direction: 1 | -1): void {
  const titles = cardTitles();
  const card = focusedCard();
  const current = card ? titles.findIndex((title) => card.contains(title)) : -1;
  const next = titles[stepIndex(current, titles.length, direction)];
  if (!next) return;
  next.focus();
  next.scrollIntoView({ block: 'nearest' });
}

/**
 * Focus the next card that needs you, after the one you are on.
 *
 * Wraps, unlike `j`/`k`: this is "take me to the next thing", and with the
 * last blocked card focused the next thing is the first one again.
 */
export function focusNextAttention(): void {
  const titles = cardTitles();
  const card = focusedCard();
  const current = card ? titles.findIndex((title) => card.contains(title)) : -1;
  const ordered = [...titles.slice(current + 1), ...titles.slice(0, current + 1)];
  const next = ordered.find((title) => title.closest('.card')?.classList.contains('attention'));
  if (!next) return;
  next.focus();
  next.scrollIntoView({ block: 'nearest' });
}

/**
 * Press one of the focused card's prompt buttons, by its terminal key or by
 * the approve/deny role.
 *
 * Only on the card you are on, never "the" blocked agent: with two prompts up,
 * a key that picked one for you would be answering a question you had not read.
 * The first prompt on the card is the one the card leads with — agents are
 * listed most urgent first.
 */
export function answerFocusedPrompt(answer: 'approve' | 'deny' | { key: string }): boolean {
  const selector =
    typeof answer === 'string' ? `.prompt .button.${answer}` : `.prompt [data-key="${CSS.escape(answer.key)}"]`;
  const button = focusedCard()?.querySelector<HTMLButtonElement>(selector);
  if (!button || button.disabled) return false;
  button.click();
  return true;
}

/** Open the focused card's menu. Its first item takes focus — see `CardMenu`. */
export function openFocusedMenu(): boolean {
  const trigger = focusedCard()?.querySelector<HTMLButtonElement>('.menu-open');
  if (!trigger) return false;
  trigger.click();
  return true;
}

/** Unfold (→) or fold (←) the focused parked card, if it is one. */
export function foldFocusedCard(open: boolean): boolean {
  const toggle = focusedCard()?.querySelector<HTMLButtonElement>('.card-fold');
  if (!toggle || (toggle.getAttribute('aria-expanded') === 'true') === open) return false;
  toggle.click();
  return true;
}

/** Keys typed into a field are text, not commands. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
