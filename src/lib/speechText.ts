/**
 * Converts a markdown chat message into text suitable for TTS.
 *
 * Spoken output should be the prose of the message, not its syntax: fenced
 * code blocks and tables are unlistenable when read literally, and markdown
 * punctuation ("**", "#", "](http://...") turns into noise. This keeps the
 * sentences and drops or replaces everything that only makes sense visually.
 */
export function toSpeechText(markdown: string): string {
  let text = markdown;

  // Fenced code blocks: content is unreadable aloud — leave a short marker so
  // the narration acknowledges something was skipped.
  text = text.replace(/```[\s\S]*?(?:```|$)/g, ' (code omitted) ');

  // Markdown tables: drop every table line (headers, separators, rows).
  text = text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('|') && trimmed.length > 1);
    })
    .join('\n');

  // Images and links: keep the label, drop the URL.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // Bare URLs read as letter soup.
  text = text.replace(/https?:\/\/\S+/g, ' (link) ');

  // Inline code: keep the content, drop the backticks.
  text = text.replace(/`([^`]+)`/g, '$1');

  // Headings, emphasis, blockquotes, list bullets, horizontal rules.
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/(\*\*|__|\*|_|~~)/g, '');
  text = text.replace(/^\s*>\s?/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*(?:---+|\*\*\*+|___+)\s*$/gm, '');

  // Collapse the whitespace left behind by removals.
  text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();

  return text;
}
