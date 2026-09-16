# DICOM comparison example

The example contains the complete 120-instance `VS-SEG-001` T1 series published
in [NiiVue's demo images](https://github.com/niivue/niivue-demo-images), pinned
to commit `f6f98294c1fa89a3a32e8a44eab92368374150a0`. The app downloads the
unchanged files from `neurodeskorg/webapps` at Hugging Face commit
`560955bf9a1a669bbf2a89709b64f3e64eefe008`, under
`examples/dicompare/t1-dicom-protocol/`. The series is about 63 MB.
The DICOM metadata identifies a Siemens Avanto scanner and protocol
`t1_mpr_tra_gk_v4`; the public sample uses pseudonymous patient identifiers.

The ordinary DICOM parser imports the series as a reference acquisition. The
same files are then attached as test data to provide a matching baseline.
Users can inspect matching fields and use Print to save a comparison report.
Detach the test data before editing reference parameters, then attach a
user-supplied series to compare a different acquisition. This exercise demonstrates
protocol comparison; matching a copy of the same data is not evidence of
clinical protocol compliance.

Cancellation after parsing begins discards its pending workspace update.
The parser itself runs to completion before it can accept another import.
