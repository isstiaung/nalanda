# Decisions

The architecture decision log: one file per decision, numbered in the order it was made, and
indexed in [ARCH.md §16](../../ARCH.md#16-decision-log). The number is the address: code, tests,
CLAUDE.md and the docs cite a decision as `ARCH.md §16 #N`, and the index resolves it, so nothing
that cites a decision changes when one is added or amended.

- **Adding one:** take the next number, write `NNN-slug.md` with the same heading and "Decided"
  line as the others, then the decision — what was decided, why, what it rules out, which ARCH.md
  sections it touches — and add its row to the index.
- **Amending one:** edit its file and date the amendment. Never renumber, never reuse a number.
- Inside a decision, "§N" is a section of ARCH.md and "#N" another decision in this folder.
