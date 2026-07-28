# Cal "Red Eye" Mercer — voice audition

**Status: seat B does NOT yet have a Cal-specific voice.** He inherited the
previous occupant's Fish configuration so the show could keep publishing through
the recast. That voice was built for a trained public-address performer who opens
at full volume; Cal is a warm, low, close-microphone register that gets *quieter*
when he is angry. Treat the current voice as a placeholder with a real reference
id, not as an approval.

Run this script through every candidate voice before final creative approval.

## Why these six beats

Cal fails in six specific ways, and each beat below is the one that exposes it:

| Beat | The failure it catches |
| :--- | :--- |
| 1. Warm conversational baseline | A voice that sounds like it is addressing a room. Cal is talking to one person. |
| 2. Dry humor | A voice that has to signal a joke. His humor has no lift at the end. |
| 3. A vivid short memory | A voice that turns a memory into narration. Sensory, not wistful. |
| 4. Zabala challenging his euphemism | Whether the pair is legible in mono when she is on top of him. |
| 5. Cal correcting himself | Whether a mid-sentence repair survives, or gets smoothed into one clean line. |
| 6. Quiet, precise anger | **The one that matters.** If the voice gets LOUDER here, reject it. |

## Direction

Fish receives limited natural-language direction, so the performance has to come
out of the writing, the punctuation, and the scene. Give the engine the scene
context below and nothing more — do not add per-line acting notes.

> Two hosts, late, in a small room. Cal is telling Bernadette something he has
> not said out loud before. He is not performing. She is not letting him off.

Approximately **75 seconds** at Cal's 150–165 wpm.

## Script

> Everything below is fictional and composite. No real person, team, event, or
> organization appears in it, and nothing in it may be reused as though it were
> reporting.

**CAL:**
People think the hard part is the decision. It isn't. The hard part is the forty
minutes after, when six people work out what the sentence is going to be.

**CAL:**
I have sat in a room where we spent longer on the word "mutual" than on the man
it applied to.

**CAL:**
There is a hallway at the back of every arena that smells like floor wax and old
popcorn. I stood in one at two in the morning while a general manager practiced
saying "we wish him well" — over and over, until it stopped sounding like a lie.

**ZABALA:**
Wish him well. Cal. He found out by text.

**CAL:**
It was a diffi— no. Hold on. I was about to tell you it was a difficult
situation. It wasn't difficult. It was cheap, and I helped write it.

**CAL:**
So here is the part I don't accept. Twelve paragraphs, and the only two names in
them belonged to the men who cost the least. Somebody chose those names.
Somebody sat down and chose them.

**CAL:**
Anyway. That is the part that never makes the release.

## Acceptance checklist

Play the render back and answer these. A "no" on any of the first four is a
reject, not a note.

- [ ] Does the last beat land **quieter and more clipped** than the first?
- [ ] Does the mid-sentence break in "It was a diffi— no. Hold on." survive as an
      audible repair rather than a smooth restart?
- [ ] Can you tell Cal and Zabala apart with your eyes closed, without either of
      them raising their voice?
- [ ] Is the pause before "until it stopped sounding like a lie" a real beat, and
      not a swallowed comma?
- [ ] Does the dry line get through without the voice adding a smile to it?
- [ ] Does he ever sound like he is announcing something?

## Configuration

Set the resolved voice on **both** the web and worker apps:

```bash
FISH_HOST_B_VOICE_ID=<32-hex Fish reference id>
```

`FISH_HOST_B_VOICE_ID` is the seat-keyed override and applies at synthesis time
with no reseed. `FISH_CAL_MERCER_VOICE_ID` is the identity-keyed variable the
seed reads when writing the row. The retired seat-B identity variable still
resolves for one compatibility release and is deprecated — see
[PRODUCTION_ENV.md](PRODUCTION_ENV.md).
