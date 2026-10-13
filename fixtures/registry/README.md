# registry fixture

Eight independent helper functions that all live in ONE file (`app/handlers.py`). Eight tasks each
implement one function, so every edit is partial and every write races on the same file.
`oracle/` is acceptance only; agents never see it. `solution/` exists to prove the oracle accepts a
correct result (and `baseline/` that it rejects the stubs).
