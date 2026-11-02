# Database notes: availability and idempotent booking

## The problem being solved

Two customers can ask for the same slot at the same moment, and a workflow
can time out after writing a booking but before hearing back, then retry.
Either case must never produce two bookings for one slot. This is handled in
the database, not in workflow logic, because the database is the one place
every writer has to pass through.

## The two guards

1. **No overlapping confirmed bookings, ever.**
   `bookings` carries an exclusion constraint: for one tenant, the time
   ranges of rows with status `confirmed` may not overlap. Postgres checks
   this inside the insert itself, under the same lock as the write. A second
   writer for the same slot gets an error, not a silent success. Cancelled
   and rescheduled rows are excluded from the constraint, so a freed slot
   can be booked again. This is also why `starts_at` and `ends_at` are full
   timestamps: durations differ per service, and the range is what matters.

2. **A retried write returns the same booking.**
   Every booking write carries an `idempotency_key`, unique per tenant. The
   booking workflow builds the key after the customer confirms, by hashing
   the confirmed facts: tenant, lead, service, start time. The insert uses
   `ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`, so a retry finds
   the first write and the workflow reads back the existing booking id and
   tells the customer the booking is confirmed, once.

## How the state machine uses them

- `check_availability` runs the NOT EXISTS query from `schema.sql` before
  offering a slot to the customer. This is a courtesy check for the
  conversation; it narrows the choices but is not the guarantee.
- `write_booking` runs the idempotent insert. Two outcomes are normal:
  - The insert succeeds, or it matches the idempotency key: booking stands.
  - The exclusion constraint rejects it because someone else took the slot
    between the check and the write: the workflow goes back to the customer
    with the next free options. No error reaches the customer as an error;
    it is just "that time just got taken".

## Tenant isolation rule

Every query in every workflow includes `tenant_id` taken from the incoming
message envelope, never from anything the customer typed. Rows are never
fetched across tenants and filtered later. The exclusion constraint and the
unique indexes are also scoped by tenant, so one business's data can never
block or leak into another's.

## Follow-ups and summaries are idempotent too

- `followups` allows only one row with status `scheduled` per lead
  (partial unique index). Scheduling a nudge twice is a no-op the second
  time. When the nudge is sent, the row moves to `sent` and a new one may
  be scheduled later if the lead goes quiet again.
- `summaries` is unique on (tenant_id, summary_date). The evening summary
  cron can be re-run safely; it rewrites that day's row instead of sending
  a duplicate summary.
