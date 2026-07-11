import { CHARACTER_LIMIT } from "./constants.js";
import { Card } from "./types.js";

export function formatCardsMarkdown(board: string, cards: Card[]): string {
  if (!cards.length) {
    return `No cards found on board '${board}' matching these filters.`;
  }
  const lines = [
    `# Board: ${board} (${cards.length} card${cards.length === 1 ? "" : "s"})`,
    "",
    "| cardId | status | priority | owner | title |",
    "|---|---|---|---|---|",
  ];
  for (const c of cards) {
    const id = c.cardId ?? c.id ?? "?";
    const title = String(c.title ?? "").slice(0, 70).replace(/\|/g, "/");
    lines.push(`| ${id} | ${c.status ?? ""} | ${c.priority ?? "-"} | ${c.owner ?? "-"} | ${title} |`);
  }
  return lines.join("\n");
}

export function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= CHARACTER_LIMIT) {
    return { text, truncated: false };
  }
  const cut = text.slice(0, CHARACTER_LIMIT);
  const message =
    `\n\n...truncated at ${CHARACTER_LIMIT} characters. Narrow with 'status' or ` +
    `'owner' filters, or request response_format='json' and page through the results.`;
  return { text: cut + message, truncated: true };
}
