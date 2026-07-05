# Image library

The image library (/images) is a masonry grid of the image assets that live
in the KB: brand marks, campaign graphics, product imagery, website assets,
and content images.

## What it shows

Base scans a fixed list of KB folders for image files (png, jpg, jpeg, gif,
webp) and lays them out as a filterable wall. Agent headshots are excluded;
they belong to the roster, not the asset library.

The scanned folders cover each KB point (Foundations, Business, Workshop,
Family, Resource, Ikigai) plus the Drive-synced image folders
(`kb/images/hif`, `kb/images/brand`, `kb/images/website`,
`kb/images/content`), which a Make scenario populates from Google Drive.

## Filtering

The filter bar across the top groups images by where they live: the
Drive-synced folders appear as HIF, Brand, Website and Content; everything
else is grouped by its KB point. All shows everything.

## Opening and using an image

Hover to see the filename and its group. Click an image to open the file on
GitHub, where you can download the original. Thumbnails are streamed through
Base itself (the KB repo is private, so a plain GitHub image link would not
render).

## Adding images

There is no upload on this page; the library shows what is in the KB. File
new images via Clio to one of the scanned folders, or drop them in the Drive
folders that the Make sync covers. Images filed to a folder the library does
not scan will not appear; the folder list is maintained in the page itself,
so a genuinely new image location needs a small code change.

Known issue: the `/images` URL is currently affected by a routing regression
(it re-serves the home page instead of the library). The page itself is
built and returns as soon as the route is restored.
