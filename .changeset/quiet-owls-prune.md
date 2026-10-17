---
"dicompare": patch
"qsmbly": patch
"calmar": patch
"spinalcordtoolbox": patch
"@neurodesk/deface": patch
---

Remove verified dead code from the unused-code report (#256): dicompare's unused technical-log helpers, QSMbly's duplicate `QsmEchoViewer` export and Deface's unused `@neurodesk/webapp-components` devDependency. The calmar and SCT task tests now import the modules they check by literal path.
