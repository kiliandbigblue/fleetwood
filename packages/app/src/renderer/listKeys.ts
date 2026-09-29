import { stepIndex } from './fleetSignals.ts';

/*
 * The fleet from the keyboard, as a two-level tree the way vim's are: cards,
 * and the agent rows inside each. `j`/`k` go down and up the level you are
 * on, `l` goes in — unfolding a folded card first — and `h` comes back out,
 * folding a card you are already out on. `n` goes to the next card that needs
 * you, Enter to the one you are on, a digit answers its prompt (`a`/`d` for
 * the approve and deny ones), and `m` opens its menu. →/← are `l`/`h`.
 *
 * Read off the document rather than held in state, on purpose. The list is
 * redrawn every second from a fresh snapshot — cards appear, fold and leave as
 * sessions do — so an index held in React would point at a different card
 * after the next poll; the focused element is the one thing a redraw keeps where it
 * was. Every card's title is a real button, so "where you are" is just focus,
 * and a screen reader and a mouse user agree with the keyboard about it.
 */

/**
 * Every stop in the list on screen, top to bottom.
 *
 * The cards' titles, then the hidden drawer's when it is open — it sits under
 * the list, outside `.body` — and the rows of the agents with no card at all,
 * the daemon-hosted and the left over, which have nothing but their row to
 * land on. On the other tabs, their rows: every pull request and every
 * archived one is a `list-stop`. Document order is screen order, so one query
 * keeps them in it.
 */
function cardTitles(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '.body .card-title, .hidden-group .card-title, .orphans button.activity, .body .list-stop',
    ),
  ];
}

/**
 * The card the keyboard is on, if it is on one — or the agent row, for an
 * agent with no card of its own, or the row itself on the other tabs.
 */
function focusedCard(): Element | null {
  return document.activeElement?.closest('.orphans .agent, .card, .list-stop') ?? null;
}

/** A card's agent rows that can take focus — the inner level of the tree. */
function agentRows(card: Element): HTMLElement[] {
  return [...card.querySelectorAll<HTMLElement>('.agents button.activity')];
}

/** Whether focus is on an agent row inside a card, rather than on a card. */
function onAgentRow(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.matches('.card:not(.orphans) button.activity');
}

function focusInView(target: HTMLElement): void {
  target.focus();
  target.scrollIntoView({ block: 'nearest' });
}

/**
 * Move focus one step down or up the level you are on, keeping it in view.
 *
 * On an agent row that is the card's other agents, holding at its first and
 * last — `h` is the way back out to the cards, and falling off the end of a
 * card's agents into the next card's title would mix the two levels.
 */
export function moveCardFocus(direction: 1 | -1): void {
  if (onAgentRow()) {
    const card = document.activeElement?.closest('.card');
    const rows = card ? agentRows(card) : [];
    const current = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[stepIndex(current, rows.length, direction)];
    if (next) focusInView(next);
    return;
  }
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
 * `wrap` lets it come round to the top, unlike `j`/`k`: this is "take me to
 * the next thing". The caller asks without it first, so a blocked card behind
 * the closed hidden drawer gets its turn before the list comes round again.
 */
export function focusNextAttention(wrap = true): boolean {
  const titles = cardTitles();
  const card = focusedCard();
  const current = card ? titles.findIndex((title) => card.contains(title)) : -1;
  const ordered = [...titles.slice(current + 1), ...(wrap ? titles.slice(0, current + 1) : [])];
  const next = ordered.find(
    (title) =>
      title.closest('.card')?.classList.contains('attention') === true ||
      // On the pull requests tab: a merge waiting to ship, or changes asked of you.
      title.classList.contains('owes') ||
      // A cardless agent row: blocked when its own dot says so.
      title.closest('.orphans .agent')?.querySelector('.status-blocked_permission') != null,
  );
  if (!next) return false;
  next.focus();
  next.scrollIntoView({ block: 'nearest' });
  return true;
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

/**
 * The session of the card the keyboard is on — the name to ask a move about and
 * the id to find the card by afterwards — or `undefined` off a card, or on one
 * with no session to hold a place (a dormant task, a workspace, a list row).
 */
export function focusedSession(): { name: string; id: string } | undefined {
  const card = document.activeElement?.closest<HTMLElement>('.card[data-session]');
  const name = card?.dataset.session;
  const id = card?.dataset.sessionId;
  return name && id ? { name, id } : undefined;
}

/**
 * Put focus back on a card after it moved, found by its tmux session id.
 *
 * A move renames the session and redraws the list around it, and a node the
 * list moves can drop focus on `body` on the way — the next `J` would then have
 * no card to act on. The id is the handle because it is the one thing a rename
 * keeps. `false` when the card is not drawn (yet).
 */
export function refocusSession(id: string): boolean {
  const title = document.querySelector<HTMLElement>(`.card[data-session-id="${CSS.escape(id)}"] .card-title`);
  if (!title) return false;
  if (!title.closest('.card')?.contains(document.activeElement)) title.focus();
  title.scrollIntoView({ block: 'nearest' });
  return true;
}

/**
 * Mark a card that just arrived, once, so the eye can find where it landed.
 *
 * A move to the top or bottom sends it past the edge of what you were looking
 * at, and focus alone is a thin ring that is easy to lose in a long list. The
 * mark is a wash that fades out — see `.card.arrived` — restarted if the card
 * moves again before it has faded.
 */
export function markArrived(id: string): void {
  const card = document.querySelector<HTMLElement>(`.card[data-session-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.classList.remove('arrived');
  // Reading layout between the two restarts the animation rather than merging them.
  void card.offsetWidth;
  card.classList.add('arrived');
  card.addEventListener('animationend', () => card.classList.remove('arrived'), { once: true });
}

/** Open the focused card's menu. Its first item takes focus — see `CardMenu`. */
export function openFocusedMenu(): boolean {
  const trigger = focusedCard()?.querySelector<HTMLButtonElement>('.menu-open');
  if (!trigger) return false;
  trigger.click();
  return true;
}

/** Unfold or fold the focused card, if it folds. */
function foldFocusedCard(open: boolean): boolean {
  const toggle = focusedCard()?.querySelector<HTMLButtonElement>('.card-fold');
  if (!toggle || (toggle.getAttribute('aria-expanded') === 'true') === open) return false;
  toggle.click();
  return true;
}

/**
 * `l`: into the card you are on — unfold it if it is folded, otherwise onto
 * its first agent row (the most urgent one; agents are listed that way).
 */
export function enterFocusedCard(): boolean {
  if (onAgentRow()) return false;
  if (foldFocusedCard(true)) return true;
  const card = focusedCard();
  const first = card && !card.matches('.orphans .agent') ? agentRows(card)[0] : undefined;
  if (!first) return false;
  focusInView(first);
  return true;
}

/** `h`: out of an agent row onto its card's title; out on a card, fold it. */
export function leaveFocusedRow(): boolean {
  if (onAgentRow()) {
    const title = document.activeElement?.closest('.card')?.querySelector<HTMLElement>('.card-title');
    if (!title) return false;
    focusInView(title);
    return true;
  }
  return foldFocusedCard(false);
}

/** Keys typed into a field are text, not commands. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
