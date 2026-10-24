# DWI2TRX device-loss investigation

Issue [#598](https://github.com/neurodesk/webapps/issues/598) reports Intel/Mesa
Vulkan device loss during tracking of real DWI. The smaller pinned 21-volume
example succeeds on the same host. The cause remains unconfirmed.

The provisioned hardware regression in `apps/dwi2trx/e2e/real-data.spec.js` uses
Philips ds007522 sub-HML0001 ses-01 from the immutable URLs, byte sizes and SHA-256
pins in `validation/dwi-vendors/sources.json`. It takes the central 72×72×39 crop
(origin 28,28,15) of the 128×128×69 grid, retaining all 136 frames. This matches a
reported failing **shape**; the report does not specify its crop origin. There is
no resampling. Values use the same scaled float32 representation the app reads;
the translated oblique affine and original gradient table are retained.

The crop requires about 110 MB of signal storage, rather than the full source's
615 MB. Passing this test does not establish full-size input support. CI provisions
it through `DWI2TRX_REAL_DWI_DIR` on the hardware-GPU runner. The test requires all
selected seeds to complete, rejects capped or truncated results, validates finite
TRX coordinates and output counts, rejects unexpected device loss, and performs
fresh device buffer IO afterward. The app intentionally destroys its private
tracking device when processing ends; that explicit destruction is allowed.

No shader or RNG behavior has changed. Source review found bounded tracking loops,
a fixed 32-lane subgroup assumption, removed subgroup barriers, and an unused
shader RNG-offset parameter. These are investigation candidates, not an established
explanation of the failure. Before changing output behavior, identify count versus
generation dispatch failure and measure the actual subgroup width/mapping on the
reporter's Intel host. WGSL does not guarantee a 32-lane subgroup or a mapping from
local invocation IDs to subgroup lane IDs:
[WGSL §15.5](https://www.w3.org/TR/WGSL/#subgroups).

The regression is prepared; a completed Metal run and an Intel diagnostic run are
still required. No success is inferred from test registration alone.
