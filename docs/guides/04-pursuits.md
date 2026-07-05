# Pursuits

A pursuit is a named constellation of work for a specific context: iOps, the
Hunter Innovation Festival, Project Compliance, Engage, and so on. Base reads
the pursuit registry live from the Grid API; nothing about pursuits is stored
in Base, so what you see here always matches Grid.

## The pursuit index (/pursuits)

Every registered pursuit as a card: code, name, status, client where there is
one, description, and a link through to its board where one is registered.
The subtitle shows the total count, and the filter buttons narrow the list by
status (for example active or closed). The count on the home page Pursuits
tile is the number of pursuits not closed or complete.

Click a card to open the pursuit's detail page.

## A pursuit's page (/pursuits/CODE)

The page takes its accent colour from the pursuit's registered board colour,
so iOps, HIF and PC each look like themselves. It shows:

- **Header**: the pursuit code, status badge, full name, client, and
  description.
- **Meta strip**: start date, end date, and API path where registered.
- **Pursuit button**: a direct link to the live board on Grid.IO, opening in
  a new tab.
- **Constellation**: every member of the pursuit team with portrait, name,
  and their role in this pursuit. Click a member to open their agent page.

## Keeping it accurate

Pursuit facts (status, members, dates, colours) are owned by the Grid API.
To change what Base shows, change the registry in Grid; Base picks it up
within about five minutes. If a pursuit page says not found, the code is not
in the Grid registry.
