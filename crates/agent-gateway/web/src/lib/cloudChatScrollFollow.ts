// Adapted from LibreChat useMessageScrolling.ts at 8d3da9bbb220a0a96be9330a2e1cbd385fb786d5.
// Copyright (c) 2026 LibreChat. MIT; see docs/cloudchat/third-party/LibreChat-LICENSE.txt.
// Keep the policy independent of LibreChat's conversation providers and atom stores.
export function cloudChatScrollFollowing(
  following: boolean,
  previousTop: number,
  top: number,
  distance: number,
): boolean {
  if (previousTop < 0) return following;
  // A growing stream recedes between frames. Arrival and departure need different thresholds.
  if (top >= previousTop) return distance <= 150 ? true : following;
  return distance > 24 ? false : following;
}
