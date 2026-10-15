------------------------------ MODULE JournalLock ------------------------------
(* Plan 18 E10 (H10.2): the workspace lock of the journal (plan 01), with the first-come, first-served queue of
   src/journal/lock.ts (acquireWorkspaceLockInOrder). Processes request a place in the queue, enter the lock when they
   are first in line and the lock is free, leave it, or die. A death releases the lock, as the kernel does for an
   exclusive SQLite lock, and removes a dead waiter from the queue, as the pruning of dead tickets does. *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANT Procs

VARIABLES inside, queue

vars == <<inside, queue>>

ToSet(s) == { s[i] : i \in 1..Len(s) }

Init == /\ inside = {}
        /\ queue = <<>>

Request(p) == /\ p \notin inside
              /\ p \notin ToSet(queue)
              /\ queue' = Append(queue, p)
              /\ inside' = inside

(* Only the first in line may enter, and only while the lock is free. *)
Enter(p) == /\ queue /= <<>>
            /\ Head(queue) = p
            /\ inside = {}
            /\ inside' = {p}
            /\ queue' = Tail(queue)

Leave(p) == /\ p \in inside
            /\ inside' = {}
            /\ queue' = queue

Die(p) == /\ p \in inside \/ p \in ToSet(queue)
          /\ inside' = inside \ {p}
          /\ queue' = SelectSeq(queue, LAMBDA x : x /= p)

Next == \E p \in Procs : Request(p) \/ Enter(p) \/ Leave(p) \/ Die(p)

(* Fairness: the first in line is entered as soon as the lock is free, and a holder that leaves does so eventually. *)
Spec == Init /\ [][Next]_vars
        /\ \A p \in Procs : WF_vars(Enter(p)) /\ WF_vars(Leave(p))

(* Safety: never two processes inside the lock. *)
MutualExclusion == Cardinality(inside) <= 1

(* Safety: a process holds at most one place in the queue. *)
NoDuplicates == Len(queue) = Cardinality(ToSet(queue))

(* Liveness: a process that waits is never kept waiting forever. It enters, or it leaves the queue (a death removes it). *)
EventualEntry == \A p \in Procs : (p \in ToSet(queue)) ~> (p \in inside \/ p \notin ToSet(queue))

TypeOK == /\ inside \subseteq Procs
          /\ queue \in Seq(Procs)
==============================================================================
