/**
 * Removes markdown formatting, raw URLs, and any Boson-style tags.
 */
export function sanitizeForGenericTts(text: string): string {
  if (!text) return "";

  // 1. Remove Boson-style tags: <|category:value|>
  let cleaned = text.replace(/<\|[a-z_]+:[a-z0-9_]+\|>/gi, "");

  // 2. Remove raw URLs
  cleaned = cleaned.replace(/https?:\/\/\S+/gi, "");

  // 3. Remove markdown headers, bullets at beginning of lines, code fences, and format symbols
  cleaned = cleaned
    .replace(/^#+\s+/gm, "")      // headers
    .replace(/^[-*+]\s+/gm, "")     // bullets
    .replace(/```[\s\S]*?```/g, "") // code blocks
    .replace(/[*_`#~]/g, "");       // other formatting symbols

  // 4. Collapse excessive whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return cleaned;
}

/**
 * Removes markdown formatting and raw URLs, but preserves valid Boson tags.
 */
export function sanitizeForBosonTts(text: string): string {
  if (!text) return "";

  // 1. Extract and protect valid Boson tags
  const validTagsMap: string[] = [];
  let protectedText = text.replace(/<\|([a-z_]+):([a-z0-9_]+)\|>/gi, (match, cat) => {
    const isCategoryValid = ["emotion", "prosody", "style", "sfx"].includes(cat.toLowerCase());
    if (isCategoryValid) {
      const idx = validTagsMap.length;
      validTagsMap.push(match);
      return ` BOSONTG${idx} `;
    }
    return "";
  });

  // Strip other malformed/invalid tag attempts <|...
  protectedText = protectedText.replace(/<\|[\s\S]*?(?:\|>|$)/g, "");

  // 2. Replace raw URLs
  protectedText = protectedText.replace(/https?:\/\/\S+/gi, "");

  // 3. Remove markdown headers, bullets, code blocks, and formatting symbols
  protectedText = protectedText
    .replace(/^#+\s+/gm, "")      // headers
    .replace(/^[-*+]\s+/gm, "")     // bullets
    .replace(/```[\s\S]*?```/g, "") // code blocks
    .replace(/[*_`#~]/g, "");       // formatting symbols

  // 4. Restore valid tags
  let cleaned = protectedText;
  validTagsMap.forEach((tag, idx) => {
    cleaned = cleaned.replace(`BOSONTG${idx}`, tag);
  });

  // 5. Collapse excessive whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return cleaned;
}

/**
 * Splits a long script into safe chunks for TTS processing.
 * Max characters limit per chunk can be configured (default 1500 characters).
 * Avoids cutting inside a Boson tag or mid-sentence.
 */
export function chunkScriptText(text: string, maxChars = 1500): string[] {
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining.trim());
      break;
    }

    let splitIndex = maxChars;
    const windowStart = Math.max(0, maxChars - 200);
    const windowText = remaining.substring(0, maxChars);

    // Make sure we do not cut inside a Boson tag: <|category:value|>
    const lastOpen = windowText.lastIndexOf("<|");
    const lastClose = windowText.lastIndexOf("|>");
    if (lastOpen > lastClose) {
      splitIndex = lastOpen;
    } else {
      // Look for a sentence boundary: '.', '!', '?' followed by whitespace or string end
      let boundaryIndex = -1;
      const regex = /[.!?](?:\s|$)/g;
      let match;
      while ((match = regex.exec(windowText)) !== null) {
        const idx = match.index;
        if (idx >= windowStart && idx < maxChars) {
          boundaryIndex = idx + 1; // Split after the punctuation character
        }
      }

      if (boundaryIndex !== -1) {
        splitIndex = boundaryIndex;
      } else {
        const spaceIdx = windowText.lastIndexOf(" ", splitIndex);
        if (spaceIdx > windowStart) {
          splitIndex = spaceIdx;
        }
      }
    }

    const chunk = remaining.substring(0, splitIndex).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}
