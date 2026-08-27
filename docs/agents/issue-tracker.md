# Issue tracker: GitHub

Issues and specs live as GitHub issues. Use the `gh` CLI for all operations and infer the repository from the Git remote.

## Conventions

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --comments`
- List: `gh issue list`
- Comment: `gh issue comment <number> --body "..."`
- Label: `gh issue edit <number> --add-label "..."`
- Close: `gh issue close <number> --comment "..."`

Pull requests are not a triage request surface.

When a skill says to publish, create a GitHub issue. When it says to fetch a ticket, read the corresponding GitHub issue.
