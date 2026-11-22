// Fish Voice Design request limits, in a plain module so the browser form and
// the server request builder enforce the SAME numbers. The form used to cap the
// test line at 150 characters while five catalog briefs shipped longer lines:
// the form silently clipped them and Fish would have refused the rest.

/** `instruction` — the description of the voice. */
export const FISH_VOICE_DESCRIPTION_MAX = 2000;
/** `reference_text` — the words each designed take speaks. */
export const FISH_VOICE_TEST_LINE_MAX = 150;
