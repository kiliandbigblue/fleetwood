import { useEffect, useState } from 'react';

/**
 * The wall clock, re-read on an interval.
 *
 * The snapshot already lands every second, but the countdowns must not be drawn
 * from it: `msLeft` is as old as the last push, and the shutdown overlay is on
 * screen precisely when the panel behind it may be closed and nothing is
 * pushing. So the timestamp comes over IPC and the seconds are counted here.
 */
export function useNow(everyMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
