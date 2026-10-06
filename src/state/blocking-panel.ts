export function isBlockingPanelContext(context?: string): boolean {
  return context === 'charsheet' || context === 'realminv';
}
