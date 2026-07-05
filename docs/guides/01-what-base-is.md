# What Base is

Base is IAI's internal knowledge layer, at base.integratedai.com.au. It is
the one place to ask how IAI works and see what is moving: KB documents, the
agent roster, pursuit constellations, and the campaign dashboards.

## The three systems

Base sits alongside two other systems and does a different job to both:

- **Base** is the platform, the operating window. It stores almost nothing
  itself; everything on screen is fetched live from the sources below.
- **KB** is what IAI knows and produces: briefs, decisions, brand, session
  intel, published work. It lives in the private marnie-iai/kb GitHub repo,
  and Base is the comfortable way to read it.
- **Vault** is what IAI learns from the outside world: external intelligence
  only.

If you are looking for a document, it is in the KB and Base will find it. If
you are looking for live work state, Base pulls it from the Grid API. Base
itself is never the source of truth for content.

## Where the content comes from

- KB documents, images and search results: the marnie-iai/kb repo, read live.
- Agent roster and portraits: the roster document in the KB plus the
  agent-portraits repo.
- Pursuits and sprint data: the Grid API (the same data behind Grid.IO).
- Dashboards: Google Sheets fed by the Make scenarios.

Because reads are cached briefly, a KB edit appears on Base within about five
minutes, and a roster change within about ten.

## Signing in

Base uses a browser password prompt (HTTP Basic). Enter anything as the
username and the site password as the password; the browser remembers it for
the session. The Dashboards area asks for a second password the same way.
There are no accounts or user profiles.

## Installing as an app

Base is installable as an app (Add to Home Screen on iOS, Install in Chrome).
It opens full-screen with the navy Base theme. It still needs a connection;
Base does not work offline.
