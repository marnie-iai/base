# Reading documents

Base has an in-app reader so KB documents read like documents, not like raw
files on GitHub. Anywhere Base lists a markdown file (Ask sources, file
search, agent pages), clicking it opens the reader.

## The reader (/read)

The reader fetches the file live from the KB and renders it with:

- **A clean title**: version numbers, dates, and filing prefixes are stripped
  from the filename for display.
- **Register-aware styling**: founding and protocol documents, agent prompt
  docs, and technical documents each get their own typographic treatment, so
  you can tell a doctrine page from a dev brief at a glance.
- **Breadcrumb**: which point of the KB the document lives in, plus its
  subfolder.
- **Last updated**: the date of the file's most recent commit to the KB.
- **Progress bar**: a thin bar along the top tracks how far through the
  document you are.
- **Download**: markdown and text files have a download button in the header.
- **Previous / Next**: at the foot of the page you can step through the other
  markdown files in the same KB folder without going back to a listing.

The nav bar at the top has a search box; press Enter to run your query back
on the home page file search.

## HTML documents (/view)

Interactive HTML files in the KB (style guides, prototypes, dashboards filed
as HTML) do not go through the reader. They render full-page exactly as
built, with a slim Base nav bar injected at the top so you can get back. If
you land an HTML file in the reader it redirects to the full-page view
automatically.

## Other file types

- Plain text files render in the reader as a code block.
- Anything else (PDF, images, spreadsheets) opens on GitHub in a new tab,
  where GitHub's own viewers take over.

## If a document will not load

The reader reads the KB live, so a load failure usually means the path
changed (the file was renamed or moved in the KB) or the file is very new and
the five-minute cache has not caught up. Re-find the file via the home page
search rather than editing the URL.
