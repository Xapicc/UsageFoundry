# QoL hunt 1/5: starting runs, the run loop, the run page

At `fee5efb`. Work in progress: items are added below as they are verified.

## Items

## Too big for this list

## Bugs filed

- Saving a run template skips the form's blank-limit check, storing "on but blank" as no limit — normal — `01cc1ab9-2cbd-4566-8cf9-469aa126d69a`
- Run form warns a window guard will be refused when the provider's percentage makes it work — normal — `0821945e-04eb-4fce-943b-59ed01839e25`
- "Start another like this" drops isolation for never-released runs and can strand the workspace picker — normal — `0d0810d9-7357-4885-bb56-c7836a6e9993`
- Validator's extra work cycle never runs: pre-cycle guard stops the run at the cycle cap — high — `c1dc14cf-ed4a-48e3-838c-bf6162b0a8e7`
- Live guard tick can stop a run using a finished cycle's guard, double-counting its spend — high — `73d5c74a-0349-4db7-928c-343abec20413`
- Refusal-park allowance is charged for guard parks and never reset by a pick-up — normal — `8ef928a2-ae55-42e8-9a9e-f4a5cad3eb95`

## Bugs not filed

## Seen outside my territory
