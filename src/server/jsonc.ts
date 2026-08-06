/**
 * Minimal JSONC support.
 *
 * Some tools write config files that are JSON with comments. The Copilot CLI
 * config is one of them: it starts with a `// User settings belong in
 * settings.json.` header, so plain `JSON.parse` rejects it.
 *
 * Comment stripping is done with a character scanner rather than a regular
 * expression because comment markers legitimately appear inside string values.
 * The same Copilot config contains `"host": "https://github.com"`, which a
 * naive `//` match would truncate.
 */

/** Strips `//` line comments and block comments that sit outside string literals. */
export function stripJsonComments(text: string): string {
  const out: string[] = [];
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      // Keep the newline so line numbers in parse errors still line up.
      if (char === "\n") {
        inLineComment = false;
        out.push(char);
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (char === "\n") {
        out.push(char);
      }
      continue;
    }

    if (inString) {
      out.push(char);
      if (char === "\\") {
        // Copy the escaped character verbatim so an escaped quote does not
        // look like the end of the string.
        if (next !== undefined) {
          out.push(next);
          index += 1;
        }
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out.push(char);
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    // Trailing commas are legal in JSONC but not in JSON.
    if (char === "}" || char === "]") {
      let lastSignificant = out.length - 1;
      while (lastSignificant >= 0 && /\s/.test(out[lastSignificant]!)) lastSignificant -= 1;
      if (lastSignificant >= 0 && out[lastSignificant] === ",") {
        out.splice(lastSignificant, 1);
      }
    }

    out.push(char);
  }

  return out.join("");
}

/** Parses JSON that may contain comments or trailing commas. */
export function parseJsonc<T = unknown>(text: string): T {
  return JSON.parse(stripJsonComments(text)) as T;
}
