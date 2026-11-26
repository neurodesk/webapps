# brainqcnet instructions

- The preprocessing, slice classification loop, summaries and CSV writers live in `packages/brainqcnet`; the app adds the UI, the ONNX Runtime Web worker (one per run, terminated on cancel) and the file names. Change numerics in the package only.
- `e2e/workflow.spec.js` runs each example on WebAssembly and requires every table to equal the original container's (`packages/brainqcnet/validation/references`) byte for byte, except tot_df.csv's `t`, the processing time. The still example is the untagged run (3.4 minutes on 8 cores, longer on hosted runners); the motion example is `@slow`.
- The app has no command line of its own: the Standalone dialog lists the authors' `garciaml/brainqcnetcpu` image at tag 1.0.1 (`registry/standalone-exceptions.json`); the validation pins its digest. The deployed-site check rejects a digest in the dialog.
