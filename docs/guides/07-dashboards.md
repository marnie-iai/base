# Dashboards

The Dashboards area (/dashboards) holds the live analytics pages. It sits
behind a second password: after the Base site prompt, the browser asks again
the first time you open a dashboard (any username, the dashboards password).

## The four dashboards

| Dashboard | What it shows |
|---|---|
| Industrial AI Index | Gate completion rates, archetype distribution, and user activity for the Index diagnostic |
| Clear Ground Campaign | Website traffic, conversion events, and the GA4 funnel for the Clear Ground campaign |
| Clear Ground Metrics | Campaign KPIs: reach, engagement, and the lead pipeline |
| IAI Website Analytics | Sessions, page performance, and traffic sources for integratedai.com.au |

The index page lists them as cards; each opens as its own full page with a
back link to the index.

## Where the numbers come from

The dashboards read from Google Sheets that the Make scenarios keep updated
(GA4 exports, Index completions, campaign trackers). A dashboard is therefore
only as fresh as its feeding scenario: if a number looks stale, check the
Make scenario and the sheet before suspecting the dashboard.

Most figures are fetched when the page loads, so a refresh pulls the latest
sheet values. The Index completions summary comes through a Base endpoint
that caches for ten minutes.

## If a dashboard shows no data

- A placeholder row mentioning env vars means the server is missing its
  Sheets configuration.
- Empty charts with the page otherwise fine usually mean the source sheet
  moved or the feeding Make scenario has stopped; check the scenario run
  history.
- If the second password prompt loops, the dashboards password has changed;
  clear the saved credentials and re-enter.
