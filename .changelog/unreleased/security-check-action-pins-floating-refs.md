- **The action pin check reports floating refs.** Remote action references in
  workflows and composite actions must use a full 40-character commit SHA; a
  branch, tag or short SHA is now an error naming the file, line and action.
  Local `./` actions and `docker://` images are out of scope and skipped.
