# benchI

An open-source platform for comparing coding agents against repeatable software tasks under controlled variations.

## Language

**Eval Suite**:
A reusable evaluation definition combining tasks, agent configurations, scenario variants, matrix rules, and scoring policy.
_Avoid_: Benchmark, test plan

**Eval Run**:
An immutable execution snapshot of an eval suite. It contains the expanded trial matrix and the exact source revisions and configurations used.
_Avoid_: Run, execution job

**Eval Trial**:
One isolated attempt by one agent on one task under one scenario variant and run index.
_Avoid_: Attempt, job

**Trial Attempt**:
One immutable execution attempt for an eval trial. Infrastructure retries remain attached to the same logical eval trial as separate trial attempts.
_Avoid_: Retry, rerun

**Trial Matrix**:
The expanded set of eval trials produced from agents, tasks, scenario variants, and run indexes, with optional include and exclude overrides.
_Avoid_: Run matrix, job list

**Scenario Variant**:
A controlled variation applied before an eval trial. It may change visible source material and agent configuration such as skills, plugins, MCP servers, permission rules, or prompting; it never includes hidden acceptance material.
_Avoid_: Mode, setup, environment

**Acceptance Material**:
Criteria used to judge an eval trial, either as hidden executable checks or rubric documents. Hidden acceptance material is unavailable to the coding agent during the eval trial.
_Avoid_: Grading files

**Submitted Trial**:
An eval trial whose completed work was produced outside benchI and submitted for scoring against an eval task.
_Avoid_: Manual agent

**Custom Agent Adapter**:
A versioned integration that allows a worker to execute an agent not provided by Sandcastle while preserving the eval-trial lifecycle and artifacts.
_Avoid_: Manual agent, custom harness

**Custom Scorer**:
An approved executable integration that evaluates trial output through the versioned scoring contract.
_Avoid_: Grader plugin, scoring script

**Execution Resource**:
An executable repository, acceptance check, plugin, skill, or custom agent adapter that an Admin has approved for use on installation workers.
_Avoid_: Asset, trusted code

**Installation Secret**:
An encrypted credential managed by an Admin and made available only to explicitly authorized agent configurations during execution.
_Avoid_: API key, environment variable
