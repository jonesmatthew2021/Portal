TSV COOLIBAH CREW PORTAL — COMPLETE COPY
============================================================

Taken:            23/08/2026, 10:37:41 am
Portal state:     revision 342
Files:            1421 of 1421 downloaded

WHAT IS IN HERE
------------------------------------------------------------

source/
    Every file the portal is built from — the front end, the Netlify
    functions behind it, the database schema and its migrations.
    index.html is the live page as served at the time above (931 KB).
    The rest was packaged on 2026-08-22 by scripts/build-archive-source.mjs.

documents/
    Every file anyone has uploaded, laid out the way the portal files
    them: certificates under certification/<person>/, the matrices under
    matrices/, handover notes under notes/<swing>/<rank>/, and so on.
    Anything taken off the portal but not destroyed is under removed/ —
    those are superseded or withdrawn, not current.

documents/index.json
    What the portal knows about each of those files: who filed it, when,
    which crew member and matrix code a certificate answers to, its expiry
    date, and its checksum.

portal-state.json
    Everything the portal holds that isn't a file — the roster, the swing
    pattern, handover notes, correspondence, comments, suggestions, the
    crew matrix and the change log.

PUTTING IT BACK
------------------------------------------------------------

This is a copy to keep, not a backup the portal can restore from on its
own. The source rebuilds and redeploys as it is. The documents and the
state would have to be uploaded again through the portal.

Treat the whole archive as internal — it is every crew certificate and
every note on the portal, in one folder.
