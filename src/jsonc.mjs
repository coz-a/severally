// JSON with comments, for the one file a human is expected to edit.
//
// JSON itself has no comment syntax, so a configuration file either carries its
// documentation as fake data ("//" keys, which read as settings) or carries
// none at all. Stripping comments before JSON.parse costs one small scanner and
// no dependency, and gives the file the shape an operator expects.
//
// The scanner has to know where strings are: a naive regex would eat the "//"
// in "bin": "https://example.com/agy", and a naive trailing-comma rule would
// corrupt a value like "a,}". Comments are blanked rather than deleted so the
// UTF-16 code-unit offsets -- and therefore JSON.parse's error positions --
// still point at the right place in the original text.

/**
 * Remove // and /* *\/ comments and trailing commas, preserving UTF-16 code-unit offsets.
 * @param {string} text
 */
export function stripJsonc(text) {
  /** @type {string[]} */
  const out = [];
  let inString = false;
  let i = 0;

  /** @param {']' | '}'} closing */
  const blankBack = (closing) => {
    // The character that closed a container: blank a comma that preceded it.
    for (let j = out.length - 1; j >= 0; j--) {
      const c = out[j];
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t') continue;
      if (c === ',') {
        // A comma directly after the opening delimiter has no value to trail.
        const opening = closing === '}' ? '{' : '[';
        let previous = j - 1;
        while (previous >= 0 && [' ', '\n', '\r', '\t'].includes(out[previous] ?? '')) previous--;
        const previousChar = previous >= 0 ? out[previous] : undefined;
        if (previousChar !== undefined && previousChar !== opening) out[j] = ' ';
      }
      return;
    }
  };

  while (i < text.length) {
    const c = text.charAt(i);
    const next = text[i + 1];

    if (inString) {
      out.push(c);
      if (c === '\\') {
        out.push(next ?? '');
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }

    if (c === '"') {
      inString = true;
      out.push(c);
      i++;
      continue;
    }

    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') {
        out.push(' ');
        i++;
      }
      continue;
    }

    if (c === '/' && next === '*') {
      const commentStart = out.length;
      out.push(' ', ' ');
      i += 2;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '*' && text[i + 1] === '/') {
          out.push(' ', ' ');
          i += 2;
          closed = true;
          break;
        }
        const commentChar = text.charAt(i);
        out.push(commentChar === '\n' || commentChar === '\r' ? commentChar : ' ');
        i++;
      }
      if (!closed) {
        // Leave the opener in place so JSON.parse rejects the unfinished comment.
        out[commentStart] = '/';
        out[commentStart + 1] = '*';
      }
      continue;
    }

    if (c === '}' || c === ']') blankBack(c);
    out.push(c);
    i++;
  }

  return out.join('');
}

/**
 * JSON.parse, tolerating comments and trailing commas.
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}
