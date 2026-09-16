export interface PrRef {
  repo: string;
  number: number;
}

/*
 * The forms a pull request is named in, and nothing that reaches a process.
 *
 * A leaf module for the same reason as `deployState`: the palette decides
 * whether what you typed is a pull request while you are typing it, and it
 * cannot import anything that reaches `node:child_process` without failing the
 * bundle.
 */

/**
 * Read `owner/repo#123` or a pull request URL.
 *
 * The URL arm takes the two path segments in front of `/pull/` wherever they
 * sit in the string rather than anchoring the whole of it, which is what makes
 * it tolerant of everything a real paste carries: the scheme or no scheme, an
 * enterprise host instead of github.com, and the `/files` or `#discussion_r…`
 * that a link copied mid-review ends in.
 */
export function parsePrRef(ref: string): PrRef | undefined {
  const trimmed = ref.trim();
  const url = /([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(trimmed);
  if (url?.[1] && url[2] && url[3]) {
    return { repo: `${url[1]}/${url[2]}`, number: Number.parseInt(url[3], 10) };
  }
  const short = /^([^#\s/]+\/[^#\s/]+)#(\d+)$/.exec(trimmed);
  if (short?.[1] && short[2]) return { repo: short[1], number: Number.parseInt(short[2], 10) };
  return undefined;
}
