# ZeroAgent plugin drafts

Submit the primary skill, child skills, and supporting text files to `prepare_extension`. ZeroAgent creates the manifest and registers only the declared skills when the user saves the draft. A saved personal plugin can be exported and reimported as a ZIP.

Put long examples and instructions under `references/`, reusable text assets under `assets/`, and optional source scripts under `scripts/`. Each child skill needs a distinct name, description, and Markdown body. For an update, include the owned package identity and the exact revision you read.

An instruction plugin uses tools already offered in a conversation. Document any additional connection separately, including the required service, expected operations, and validation steps.
