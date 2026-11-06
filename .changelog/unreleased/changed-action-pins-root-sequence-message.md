- **The action-pin scanner no longer reports a root sequence as multiple YAML documents.**
  Root sequences that pass the YAML subset gate now report
  `document must be a mapping` instead of
  `multiple YAML documents are not supported`.
