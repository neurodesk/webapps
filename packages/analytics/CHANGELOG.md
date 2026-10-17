# @neurodesk/analytics

## 0.0.2

### Patch Changes

- b547723: Skip page views from automated browsers.

## 0.0.1

### Patch Changes

- Fix page-view collection by queuing gtag commands as arguments objects. Google ignored the previous array commands, leaving the published usage statistics at zero.
