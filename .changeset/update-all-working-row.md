---
"@internal/server": patch
---

"Update all" on the Updates page now shows which machine it is working on and how far into the fleet it is: the spinner moves row to row with the sequence and the button counts ("Updating 1 of 2…"), where before every node's button disabled and only the first row ever spun, for the minutes one node's update takes. The count is the fleet the press captured, so a restarting node dropping offline mid-run no longer shifts the numbers.
