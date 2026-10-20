# superlite build report

projection: fixed forecast saved at lint 2026-10-20T12:23:07 (plan edited since)

                         Projected    Actual  Delta
wall-clock (min)               4.7      48.8  +44.2 (+948%)
agent cost (USD, +rework)      0.38     26.21  +25.83 (+6841%)
task-minutes                   8.9      77.6  +68.7 (+770%)
agents                           4       104  +100 (+2500%)
cost split: agents $24.96, rework $1.24, coordinator $39.72, total $65.93
concurrency: peak 3 at once (projected 2); critical path actual T1; projected T1 > T2 (4.7 min)
model mix: haiku 1 tasks $0.06, sonnet 5 tasks $26.14, coordinator sonnet $39.72
quality: tests 1 passed, 0 failed; first-time pass 5/6 (83%); rework dispatches 1; open incidents 8

task  model      pred  actual  delta             cost
T1    sonnet      2.5    33.6  +31.1 (+1266%) $12.616  first-time miss
T3    sonnet      2.2    16.8  +14.7 (+680%)   $2.712
T4    sonnet      2.1     6.8  +4.7 (+222%)    $3.394
T2    sonnet      2.2     5.3  +3.1 (+141%)    $4.498
T0    haiku       n/a     3.6  n/a             $0.061
(+1 smaller misses; `sl report --json` lists all)

takeaway: ran 948% slower than projected; cost 6841% over; biggest miss T1
