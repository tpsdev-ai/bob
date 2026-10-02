- **`apply_patch` refuses a candidate directory that is a symlink, and leaves no
  temporary record behind.** A pre-existing `candidates` symlink under the
  tool's state root (for example into the caller's checkout) refuses with
  `storage_failed`; the record is written and renamed through the descriptor of
  the verified directory, so a pathname swapped in after that check is not
  written through, and a failed rename removes the temporary record.
