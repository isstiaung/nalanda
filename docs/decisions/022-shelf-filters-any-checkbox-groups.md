# §16 #22 — Shelf filters are any-of checkbox groups

**Decided:** 2026-07-19 (went live). Cited as `ARCH.md §16 #22`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

(type, status, holding), not
single-value selects: params repeat (`?type=book&type=vinyl`), `listItems`
takes arrays (`inArray`), values OR within a dimension, dimensions AND
together. "Holding" is two checkboxes (Owned / Logged — not owned) over the
same tri-state `owned` param: exactly one checked filters; both or neither
means no filter — old single-value URLs keep working. The `shares` schema
still captures **one value per filter**, deliberately: public views should
be simple, stable scopes, and widening those columns to arrays would ripple
through `itemMatchesShare` for no household need. "Publish current view"
captures a dimension only when exactly one value is selected; the preview
line states that a multi-selection publishes as "all".
