/** A backend refusal as a sentence: the message as sent, its first letter raised. */
export function refusalText(error: unknown): string {
  const text = String(error);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
