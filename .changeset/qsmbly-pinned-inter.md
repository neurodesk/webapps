---
"qsmbly": patch
---

Load Inter from `css/inter.css`, which names the Google Fonts v20 WOFF2 files directly, instead of the `fonts.googleapis.com` stylesheet, whose response can change. The page now loads one variable-weight file per script subset.
