# Design QA rubric

| Severity | Example | Effect on the report |
| --- | --- | --- |
| P0 | The implementation cannot open, the primary task is impossible, or user work is lost. | Block the handoff. |
| P1 | A key control is inaccessible, the phone layout prevents task completion, or a major mismatch changes the workflow. | Block the handoff. |
| P2 | A material visual or interaction defect is reproducible in a required state or viewport. | Block the handoff until corrected and verified. |
| P3 | A refinement has a small effect and the required task and comparison still pass. | Record it for follow-up. |

Record each finding with the affected state, source evidence, implementation evidence, user impact, correction, and the result of the rerun.

```markdown
# Design QA

## Target and implementation
- Source and implementation identity
- Task states and matching viewports
- Screenshots or observed renderings

## Checks
- Layout, typography, assets, and visual states
- Primary action, navigation, keyboard, and recovery
- Other checks actually performed

## Findings
- Severity, evidence, correction, and verification result

## Result
final result: passed
```

Use `blocked` instead of `passed` whenever evidence is incomplete or actionable P0–P2 findings remain. Include a short explanation and a next action.
