# Lending

Who has what, in both directions. All of it is the household's business: nothing here reaches a
share page, and a connected household sees only whether a copy is free.

## Loans

**Lend** on an item's page, under Circulation: a borrower, a contact, a due date and a note, and —
when the item is held in more than one form — which copy
([#75](../decisions/075-formats-and-editions.md)). A copy must be free (open loans fewer than copies),
and a Not owned item can't be lent. **Mark returned** on the item's page or on **Loans**. While a
copy is out, the Holding toggle, bulk edit and the edit form refuse to count it as not yours.

**Loans** lists what's out now with each due date and an **Overdue** pill once it has passed — today
being the device's day ([#69](../decisions/069-today-is-the-devices-day.md)) — and the history of
returns; the Overview counts loans out and overdue. An item's page lists under **Lent before** who
has had it, when it went out and came back, and for how many days. Loans to connected households
sit among the rest as "name (their library)".

Every loan, open and returned, leaves in the CSV's `loans` cell and comes back with a Nalanda import
([#57](../decisions/057-every-loan-leaves-export-loans.md)).

## Borrowed from someone

A book borrowed from a friend is in the catalog as Not owned with a borrow record
([#82](../decisions/082-borrowed-from-someone.md)): **Borrowed from**, under Circulation on a Not
owned item — who, a contact, due back when, a note — and **Mark returned** when it goes back. A
**Borrowed** pill shows beside Not owned on the item, on shelves and in search; the shelf's Holding
filter offers **Borrowed from someone**; and **Borrowed**, under Lending, lists what's borrowed from
people, overdue flagged, and what was returned. An item with an open borrow can't be marked owned
until it's returned, and an owned item can't be recorded as borrowed. Private like loans; the CSV
carries a `borrowed` cell shaped like `loans`.

## Between households

Connected households ask to borrow from each other's shared shelves, and a lend is tracked on both
sides: [connections.md](connections.md#borrowing).
