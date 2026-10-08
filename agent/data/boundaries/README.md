# Search boundary references

`bangkok.geojson` is the Bangkok ADM1 feature extracted, with unchanged coordinates,
from **Royal Thai Survey Department / HDX Thailand administrative boundaries**, as
distributed by geoBoundaries **gbHumanitarian**, boundary ID `THA-ADM1-26819535`.

- Boundary year represented: **2017**. This is a historical reference, not a claim
  that every current administrative or coastal change is reflected.
- Source metadata: https://www.geoboundaries.org/api/current/gbHumanitarian/THA/ADM1/
- Original publisher page: https://data.humdata.org/dataset/cod-ab-tha
- Pinned download: https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbHumanitarian/THA/ADM1/geoBoundaries-THA-ADM1.geojson
- Retrieved: 2026-10-08.
- License: **Creative Commons Attribution 3.0 IGO**,
  https://creativecommons.org/licenses/by/3.0/igo/ .
- Attribution: Royal Thai Survey Department / HDX, via geoBoundaries.
  Inclusion does not imply endorsement of SatGPT by these organizations.
- Processing: extracted one feature; replaced descriptive properties with source
  attribution and search metadata. No geometry simplification, hand-drawn cut,
  latitude cutoff, or removal of interior rings was applied.

Bangkok's OpenStreetMap relation `92277` includes an offshore extension reaching
about 13.2191 N. This reference city polygon reaches about 13.4934 N and has a
geodesic area of approximately 1,571.37 km². It includes central Bangkok and Don
Mueang, excludes Suvarnabhumi Airport and offshore waters, and does **not** represent
the wider Bangkok Metropolitan Region.

Exact city aliases and the matching OSM relation use the reference through the
same resolver for search previews and date/analysis confirmation. District names
and metropolitan-region queries continue through the regular geocoder. Other
OpenStreetMap results are labeled as OpenStreetMap boundaries, not official data.

Only newly searched/resolved scopes are corrected. Previously uploaded, drawn,
edited, or saved scopes are kept as the user supplied them; search and add Bangkok
again to replace an older imported outline.

## Shared boundary safeguards

Search and chat resolution share the same administrative-polygon candidates.
Nominatim address details expose the country and region type; OSM admin levels
are shown as supplied, without assuming the numbering is comparable across countries.
Building/POI/settlement shapes and point-only results are not administrative scopes.
Unclosed rings, non-finite/out-of-range coordinates, self-intersections, empty or
zero-area polygons are rejected. No model-generated outline, bounding rectangle,
automatic geometry repair, or coastline cutoff replaces rejected/missing geometry.

Equivalent duplicates are removed within the same country and administrative
level; distinct city/province/country matches require selection. A single candidate
is not proof that a name is unique worldwide. Search previews, imported scopes and
analysis use the same original polygon vertices, holes and island parts. Imagery
and exports no longer sample boundary vertices automatically. Large AOIs may take
longer or exceed Earth Engine request limits; use a smaller, explicitly chosen AOI
if that happens. OSM search cache entries expire after one hour.

These checks establish geometric validity, not legal/geographic correctness or
current administrative status. OSM results remain community data and may include
territorial seas; a complete administrative extent is not necessarily a land-only
flood scope. Use a versioned, attributed land reference where available (currently
Bangkok), or upload a suitable administrative/land polygon for the region. Add future
references by exact aliases and stable identities, with source, vintage and license;
never apply a city polygon to districts or metropolitan regions by substring.
