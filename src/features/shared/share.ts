export type ShareOutcome = 'shared' | 'copied' | 'failed';

interface ShareTextOptions {
  title?: string;
}

export async function shareText(
  text: string,
  options: ShareTextOptions = {},
): Promise<ShareOutcome> {
  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function'
  ) {
    try {
      await navigator.share({ text, title: options.title });
      return 'shared';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return 'shared';
      }
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch {
      return 'failed';
    }
  }

  return 'failed';
}
