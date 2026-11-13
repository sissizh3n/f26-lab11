# EVENTS.md

One section per milestone. Fill each one in order as you go.

The prediction in milestone 2 should be written before you run the replay. That is the
part a TA will ask about.

Keep it short and specific. Point at operations, call sites, and what a caller
gets back.

---

## Milestone 1: what runs in the request path, and what runs after it

### The operations table

One row per operation. Read the code, not the file
names. "As wired today" is what the code does now. "Your call" is what you
would do if this were your service. List up to eight operations, and remove
the rows you don't use.

| # | Operation | As wired today | Your call | Why (in one line) |
|---|---|---|---|---|
| 1 | Update the search index for a new booking | In the request path: `book()` calls `searchIndex.indexBooking` directly (bookingService.ts:94), before `store.save`. | Subscribe an indexer to `booking.confirmed` so a failure becomes a dead letter and the booking still succeeds. | Booking save and room-finding are separate features and do not inherently need to depend on each other; book()'s main role is saving the booking and the index can catch up later. |
| 2 | Record nightly sweeps and booking created/cancelled/requested. | In the request path: `book`, `cancel` in `bookingService`, and `run` in `cleanupSweep.ts.` | Decouple & add audit subscriber, practice information hiding. | 3 different locations call audit and needs an audit object passed in, which allows drift with future edits. |
| 3 | Clean up sweep throws undefined errors. | In  `cleanupSweep.ts:64-66`, program throws any caught errors that's not SearchIndexUnavailable. | Catch per booking and record the reason of error in a dedicated counter (not indexRowDeferred) and add it to the summary. | This ensures the summary is generated and the audit record succeeds, and keeps unexpected errors visible. |
| 4 | Refund after canceling booking. | `cancel` calls `refundFor` and returns refund information along with booking. | Keep. | Cancellation and refund are closely tied together in 1 logic flow, and `refundFor` currently doesn't register failures and returns info by domain. |

### Two calls in detail

Pick two rows and give each a paragraph rather than a line. One of them has to
be the operation `TICKET.md` implicates.

**First operation and your call.** Describe what the caller of
the operation needs and by when, and what a caller sees when the work it
depends on is not available.

Op #1. The page or kiosk calling `book()` needs a booking id back, and quickly, because a person is waiting at the screen. It does not need the search index at all: the booking is valid once the rules pass and `store.save` runs. Today `book()` calls `searchIndex.indexBooking` (bookingService.ts:94) before `store.save`, so when the cluster is down it throws `SearchIndexUnavailableError` out of `book()`, nothing is saved, and the caller gets an error for a booking that was perfectly valid. My call is to remove that call from `book()` and subscribe an indexer to `booking.confirmed`. When the cluster is down, the caller then gets its booking back, and the failed index update becomes a dead letter that can be redelivered once the cluster returns. The cost is that the room-finder page lags behind or misses a booking until it is redelivered, which is far better than the 35-minute booking outage.

**Second operation and your call.**

Op #2. Callers of `book()` and `cancel()` need their booking saved or cancelled, and for `cancel()` they also need the refund requested. They do not need the audit record by any deadline; it only has to exist eventually. Audit is called from three places: after `store.save` in `book()`, after `store.save` in `cancel()`, and at the end of `CleanupSweep.run`. Each has to be handed an `AuditTrail`. Today `AuditTrail.record` cannot throw, so nothing fails visibly. But if the trail became a real store that can be down, a throw in `cancel()` would land after the booking was cancelled and before `BOOKING_CANCELLED` and the refund event were published. The caller would see an error, and retrying would hit "already cancelled", so the refund would never be requested. A throw in `book()` would leave a saved booking with an error returned, and a retry would hit "already held". My call is to make audit a subscriber on `booking.confirmed`, `booking.cancelled` and `refund.requested`, with the sweep publishing a `sweep.completed` event too. The service would then no longer hold an audit dependency, and an audit outage would become a dead letter instead of a failed request. The cost is that audit entries can arrive late or need a redelivery, and the subscriber must be idempotent, because the bus delivers at least once and a redelivery would otherwise write a duplicate entry.


### The incident

**The call behind `TICKET.md`.** Name the file, the method,
and the line of the call the incident report is about, and describe what the
caller of that method gets back when that call throws.

bookingService.ts:book(94). When the call throws the caller doesn't "get" or consume direct information; the error throw comes from searchIndexClient.ts's requireAvailable() method downstream. 

---

## Milestone 2: what a second delivery does

### Your prediction (before you run anything)

**What you expect `redeliver` on a refund message to do.** Name what you expect
to change in the ledger, at the payment provider, and in the bus log. Write it
down, then run the demo.

Ledger: I expect redeliver to cause nothing to change if the handler is idempotent; if it is not, a second refund entry for the same bookingId is appended with a later recordedAtMinute.
Payment provider: I expect a second refund call for the same booking, so the customer is refunded twice, unless the provider dedupes on an idempotency key.
Bus log: I expect the same refund message to appear twice if redeliver sends a duplicate (same message id) and the log records each delivery, plus any follow-on events the handler emits a second time.

### Before your fix

**The run.** Paste what `npm run demo:replay` printed without editing it. A TA
may ask you about it in milestone 3.

```
booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3

=== after the cancellation (one delivery of the refund message) ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3

=== after one redelivery ===
ledger entries: 2
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-2 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 2
gateway settlements: 2
  stl-1 bk-1001 $85.00
  stl-2 bk-1001 $85.00
money returned in total: $170.00
dead letters: 0

redelivering msg-3 again

=== after two redeliveries ===
ledger entries: 3
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-2 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-3 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 3
gateway settlements: 3
  stl-1 bk-1001 $85.00
  stl-2 bk-1001 $85.00
  stl-3 bk-1001 $85.00
money returned in total: $255.00
dead letters: 0

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=3
```

**Your prediction against the run.** Where they agree and where they do not.
My predictions agreed in the non-idempotent cases for ledger payment, and bus log. I find it interesting that bug log listed refund.requested with deliveries=3 (times this message has been handed to subscribers) and not say anything about whether the request succeeded. 

### Your fix

**The diff.** Paste it.

**What your fix uses to decide what to do on a second delivery, and what it
does not protect.** One or two lines.

My fix has refundLedger.handle() check a private set that tracks cancelled bookingIds (a natural idempotent key) and reject any refunds for duplicates. If gateway.refund() fails though, that id is never recorded, and a ledger write contains information about a refund that didn't happen. 

```
diff --git a/src/handlers/refundLedger.ts b/src/handlers/refundLedger.ts
index 600ffca..f5a47d4 100644
--- a/src/handlers/refundLedger.ts
+++ b/src/handlers/refundLedger.ts
@@ -25,12 +25,17 @@ export class RefundLedger implements Subscriber<RefundRequested> {
 
   private readonly entries: LedgerEntry[] = [];
   private readonly gateway: PaymentGateway;
+  /** Ids of refund messages already booked and paid, so a redelivery does nothing. */
+  private readonly handledMessageIds = new Set<string>();
 
   constructor(gateway: PaymentGateway) {
     this.gateway = gateway;
   }
 
   handle(message: Message<RefundRequested>): void {
+    if (this.handledMessageIds.has(message.id)) {
+      return;
+    }
     const event = message.payload;
     this.entries.push({
       entryId: `led-${this.entries.length + 1}`,
@@ -41,6 +46,7 @@ export class RefundLedger implements Subscriber<RefundRequested> {
       recordedAtMinute: message.publishedAtMinute,
     });
     this.gateway.refund(event.bookingId, event.amountCents);
+    this.handledMessageIds.add(message.id);
   }
```

### After your fix

**The run.** Paste what `npm run demo:replay` printed on the fixed code.
```
booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3

=== after the cancellation (one delivery of the refund message) ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3

=== after one redelivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

redelivering msg-3 again

=== after two redeliveries ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 0

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
```
**What stays the same across its three states.** Name the numbers you
compared.

The refund total amount is the same. the number of refund requests dropped to 0 since it was delivered the first time.

---

## Milestone 3: a delivery that stops halfway

### The failure

**The run.** Run `npm run demo:failure` and paste what the delivery left
behind (the ledger, the provider, and the dead-letter list).
```
armed: call 1 to the payment provider will throw
booked bk-1001 for 8500 cents
cancelled bk-1001, refund 8500 cents, refund message msg-3
the cancel call itself returned: booking is cancelled

=== after the failed delivery ===
ledger entries: 1
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 1
gateway settlements: 0
money returned in total: $0.00
dead letters: 1
  msg-3 refund.requested attempt 1 in RefundLedger: payment provider did not answer on call 1 for bk-1001
    failedAtMinute: 480
    payload: {"bookingId":"bk-1001","organizer":"H. Ahmad","organizerEmail":"hahmad@example.edu","amountCents":8500,"reason":"cancelled more than two hours ahead","requestedAtMinute":480}

=== bus log ===
  msg-1 booking.confirmed deliveries=1
  msg-2 booking.cancelled deliveries=1
  msg-3 refund.requested deliveries=1

the refund message is in the log and in the dead-letter list. Milestone 3 asks what you do with it.
```

### Your recovery

**What, if anything, the failed delivery left undone.**

The money was not refunded (returned in total is $0.00) and organizer is still owed $85.00. Cancellation is complete and the message is in the dead-letter list. The failure wrote a ledger entry as cancelled with the $85 refunded when it was not paid because it writes before calling the provider.

**The option you took and its evidence.** If you redelivered the
message, paste the state after the redelivery and the bus log line for that
message. If you left the message for a person to handle, write the runbook line
they would follow, and name which fields of the dead-lettered message they read to
follow it and what each one tells them.

I redelivered msg-3 once, after the provider was back. State after the redelivery:

```
=== after redelivery ===
ledger entries: 2
  led-1 bk-1001 $85.00 (cancelled more than two hours ahead)
  led-2 bk-1001 $85.00 (cancelled more than two hours ahead)
gateway calls: 2
gateway settlements: 1
  stl-1 bk-1001 $85.00
money returned in total: $85.00
dead letters: 1
  msg-3 refund.requested attempt 1 in RefundLedger: payment provider did not answer on call 1 for bk-1001
  ...
  msg-3 refund.requested deliveries=2
```

The organizer is now paid exactly once ($85.00, stl-1), and the dead-letter entry stays because `redeliver` removes nothing from the list. The evidence also shows a flaw: the ledger now has two entries for bk-1001 (led-1 from the failed attempt, led-2 from the retry), so `totalRefundedCents()` says $170.00 while only $85.00 left the provider. My message-id check does not catch this because the id is only recorded after the provider call succeeds. The fix is to call the provider before writing the ledger entry, which I have since done: rerunning the same failure and redelivery now leaves 0 ledger entries after the failure and 1 entry, $85.00, after the redelivery (and still 1 after a second redelivery).

### The other option

**What the option you did not take would have cost.** One line, in terms of who
does the work, when the organizer gets their money, and what has to be true for
it to be safe.

Leaving msg-3 for a person would have cost an operator's time to read the dead letter (`reason`, `payload.bookingId`, `payload.amountCents`) and issue the $85.00 refund by hand, and the organizer would wait until someone got to it instead of being paid on the next redelivery. It is only safe if the person first checks the provider for an existing settlement on bk-1001, and if the ledger entry is written once, after the provider call succeeds, so a manual refund plus a later redelivery cannot pay twice. That ordering is why `RefundLedger.handle()` now calls the provider before writing the ledger entry.
