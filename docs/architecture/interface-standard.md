# Interface standard

Apply this standard to every existing and new Neurodesk webapp. Scientific workflows can differ; navigation, disclosure behavior and basic controls should remain familiar across apps.

## Navigation ownership

The shared app bar owns the app identity, version, About, Cite, Privacy, theme switch, More Apps and app source link. Keep one visible bar in each screen. Avoid repeating these actions in the sidebar or footer. Apps that distribute a command-line package may also register an optional Standalone action in the same bar; put its installation and run instructions in the dialog it opens rather than in the workflow sidebar.

Keep scientific About and citation content. Connect its existing handler with `controlsContract` in `mountImagingWorkspace`, or `data-neurodesk-control="about|cite|privacy|standalone"` in static HTML. The shared bar invokes that handler; the hosted theme hides its original trigger. Standalone appears for every app and uses the shared, verified release catalog. Mark legacy catalog/source links with `data-neurodesk-shell-link` so the shell can hide them while standalone apps retain navigation. Links to particular methods or dependencies inside explanatory content are legitimate references.

Information dialogs opened from the shared bar must use a centered, viewport-bounded panel with a visible title and close control, following QSMbly's modal geometry. The shared fallback dialog supplies this behavior; app-owned dialogs must preserve it when providing richer content.

## Workflow and space

- Open the input section and the controls needed for the current task. Start advanced settings, supplementary inputs, detailed logs and unavailable results collapsed. Keep their section titles visible so users can find them.
- Show the primary action beside its relevant inputs. Use specific labels such as "Run segmentation" or "Save image". A button to choose files and a button to choose a folder are distinct input methods.
- Expand results when processing completes, and reveal validation errors with the field that needs attention. Preserve chosen files, field values and viewer state across disclosure changes. Do not close a section while the user is editing it.
- Keep short help beside the relevant field. Put extended methods, credits and tutorials in About or a help disclosure. An example gallery should not push the first input below the initial phone screen.
- Size controls to their content using shared spacing tokens. Avoid fixed-height cards, spacer elements, large empty drop zones and nested decorative panels. Give spare space to the image viewer. A blank viewer before import is not itself wasted layout space.
- Keep ready/running/error status visible. Put the full technical log behind a disclosure. Allow users to reopen completed workflow steps.

QSMbly demonstrates the default grouping: keep input available and reveal later steps as they become usable.

## Components and interaction

Scan uploads use one compact file field for NIfTI and DICOM, with `multiple` and no `accept` filter so extensionless DICOM instances remain selectable. Route all slices of a series together through the local converter. Preserve NIfTI loading, offer a series selector or a clear one-series validation error when several scans are selected, and retain folder picking as an optional input method. Use `readImageFiles` from runtime-support for bundled apps or `readSingleImage` from shared file-io for single-image static workflows. Keep specialized scientific parsers where their metadata is required.

Mark every file input with `data-neurodesk-input="image"` for scans. Specialized inputs use `model`, `surface`, `protocol`, `gradients`, `metadata`, or `dataset`. These describe actual input semantics: a per-vertex surface overlay is not a scan, and protocol inspection requires acquisition metadata unavailable in NIfTI. The interface audit rejects unclassified fields and restricted scan pickers. Verify conversion with DICOM data; removing the picker filter alone does not implement support.

Use the registered shell adapter and shared imaging layout when they fit the workflow. Use shared design tokens for color, type, spacing, borders and focus treatment. Fix a repeated layout problem in its shared owner instead of adding app-ID CSS branches.

For new collapsible groups, use native `details` with a `summary`, or `renderSidebarSection` from `@neurodesk/webapp-components/ui`. Set `collapsed: true` for secondary groups. Its returned `root` is an `HTMLDetailsElement`; change `root.open` when a workflow needs to reveal it. Native disclosure removes closed contents from keyboard navigation without recreating the controls. Existing class-driven workflows use `bindSectionDisclosures` with `data-disclosure`, a native `data-disclosure-toggle` button, and a `data-disclosure-panel`. Keep a unique section ID. The binding synchronizes the existing `collapsed` and `step-disabled` classes with expanded state and hidden or inert content. This preserves workflow-driven expansion without recreating inputs. Custom framework disclosures must provide the same keyboard and focus behavior.

At phone widths, stack controls or use clearly labeled tabs. Keep the viewer and primary action reachable. Allow scrolling within genuinely wide tables, not across the whole page. Touch targets must be at least 44 by 44 CSS pixels; text-entry controls must use at least 16px text on touch devices. Keep field labels and visible keyboard focus.

## Examples

Every app declares a nonempty `apps/<id>/examples.json` array. There is no legacy exemption. Each example contains `id`, `label`, `description`, `expectedResult`, and `files`. Each file declares a semantic `role`, a unique filename `name`, and its pinned `url`. Multi-input workflows declare complete bundles, including gradients, acquisition metadata, masks, or reference images as needed. Explain what users can do with the result. A screenshot, model file, or link to browse an archive is not a runnable example.

Use suitable, de-identified data at a commit-pinned URL in the `neurodeskorg/webapps` Hugging Face dataset. Register every URL and its checksum in both offline inventories. `TMPDIR=/storage/tmp node scripts/lock-example-assets.mjs` fetches missing assets, verifies declared checksums and updates the inventories. Downloads stay outside the source repository. Keep phantom generators as source code, export their data outside the repository, and publish their files in the same pinned dataset. Synthetic examples use the same nonempty `files` contract as other examples. Label them **Synthetic** and state their limits. A synthetic software demonstration does not establish model accuracy.

Render one `renderExampleSelector` from `@neurodesk/webapp-components/ui` in the open input section. It supplies the **Example** label, `select[data-neurodesk-example]`, loading status, Cancel, and retry behavior. Do not build another picker or load examples automatically on startup. The shared component owns downloads and aborts. The app's `onLoad(example, { signal, fetchFiles, assertCurrent })` imports the bundle through its normal input path, preserves the chosen algorithm, and resolves only after usable inputs are loaded. Call `assertCurrent()` after asynchronous preparation and before committing input state. Propagate failures. Selection enables the next action without automatically processing. For a viewer, opening the dataset is the action. Dispose the control when the app unmounts.

The shared control resets its selection so users can retry or load the same example again. Uploading a replacement cancels an active example and clears its identity. Keep old results from becoming downloadable under a new input. Apps remain responsible for cancelling or serializing their own asynchronous import work.

Keep `ci.browser_test: true` and a runnable `test:e2e` script. The interface audit requires exactly one visible, labelled shared selector, matching manifest options and successful first-example import on desktop and phone. It no longer assumes every scientific workflow has `#fileInfo` and `#runButton`. App-specific tests must also select an example, perform the real main action and verify a useful output or download. Test cancellation, failed downloads and retry. Exercise hosted bytes as well as mocked failures; a fixture-only test cannot prove real data suitability.

The generator uses the same component and manifest. Replace its T1 sample when the app's science needs another kind of data. Review scientific fit and expected results when adding or changing an example.

## Completion check

1. Build the changed apps and assemble the site with `pnpm build`. The audit reads `dist`, so stale bundles invalidate the result.
2. Run `INTERFACE_ARTIFACTS=/storage/tmp/interface-audit pnpm audit:interfaces`. It derives all apps from the canonical registry, enters their workspaces, saves screenshots and JSON, and checks desktop and phone navigation plus native and class-driven disclosure keyboard behavior.
3. Run `pnpm test:mobile` for narrow phones, tablets and landscape layouts. This also checks touch navigation and representative imaging interactions.
4. Inspect the screenshots. Check what appears before import, how far users scroll to the first input and primary action, and whether optional controls deserve their default space. Check light and dark themes for the changed controls.
5. Run `pnpm test:interface-workflows` for the shared workflow checks and `pnpm test:image-uploads` when changing scan inputs. Drive the changed workflow with data. Collapse and reopen an edited section, verify its values remain, and check that errors and results are discoverable. Record the action and outcome in the change description.

CI rejects duplicate navigation labels outside the app bar, clipped navigation, missing or multiple bars, mouse-only disclosure headings, and broken disclosure keyboard toggles. Every app has zero allowance for legacy heading handlers. The checks also verify that class-driven disclosures retain field values. CI uploads screenshots and audit JSON, runs representative data workflows, and enforces the mobile layout and touch checks. Automation does not judge wording, visual density, every custom interaction, or scientific correctness. Review those explicitly.

New apps start from `pnpm new-app <id>` and the canonical [`templates/app-template`](../../templates/app-template). The template uses `neurodeskViteConfig` for the development shell and `theme-app-dist.mjs` for standalone builds, so local development and deployment share one theme path. Replace its scientific placeholders; do not copy another app's chrome or styles. The template is executable source and is not duplicated in the documentation.
