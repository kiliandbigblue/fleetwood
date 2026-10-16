import { setImmediate } from 'node:timers/promises';
import { createHighlighterCore } from 'shiki/core';
import type { GrammarState, HighlighterCore, ThemedToken } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { FileDiff } from './tourDiff.ts';

/** A run of code and its GitHub Dark default colour; no colour is `PLAIN`. */
export type Token = [text: string, color?: string];

const THEME = 'github-dark-default';

/** GitHub Dark default's text: what the page sets code in, so its tokens need not say it. */
export const PLAIN = '#e6edf3';

/** By extension, then by whole name for the files that have no extension. */
const LANGS: Record<string, string> = {
  go: 'go', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', json: 'json', jsonc: 'jsonc',
  py: 'python', proto: 'proto', sql: 'sql', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', css: 'css', scss: 'scss', html: 'html', md: 'markdown',
  rs: 'rust', swift: 'swift', graphql: 'graphql', gql: 'graphql', dockerfile: 'dockerfile', makefile: 'make',
};

// Tokenizing is synchronous, in the app's main process, at ~0.2ms a line: a
// file goes CHUNK lines at a time with a turn of the event loop between, so
// the app keeps answering. Past MAX_LINES (generated code) a file stays plain.
const CHUNK = 200;
const MAX_LINES = 20_000;

let highlighter: Promise<HighlighterCore> | undefined;

// The languages are listed, not bundled: the app's main process is one esbuild
// file, and Shiki's full bundle would pull in its two hundred grammars.
const load = (): Promise<HighlighterCore> =>
  (highlighter ??= createHighlighterCore({
    themes: [import('shiki/themes/github-dark-default.mjs')],
    langs: [
      import('shiki/langs/go.mjs'), import('shiki/langs/typescript.mjs'), import('shiki/langs/tsx.mjs'),
      import('shiki/langs/javascript.mjs'), import('shiki/langs/jsx.mjs'), import('shiki/langs/json.mjs'),
      import('shiki/langs/jsonc.mjs'), import('shiki/langs/python.mjs'), import('shiki/langs/proto.mjs'),
      import('shiki/langs/sql.mjs'), import('shiki/langs/shellscript.mjs'), import('shiki/langs/yaml.mjs'),
      import('shiki/langs/toml.mjs'), import('shiki/langs/css.mjs'), import('shiki/langs/scss.mjs'),
      import('shiki/langs/html.mjs'), import('shiki/langs/markdown.mjs'), import('shiki/langs/rust.mjs'),
      import('shiki/langs/swift.mjs'), import('shiki/langs/graphql.mjs'), import('shiki/langs/dockerfile.mjs'),
      import('shiki/langs/make.mjs'),
    ],
    engine: createJavaScriptRegexEngine(),
  }));

const token = (t: ThemedToken): Token => {
  const color = t.color?.toLowerCase();
  return color && color !== PLAIN ? [t.content, color] : [t.content];
};

function langOf(path: string): string | undefined {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  return LANGS[name.includes('.') ? (name.split('.').pop() ?? '') : name];
}

/**
 * Each line of a whole file as tokens. Colour is decoration: a language Shiki
 * was not given, a file too long or a grammar that throws leaves it plain.
 */
export async function highlight(path: string, lines: string[]): Promise<Token[][]> {
  const plain = lines.map((line): Token[] => [[line]]);
  const lang = langOf(path);
  if (!lang || lines.length > MAX_LINES) return plain;
  try {
    const hl = await load();
    if (!hl.getLoadedLanguages().includes(lang)) return plain;
    const out: Token[][] = [];
    let grammarState: GrammarState | undefined;
    for (let i = 0; i < lines.length; i += CHUNK) {
      await setImmediate();
      // Each chunk starts in the state the last one ended in: a comment open across the cut stays one.
      // A minified line is left plain past 2000 columns, as VS Code leaves it.
      const chunk = hl.codeToTokensBase(lines.slice(i, i + CHUNK).join('\n'), {
        lang, theme: THEME, tokenizeMaxLineLength: 2000, grammarState,
      });
      grammarState = hl.getLastGrammarState(chunk);
      for (const line of chunk) out.push(line.map(token));
    }
    return out;
  } catch {
    return plain;
  }
}

/**
 * A file's rows as tokens, one entry per row. Each side is tokenized whole —
 * the old file from its kept and removed rows, the new from its kept and added
 * ones — so a comment or a string that spans lines is coloured as it is.
 */
export async function rowTokens(file: FileDiff): Promise<Token[][]> {
  const before = file.rows.filter((r) => r.kind !== '+').map((r) => r.text);
  const after = file.rows.filter((r) => r.kind !== '-').map((r) => r.text);
  const old = await highlight(file.oldPath ?? file.path, before);
  const now = await highlight(file.path, after);
  let o = 0;
  let n = 0;
  return file.rows.map((r) => {
    if (r.kind === '-') return old[o++] as Token[];
    // A kept row is on both sides; it moves both along and takes the new side's colours.
    if (r.kind === ' ') o++;
    return now[n++] as Token[];
  });
}
