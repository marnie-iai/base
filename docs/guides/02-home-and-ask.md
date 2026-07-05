# Home and Ask

The home page is the hub: the Ask bar up top, four navigation tiles, and a
file search underneath.

## The Ask bar

Type a natural question and press Enter or Ask. Base works out which KB
folders are relevant, reads the most useful files (favouring recent session
intel and briefs), pulls live data where the question calls for it, and
returns a synthesised answer with sources.

Two kinds of source feed an answer:

- **KB files**: routed by the words in your question. Mentioning an agent
  (Reid, Dev, Scout...), a project or client (HIF, ICS, TMM, iOps, Clear
  Ground...), or a document type (brief, protocol, decision, handover...)
  steers Base to the right folders. Mentioning an agent also pulls their
  latest session intel, so "what is Harlow working on" surfaces current
  context, not just old briefs.
- **Live data**: questions about the sprint board (cards, gates, blocked,
  status, "what's on") or pursuits fetch the current state from the Grid API
  at the moment you ask. Live data outranks KB files for current-state
  questions.

Every answer lists its sources as chips underneath. Click a chip (or a
filename inside the answer) to open that document in the reader.

### Follow-ups

After the first answer the bar becomes a chat. Follow-up questions carry the
recent conversation for context, but Base routes to KB folders using only the
new question, so name the agent or project again if you switch topics.

- **New** clears the conversation and returns to the single bar.
- **Export** downloads the whole conversation as a markdown transcript.

### Tips

- Name names. "What is Reid's latest brief" beats "what's the latest brief".
- One topic per question routes better than a compound question.
- If Ask says search is not configured, the server is missing its Anthropic
  key; the rest of Base still works.

## The nav tiles

Four tiles under the hero: Pursuits (with a live count of active pursuits),
Dashboards, Agents (with a live roster count), and Image Library. See the
matching guides for each.

## The file search

Below the tiles is a direct search over the KB repo. Type two or more
characters and results drop down as you type, showing the filename, its KB
path, and a file-type badge. It matches file contents as well as names
(GitHub code search), so a distinctive phrase works when you cannot recall
the filename.

Clicking a markdown result opens it in the Base reader; other file types open
on GitHub. Use the file search when you know roughly what document you want;
use Ask when you want an answer rather than a file.
