"use client";
import { useEffect, useRef, useState } from "react";

/** Seconds remaining until `deadline` (ms epoch). Calls onExpire once when it hits zero. */
export function useCountdown(deadline: number | undefined, onExpire: () => void) {
  const [now, setNow] = useState(() => Date.now());
  const fired = useRef(false);
  const cb = useRef(onExpire);
  cb.current = onExpire;

  useEffect(() => {
    fired.current = false;
    if (!deadline) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [deadline]);

  const remaining = deadline ? Math.max(0, Math.ceil((deadline - Math.max(now, Date.now() - 1000)) / 1000)) : 0;
  useEffect(() => {
    if (deadline && remaining === 0 && !fired.current) {
      fired.current = true;
      cb.current();
    }
  }, [deadline, remaining]);
  return remaining;
}

export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
