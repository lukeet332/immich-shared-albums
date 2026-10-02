/** web/ui/lib/announce.ts — where an action's outcome goes, and for how long. See design-system.md. */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

/** What an action did. Said once, in the snackbar: a row that writes its outcome into its own card
 *  puts the message where the row it describes no longer is — unlinking DELETES the row, so the note
 *  that unlinking worked left the screen with it. */
export type Outcome = { kind: 'ok' | 'error'; text: string };

/** How long a success stays before it fades. A failure stays until dismissed: it is asking for
 *  something. */
const NOTICE_MS = 6000;

/** An outcome with its own identity, so a second message REPLACES the first instead of inheriting
 *  whatever the first happened to be doing on its way out — otherwise a bar mid-swipe takes the
 *  message that replaced it down with it. */
type Announcement = Outcome & { id: number };

export const useAnnouncer = () => {
  const [notice, setNotice] = useState<Announcement | null>(null);
  const announcements = useRef(0);

  const announce = useCallback((outcome: Outcome) => {
    setNotice({ ...outcome, id: announcements.current++ });
  }, []);

  const dismiss = useCallback(() => setNotice(null), []);

  useEffect(() => {
    if (notice?.kind !== 'ok') return;
    const timer = setTimeout(dismiss, NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice, dismiss]);

  return [notice, announce, dismiss] as const;
};
