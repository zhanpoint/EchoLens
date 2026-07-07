export function joinTranscriptText(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((content, part) => {
      if (!content) {
        return part;
      }
      return `${content}${needsWordBoundary(content, part) ? " " : "\n"}${part}`;
    }, "");
}

function needsWordBoundary(left: string, right: string): boolean {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
}
