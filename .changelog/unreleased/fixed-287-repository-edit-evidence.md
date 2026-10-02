- **Repository changes count as verified edits.** The completion gate compares
  Git state with launch: a newly reachable commit or a changed tracked diff hash
  counts alongside file-edit tool evidence. The exploration budget uses the same
  predicate between tool results. Submodule gitlinks count; untracked files and
  submodule dirt do not. Git failures supply no repository evidence. Closes #287.
