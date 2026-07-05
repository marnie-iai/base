# Agents

Base shows the IAI agent team two ways: the roster overview and a
constellation page per agent.

## Where the roster comes from

The roster is not typed into Base. It is parsed live from the agent roster
document in the KB, so the KB roster file is the single source of truth:
update it there and Base reflects the change within about ten minutes. Each
agent's portrait comes from the agent-portraits repo
(`{Name}_headshot.png`); an agent without a portrait shows their initials
instead.

## The roster page (/agents)

A portrait grid of every agent, grouped by point: Business, Workshop, Family,
Operating Protocols, Resource, and Foundations. Each card shows the agent's
name, role, and a status badge:

- **Live**: deployed and operating.
- **Active**: in use, not fully deployed.
- **Planned**: defined but not yet built.

Click any card to open that agent's constellation page.

Known issue: the `/agents` URL is currently affected by a routing regression
(it re-serves the home page instead of the roster). The page itself is built
and returns as soon as the route is restored; agent constellation pages at
`/agent/name` work regardless.

## An agent's constellation page (/agent/name)

Everything Base knows about one agent, assembled live:

- **Header**: portrait, point, status, role, and who they report to (linked).
- **Identity**: the agent's prompt doc from the KB agents folder, newest
  version featured, older versions collapsed underneath.
- **Briefs**: KB documents that mention the agent and look like work product
  (briefs, specs, handovers, inductions), up to twelve.
- **Pursuits**: the pursuit constellations the agent belongs to, with their
  role in each, linked to the pursuit page.
- **Related agents**: same point, their chief, or their direct reports.

Markdown documents open in the Base reader; everything else opens on GitHub.

## Keeping it accurate

- New agent, changed role, changed status: edit the roster document in the
  KB. No Base change needed unless the roster moves to a new file version,
  which requires a one-line server update.
- New prompt doc: file it to the KB agents folder with the standard
  `prompt-name` naming and it appears under Identity automatically.
