const CJK_SCRIPT_CODE_POINT = /^(?:\p{Script_Extensions=Han}|\p{Script_Extensions=Hiragana}|\p{Script_Extensions=Katakana}|\p{Script_Extensions=Hangul})$/u
const CJK_TEXT_CODE_POINT = /^[\p{L}\p{M}]$/u
const SEARCH_WORD = /[\p{Script=Latin}\p{N}]+/gu

function isCjkCodePoint(codePoint: string): boolean {
  return CJK_TEXT_CODE_POINT.test(codePoint) && CJK_SCRIPT_CODE_POINT.test(codePoint)
}

/**
 * Generate overlapping two-code-point tokens for each contiguous CJK run.
 * Single-code-point runs produce no token, and tokens never cross non-CJK text.
 *
 * @param input - source text.
 * @returns CJK bigrams in source order, including repeated occurrences.
 */
export function tokenizeCjkBigrams(input: string): string[] {
  const tokens: string[] = []
  let run: string[] = []

  const flush = (): void => {
    for (let index = 0; index + 1 < run.length; index += 1) {
      const first = run[index]
      const second = run[index + 1]
      if (first === undefined || second === undefined) throw new Error('CJK run index is out of bounds')
      tokens.push(first + second)
    }
    run = []
  }

  for (const codePoint of input) {
    if (isCjkCodePoint(codePoint)) run.push(codePoint)
    else flush()
  }
  flush()
  return tokens
}

/**
 * Extract lowercase Latin and numeric words after removing CJK code points.
 * Punctuation and FTS operators are separators rather than query syntax.
 *
 * @param input - untrusted search text.
 * @returns ordinary search words in source order.
 */
export function tokenizeSearchWords(input: string): string[] {
  const withoutCjk = Array.from(input, codePoint => isCjkCodePoint(codePoint) ? ' ' : codePoint).join('')
  return (withoutCjk.match(SEARCH_WORD) ?? []).map(token => token.toLowerCase())
}
