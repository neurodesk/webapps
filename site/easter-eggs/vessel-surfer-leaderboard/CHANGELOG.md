# @neurodesk/vessel-surfer-leaderboard

## 0.1.20260921

### Patch Changes

- Remove custom vessel-mask uploads and their parser, worker, practice mode and tests. Save completed zero-point runs on every leaderboard, including Grand Tour. Keep failed saves retryable, report local persistence accurately, and prevent stale leaderboard reads or track changes from overwriting submission results. Cover Grand Tour submission with the actual server handler, including retry and reload.

## 0.1.20260920

### Patch Changes

- 7e4f0ae: Vessel Surfer: four selectable tracks (Trunk run, Sprint, Grand tour, Narrows), each a fixed route through the pial artery graph with its own leaderboard, points scale and minimum plausible time; the route is marked by flat gold arrows on the vessel wall that point the way, replacing the floor spheres, and the straight-line destination pointer is gone because it pointed through walls.

## 0.1.20260919

### Patch Changes

- 4b9d996: Vessel Surfer: the challenge route is now the longest flyable path from the launch point (33.6 mm instead of 12 mm, new challenge id `pial-arteries-v2`); points are a speed score (80,000 ÷ seconds) minus a wall penalty (400 per bump), both shown on the finish screen; the cruising speed (0.25× to 3×) is adjustable mid-run from an on-screen slider, + / − keys or the mouse wheel; the map shows the whole brain by default; the menu overview fits the whole brain beside the panel; and a sub pinned against a wall is steered free by the lumen assist. The leaderboard worker's minimum run time rises to 8 s for the longer route.
