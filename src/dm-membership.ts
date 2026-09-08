/**
 * Optional hard gate for direct messages: the sender must currently belong to
 * at least one configured Telegram group. The check happens before attachment
 * download or model dispatch and fails closed when Telegram cannot verify it.
 */

export function readAccountDmMembershipChats(
  cfg: any,
  accountId: string,
): string[] | undefined {
  const raw = cfg?.channels?.clawgram?.accounts?.[ accountId ]?.dmMembershipChats;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  return [ ...new Set(raw.map((entry: unknown) => String(entry).trim()).filter(Boolean)) ];
}

export async function senderSharesConfiguredChat(params: {
  senderId: string;
  chats: readonly string[];
  isParticipant: (chatId: string, senderId: string) => Promise<boolean>;
  onLookupError?: (info: { chatId: string; error: string }) => void;
}): Promise<boolean> {
  for (const chatId of params.chats) {
    try {
      if (await params.isParticipant(chatId, params.senderId)) {
        return true;
      }
    } catch (error) {
      params.onLookupError?.({
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return false;
}
