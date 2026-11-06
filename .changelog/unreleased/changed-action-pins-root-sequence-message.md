- **The action-pin scanner refuses a root sequence as a non-mapping document.**
  A workflow or action file whose root is a YAML sequence is now reported as
  `document must be a mapping`, like other non-mapping roots, instead of
  `multiple YAML documents are not supported`.
