import { describe, expect, test } from 'vitest'
import { sanitizeNotionMarkdown } from '../src/notion/index.ts'

describe('Notion Markdown sanitization', () => {
  test('removes signed media URLs and dangerous controls but preserves ordinary links', () => {
    const markdown = [
      '[page](https://www.notion.so/Workspace-11111111111111111111111111111111)',
      '![secret](https://prod-files-secure.s3.us-west-2.amazonaws.com/file.png?X-Amz-Signature=abc&X-Amz-Credential=private)',
      '[download](https://example.com/file?token=very-secret&expires=123)',
      'safe\u0000text\u0001\u0008\tkept\nnext\u007fline',
    ].join('\n')

    const result = sanitizeNotionMarkdown(markdown, 10_000)
    expect(result.markdown).toContain('https://www.notion.so/Workspace-11111111111111111111111111111111')
    expect(result.markdown).toContain('[media URL removed]')
    expect(result.markdown).not.toMatch(/X-Amz|Credential|very-secret|[\u0000\u0001\u0008\u007f]/)
    expect(result.markdown).toContain('\tkept\nnextline')
    expect(result.truncated).toBe(false)
  })

  test('truncates by Unicode code point without splitting a surrogate pair', () => {
    expect(sanitizeNotionMarkdown('甲乙😀丙丁', 3)).toEqual({
      markdown: '甲乙😀',
      truncated: true,
    })
  })

  test('keeps provider truncation and unknown blocks as independently recorded facts', () => {
    const complete = sanitizeNotionMarkdown('complete body', 100)
    expect(complete.truncated).toBe(false)
    expect(sanitizeNotionMarkdown('', 100)).toEqual({ markdown: '', truncated: false })
  })

  test('removes a bare signed URL outside Markdown link syntax', () => {
    const result = sanitizeNotionMarkdown(
      'see https://example.com/file?X-Amz-Signature=abc',
      100,
    )
    expect(result.markdown).toBe('see [media URL removed]')
    expect(result.markdown).not.toContain('X-Amz')
  })
})
