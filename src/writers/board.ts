/** Replace the hand-written Deadline radar table on the Task Board with the live `pa-radar` block. */
export function replaceRadarTable(text: string): string | null {
  const lines = text.split("\n");
  const h = lines.findIndex((l) => /^##\s+.*Deadline radar/i.test(l));
  if (h < 0) return null;
  let end = lines.length;
  for (let i = h + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (lines.slice(h, end).some((l) => /^```pa-radar/.test(l))) return null; // already converted
  const start = lines.findIndex((l, i) => i > h && i < end && l.trim().startsWith("|"));
  if (start < 0) return null;
  let stop = start;
  while (stop < end && lines[stop].trim().startsWith("|")) stop++;
  lines.splice(start, stop - start, "```pa-radar", "```");
  return lines.join("\n");
}
