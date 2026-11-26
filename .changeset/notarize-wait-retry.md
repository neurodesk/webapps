---
'@neurodesk/desktop': patch
---

Resume polling an existing Apple notarization submission with `xcrun notarytool wait` (and then staple) when a transient network or 5xx error interrupts `notarytool submit --wait` and the failure output includes the submission ID, without ever submitting the app twice. Also prevent the notarization alert reporter from treating transient `notarytool` transport/5xx errors as Apple refusals.
