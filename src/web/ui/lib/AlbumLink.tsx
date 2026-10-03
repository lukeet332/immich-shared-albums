/** web/ui/lib/AlbumLink.tsx — an album's name, opening that album in Immich. See design-system.md. */
export const AlbumLink = ({
  albumId,
  name,
  canOpen = true,
  onDenied,
}: {
  albumId?: string;
  name: string;
  /**
   * Whether the person reading may open it. An admin panel lists albums belonging to other people,
   * and Immich refuses `/albums/<id>` for one they are not a member of — so the title stays a link
   * either way and SAYS so when pressed, rather than becoming plain text and giving no sign an
   * album is there at all.
   */
  canOpen?: boolean;
  /** Called instead of following the link. The caller announces it. */
  onDenied?: () => void;
}) =>
  // No id means no link, never a link to nothing: a row whose album the server could not name says
  // so by staying plain text, which is better than a target that lands somewhere arbitrary.
  albumId ? (
    <a
      class="isa-album-link"
      href={`/albums/${albumId}`}
      onClick={event => {
        if (canOpen) return;
        event.preventDefault();
        onDenied?.();
      }}
    >
      {name}
    </a>
  ) : (
    <span class="isa-album-link isa-album-link--plain">{name}</span>
  );
