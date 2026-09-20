# @neurodesk/vessel-surfer-easter-egg

## 0.1.20260921

### Patch Changes

- 4c1413b: Vessel Surfer: on a computer the game is steered with the keyboard only, so the mouse no longer aims and can reach the speed slider; on a phone it is steered by tilting (roll to turn, lean to pitch, tap to recentre), with the drag joystick kept only as a fallback when motion sensors are unavailable.

## 0.1.20260920

### Patch Changes

- 4b9d996: Vessel Surfer: the challenge route is now the longest flyable path from the launch point (33.6 mm instead of 12 mm, new challenge id `pial-arteries-v2`); points are a speed score (80,000 ÷ seconds) minus a wall penalty (400 per bump), both shown on the finish screen; the cruising speed (0.25× to 3×) is adjustable mid-run from an on-screen slider, + / − keys or the mouse wheel; the map shows the whole brain by default; the menu overview fits the whole brain beside the panel; and a sub pinned against a wall is steered free by the lumen assist. The leaderboard worker's minimum run time rises to 8 s for the longer route.

## 0.1.20260919

### Patch Changes

- 532c0a5: Vessel Surfer: a one-key U-turn (R or the Turn button), a live 3D overview map drawn from the real vessel surface with route and whole-brain framing, a gold runway-light trail plus an on-screen destination marker, no more black walls when pinned against the lumen, a 0.5× default cruising speed, and scoring explained in the menu and on the finish screen.

## 0.0.20260919

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.3.1
