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
// byte offsets -- and therefore JSON.parse's error positions -- still point at
// the right place in the original text.

/** Remove // and /* *\/ comments and trailing commas, preserving offsets. */
export function stripJsonc(text) {
  const out = [];
  let inString = false;
  let i = 0;

  const blankBack = () => {
    // The character that closed a container: blank a comma that preceded it.
    for (let j = out.length - 1; j >= 0; j--) {
      const c = out[j];
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t') continue;
      if (c === ',') out[j] = ' ';
      return;
    }
  };

  while (i < text.length) {
    const c = text[i];
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
      while (i < text.length && text[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }

    if (c === '/' && next === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out.push(text[i] === '\n' ? '\n' : ' ');
        i++;
      }
      out.push(' ', ' ');
      i += 2;
      continue;
    }

    if (c === '}' || c === ']') blankBack();
    out.push(c);
    i++;
  }

  return out.join('');
}

/** JSON.parse, tolerating comments and trailing commas. */
export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}
