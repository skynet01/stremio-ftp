export function redactSecrets(message: string): string {
  return message
    .replace(/\b(ftps?):\/\/[^@\s]+@/gi, "$1://[redacted]@")
    .replace(/(["']?\b(?:password|passphrase|token)\b["']?\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/(["']?\b(?:password|passphrase|token)\b["']?\s*:\s*)'[^']*'/gi, "$1'[redacted]'")
    .replace(/(["']?\b(?:password|passphrase|token)\b["']?\s*:\s*)(?!["'])[^,\n\r;&}]+/gi, "$1[redacted]")
    .replace(/\b(password|passphrase|token)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted-token]");
}
