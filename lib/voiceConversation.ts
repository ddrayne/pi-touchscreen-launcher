export type VoiceConversationEntry = {
  id: number;
  transcriptId?: string;
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
};

export type VoiceTranscriptUpdate = {
  id?: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
};

function comparableTranscript(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-GB")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
}

export function updateVoiceConversation(
  entries: VoiceConversationEntry[],
  update: VoiceTranscriptUpdate,
  createId = () => Date.now() + Math.floor(Math.random() * 1000),
): VoiceConversationEntry[] {
  const text = update.text.trimStart();
  if (!text.trim()) return entries;
  const next = [...entries];
  let targetIndex = update.id
    ? next.findIndex((entry) => entry.transcriptId === update.id)
    : -1;

  if (targetIndex < 0) {
    for (let index = next.length - 1; index >= 0; index -= 1) {
      const candidate = next[index];
      if (candidate.role === update.role && candidate.streaming) {
        targetIndex = index;
        break;
      }
    }
  }

  if (targetIndex >= 0) {
    const target = next[targetIndex];
    next[targetIndex] = {
      ...target,
      ...(update.id ? { transcriptId: update.id } : {}),
      // A completed transcript is authoritative. Replacing the streamed
      // fragments also repairs duplicate compatibility deltas. Realtime item
      // ids let late input finals merge even after assistant output has begun.
      text: update.final ? text : `${target.text}${text}`,
      streaming: !update.final,
    };
  } else {
    if (update.final) {
      const duplicate = next.findLast(
        (entry) =>
          entry.role === update.role &&
          comparableTranscript(entry.text) === comparableTranscript(text),
      );
      if (duplicate) return entries;
    }
    next.push({
      id: createId(),
      ...(update.id ? { transcriptId: update.id } : {}),
      role: update.role,
      text,
      streaming: !update.final,
    });
  }
  return next.slice(-6);
}
