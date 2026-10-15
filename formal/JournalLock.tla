------------------------------ MODULE JournalLock ------------------------------
(* Plan 18 E10 (H10.2): the workspace lock of the journal (plan 01). Processes request the lock, enter it, leave it,
   or die. A death releases the lock, as the kernel does for an exclusive SQLite lock. *)
EXTENDS Naturals, FiniteSets

CONSTANT Procs

VARIABLES inside, waiting

vars == <<inside, waiting>>

Init == /\ inside = {}
        /\ waiting = {}

Request(p) == /\ p \notin waiting
              /\ p \notin inside
              /\ waiting' = waiting \cup {p}
              /\ inside' = inside

Enter(p) == /\ p \in waiting
            /\ inside = {}                       \* the exclusive lock is free
            /\ inside' = {p}
            /\ waiting' = waiting \ {p}

Leave(p) == /\ p \in inside
            /\ inside' = {}
            /\ waiting' = waiting

Die(p) == /\ p \in inside                       \* a crash releases the lock
          /\ inside' = {}
          /\ waiting' = waiting

Next == \E p \in Procs : Request(p) \/ Enter(p) \/ Leave(p) \/ Die(p)

(* Fairness. The first check uses weak fairness and finds starvation (a waiter overtaken forever). A waiting queue
   that serves requests in order is strong fairness on Enter; that is the assumption under which EventualEntry holds. *)
Spec == Init /\ [][Next]_vars
        /\ \A p \in Procs : SF_vars(Enter(p)) /\ WF_vars(Leave(p))

(* Safety: never two processes inside the lock. *)
MutualExclusion == Cardinality(inside) <= 1

(* Liveness: a process that waits is eventually inside. *)
EventualEntry == \A p \in Procs : (p \in waiting) ~> (p \in inside)

TypeOK == /\ inside \subseteq Procs
          /\ waiting \subseteq Procs
==============================================================================
