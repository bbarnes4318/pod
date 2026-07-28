# Script Movement Repair

Production script generation writes three conversational movements. Each movement is now evaluated immediately after generation, before whole-episode semantic verification and rewrite stages.

A movement is repaired in place when it is:

- materially below its allocated spoken-word floor;
- heavily repetitive within the movement or against earlier dialogue; or
- mechanically alternating every line without any same-speaker build or specific short reaction.

The repair call receives the failed draft and exact measured deficiencies. It must preserve the movement's speakers, assigned beats, evidence references, factual claims, and argument direction. It may deepen motives, consequences, uncertainty, rebuttals, and reactions, but it may not invent facts.

Two targeted repair rounds are allowed. A movement that still fails is rejected before the application spends money on whole-episode verification. For a 12-minute episode, the movement floors collectively require roughly 1,428 spoken words, above the final script gate's 1,260-word editorial target.
